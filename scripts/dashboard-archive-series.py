#!/usr/bin/env python3
"""Dashboard & message archive time series (#328 — coordination-volume study).

Makes the RooSync coordination record itself countable: walks the dashboard
condensation archives (+ live dashboards) and the inter-machine message store
under the RooSync shared-state directory, extracts ONE JSONL line per message
with metadata only (never content), and summarizes per-day series / tag mix /
era deltas.

Discipline (same as turn-autopsy.py, #328 G-series):
- Never store or print message CONTENT — lengths and first-tag only. The
  stores hold internal coordination prose which may quote sensitive material.
- Every instrument limit is reported, not hidden: files whose parsed message
  count disagrees with the archive frontmatter are counted, near-duplicate
  messages (fallback archives can re-emit a span) are deduped on
  (ts, author, len) and the dedup rate reported, and days with zero files are
  distinguished from days outside the corpus.
- ⚠ The message store counts each DM once PER MAILBOX: the same message lives
  in the sender's `sent/`, the recipient's `inbox/` and later `archive/`, plus
  literal ` (1).json` copies. Measured 2026-10-09: 78 115 records → 36 551
  unique messages (−53 %). `summarize` dedups DMs on
  (ts, from, to, subject_len, body_len) — only the deduped count is truth.

Usage:
  python scripts/dashboard-archive-series.py collect --store <shared-state> --out series.jsonl
      [--dashboards-only | --messages-only] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
  python scripts/dashboard-archive-series.py summarize --series series.jsonl \
      --era-a 2026-07-01:2026-07-31 --era-b 2026-10-02:2026-10-09

`collect` reads every `dashboards/archive/*.md`, every live `dashboards/*.md`
and (unless --dashboards-only) every JSON under `messages/{inbox,sent,archive}`.
File-name date filtering applies to dashboard ARCHIVES only (--since/--until);
message JSONs are filtered by their own timestamp field.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

MSG_HEADER_RE = re.compile(
    r"^### \[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\] "
    r"([A-Za-z0-9_.\-]+)\|([A-Za-z0-9_./:\- ]*?)\s*$",
    re.MULTILINE,
)
FRONTMATTER_COUNT_RE = re.compile(r"^messageCount: (\d+)", re.MULTILINE)
# First bracketed token near the start of a message ("[DONE]", "[REPLY]",
# "[INFO/WARN]", "[WARN][WATCHDOG]", "[CLUSTER-HEALTH] T#163"…). System
# condensation messages (**CONDENSATION-SUMMARY** …) carry NO bracketed token,
# so their tag is "" — exclusion is by author (machine == "system"), never by
# tag (review #426, bloquant 1).
TAG_TOKEN_RE = re.compile(r"\[([A-Z][A-Z0-9 ./#-]{1,30}?)\]")
ARCHIVE_NAME_RE = re.compile(r"^(.*)-(\d{4})-(\d{2})-(\d{2})T")


def parse_ts(raw: str):
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def first_tag(content: str) -> str:
    head = content[:300]
    m = TAG_TOKEN_RE.search(head)
    if not m:
        return ""
    tag = m.group(1).strip()
    # Keep the informative compound forms but cap length.
    return tag[:32]


def iter_dashboard_file(path: str, key: str, source: str):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError as e:
        yield {"error": f"read:{e.errno}", "file": os.path.basename(path)}
        return
    expected = None
    m = FRONTMATTER_COUNT_RE.search(text[:600])
    if m:
        expected = int(m.group(1))
    matches = list(MSG_HEADER_RE.finditer(text))
    parsed = 0
    for i, hm in enumerate(matches):
        ts = parse_ts(hm.group(1))
        start = hm.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        content = text[start:end]
        parsed += 1
        yield {
            "kind": "dash",
            "key": key,
            "src": source,
            "file": os.path.basename(path),
            "ts": ts.isoformat() if ts else hm.group(1),
            "ts_ok": ts is not None,
            "machine": hm.group(2),
            "ws": hm.group(3),
            "tag": first_tag(content),
            "len": len(content.strip()),
        }
    if expected is not None and expected != parsed and len(text) > 0:
        yield {
            "error": "count-mismatch",
            "file": os.path.basename(path),
            "expected": expected,
            "parsed": parsed,
        }


def collect(args):
    dash_dir = os.path.join(args.store, "dashboards")
    arch_dir = os.path.join(dash_dir, "archive")
    n_files = n_msgs = n_mismatch = n_read_err = 0
    since = until = None
    if args.since:
        since = datetime.fromisoformat(args.since).date()
    if args.until:
        until = datetime.fromisoformat(args.until).date()

    out = open(args.out, "w", encoding="utf-8")
    if not args.messages_only:
        # Live dashboards (never date-filtered: they hold the newest messages).
        try:
            live = [
                fn
                for fn in os.listdir(dash_dir)
                if fn.endswith(".md")
                and fn.startswith(("workspace-", "global.", "machine-"))
            ]
        except OSError:
            live = []
        for fn in live:
            key = fn[:-3]
            for rec in iter_dashboard_file(os.path.join(dash_dir, fn), key, "live"):
                if "error" in rec:
                    n_mismatch += rec["error"] == "count-mismatch"
                    n_read_err += rec["error"].startswith("read:")
                    continue
                out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                n_msgs += 1
            n_files += 1
        # Archives (date-filtered by FILE name when --since/--until given; the
        # message ts filter happens at summarize time — a bucket dated Aug 10
        # can legitimately hold July messages).
        try:
            arch = [fn for fn in os.listdir(arch_dir) if fn.endswith(".md")]
        except OSError:
            arch = []
        for fn in arch:
            if since or until:
                m = ARCHIVE_NAME_RE.match(fn[:-3])
                if m:
                    d = datetime(int(m.group(2)), int(m.group(3)), int(m.group(4))).date()
                    if since and d < since:
                        continue
                    if until and d > until:
                        continue
            key = ARCHIVE_NAME_RE.match(fn[:-3])
            key = key.group(1) if key else fn[:-3]
            for rec in iter_dashboard_file(os.path.join(arch_dir, fn), key, "archive"):
                if "error" in rec:
                    n_mismatch += rec["error"] == "count-mismatch"
                    n_read_err += rec["error"].startswith("read:")
                    continue
                out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                n_msgs += 1
            n_files += 1
            if n_files % 500 == 0:
                print(f"[dash] {n_files} files, {n_msgs} msgs", file=sys.stderr, flush=True)

    n_dm = 0
    if not args.dashboards_only:
        msg_root = os.path.join(args.store, "messages")
        for store in ("inbox", "sent", "archive"):
            d = os.path.join(msg_root, store)
            if not os.path.isdir(d):
                continue
            for fn in os.listdir(d):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(d, fn), encoding="utf-8", errors="replace") as f:
                        rec = json.load(f)
                except (OSError, ValueError):
                    n_read_err += 1
                    continue
                ts = rec.get("timestamp") or rec.get("sentAt") or rec.get("date")
                ts_ok = bool(ts)
                if ts_ok:
                    dt = parse_ts(str(ts))
                    if dt is None:
                        ts_ok = False
                    else:
                        ts = dt.isoformat()
                if ts_ok and since and dt.date() < since:
                    continue
                if ts_ok and until and dt.date() > until:
                    continue
                out.write(
                    json.dumps(
                        {
                            "kind": "dm",
                            "store": store,
                            "ts": ts,
                            "ts_ok": ts_ok,
                            "from": str(rec.get("from", ""))[:80],
                            "to": str(rec.get("to", ""))[:80],
                            "priority": str(rec.get("priority", "")),
                            "subject_len": len(str(rec.get("subject", ""))),
                            "body_len": len(str(rec.get("body", ""))),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                n_dm += 1
                if n_dm % 2000 == 0:
                    print(f"[dm:{store}] {n_dm}", file=sys.stderr, flush=True)
    out.close()
    print(
        json.dumps(
            {
                "dashboard_files": n_files,
                "dashboard_messages": n_msgs,
                "dm_messages": n_dm,
                "count_mismatches": n_mismatch,
                "read_errors": n_read_err,
            }
        )
    )


def summarize(args):
    a_start, a_end = args.era_a.split(":")
    b_start, b_end = args.era_b.split(":")
    rows = []
    seen_full = set()  # (key, ts, machine, ws, len) — re-emission WITHIN one dashboard
    seen_unique = set()  # (ts, machine, ws, len) — the same message cross-posted elsewhere
    dm_seen = set()
    dup_by_day = Counter()  # near-duplicate re-emissions, bucketed for per-era counts
    dm_dup = 0
    with open(args.series, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if not r.get("ts_ok"):
                continue
            if r["kind"] == "dash":
                # Bloquant 2 (review #426): per-dashboard attribution must not
                # depend on file order. Dedup re-emissions WITHIN a dashboard
                # (same key), but KEEP one record per dashboard a message was
                # actually posted to (cross-post, the escalation norm since
                # 06/09) — flagged so unique counts stay unique and the
                # cross-post volume is reportable per era.
                k_unique = (r["ts"], r["machine"], r["ws"], r["len"])
                k_full = (r["key"],) + k_unique
                if k_full in seen_full:
                    dup_by_day[r["ts"][:10]] += 1
                    continue
                seen_full.add(k_full)
                if k_unique in seen_unique:
                    r = dict(r, cross=1)
                else:
                    seen_unique.add(k_unique)
                rows.append(r)
            else:
                # One DM per mailbox copy (sent + inbox + archive + " (1)"
                # clones) — see the docstring trap. Only unique messages count.
                k = (r["ts"], r["from"], r["to"], r["subject_len"], r["body_len"])
                if k in dm_seen:
                    dm_dup += 1
                    continue
                dm_seen.add(k)
                rows.append(r)

    def in_era(ts, s, e):
        return s <= ts[:10] <= e

    def days(s, e):
        return (
            datetime.fromisoformat(e) - datetime.fromisoformat(s)
        ).days + 1

    panel = None
    if args.panel:
        with open(args.panel, encoding="utf-8") as f:
            panel = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]

    stats = {}
    for name, s, e in (("A", a_start, a_end), ("B", b_start, b_end)):
        # Bloquant 1 (review #426): system/condensation messages are excluded
        # by AUTHOR (machine == "system"). Their **CONDENSATION** header
        # carries no bracketed token, so the old tag-based filter matched
        # nothing — and October (92% auto-condensation, 2 system msgs per
        # event) was inflated asymmetrically vs July.
        era = [
            r
            for r in rows
            if in_era(r["ts"], s, e)
            and not (r["kind"] == "dash" and r["machine"] == "system")
        ]
        dash = [r for r in era if r["kind"] == "dash"]
        dm = [r for r in era if r["kind"] == "dm"]
        cross_era = sum(1 for r in dash if r.get("cross"))
        dup_era = sum(v for d, v in dup_by_day.items() if s <= d <= e)
        n = days(s, e)
        stats[name] = {
            "dash": dash,
            "dm": dm,
            "cross": cross_era,
            "per_key": Counter(r["key"] for r in dash),
            "n": n,
            "s": s,
            "e": e,
        }
        tags = Counter(t for t in (r["tag"] for r in dash) if t)
        per_key = stats[name]["per_key"]
        per_day_dash = Counter(r["ts"][:10] for r in dash)
        per_day_dm = Counter(r["ts"][:10] for r in dm)
        authors = Counter(f'{r["machine"]}|{r["ws"]}' for r in dash)
        lens = sorted(r["len"] for r in dash)
        med = lens[len(lens) // 2] if lens else 0
        print(f"\n===== ERA {name}: {s} → {e} ({n} days) =====")
        print(
            f"dashboard messages: {len(dash)} ({len(dash)/n:.1f}/day) | "
            f"unique (cross-posts collapsed): {len(dash)-cross_era} | cross-posts: {cross_era} | "
            f"DMs: {len(dm)} ({len(dm)/n:.1f}/day) | near-duplicate re-emissions in era: {dup_era}"
        )
        if panel:
            pn = sum(c for k, c in per_key.items() if k in panel)
            print(f"panel ({len(panel)} keys): {pn} msgs ({pn/n:.1f}/day)")
        print(f"dashboard msg length: median {med} ch, p90 {lens[int(len(lens)*0.9)] if lens else 0} ch, total {sum(lens)} ch")
        print("days with zero dashboard msgs (inside era): ", end="")
        all_days = []
        d0 = datetime.fromisoformat(s)
        for i in range(n):
            all_days.append(d0.strftime("%Y-%m-%d"))
            d0 += timedelta(days=1)
        zero = [d for d in all_days if per_day_dash.get(d, 0) == 0]
        print(f"{len(zero)} {zero[:8]}")
        print("top tags:", tags.most_common(12))
        print("top dashboards:", per_key.most_common(10))
        print("top authors:", authors.most_common(8))
        print("per-day dash:", dict(sorted(per_day_dash.items())))
        print("per-day dm:", dict(sorted(per_day_dm.items())))
        # System condensation messages excluded above; count them separately
        # as an instrument-noise indicator.
        cond = sum(
            1
            for r in rows
            if in_era(r["ts"], s, e)
            and r["kind"] == "dash"
            and r["machine"] == "system"
        )
        print(f"(system/condensation msgs in era, excluded from counts: {cond})")
    print(f"\nnear-duplicates deduped overall: {sum(dup_by_day.values())} dashboard, {dm_dup} DM mailbox copies")
    if args.panel_auto:
        common = sorted(
            set(stats["A"]["per_key"]) & set(stats["B"]["per_key"])
        )
        a_msgs = sum(stats["A"]["per_key"][k] for k in common)
        b_msgs = sum(stats["B"]["per_key"][k] for k in common)
        print(f"\n--panel-auto: {len(common)} keys present in BOTH eras "
              f"(A {a_msgs} msgs, B {b_msgs}) — freeze this list into a --panel file:")
        for k in common:
            print(f"  {k}")


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--store", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--since")
    c.add_argument("--until")
    c.add_argument("--dashboards-only", action="store_true")
    c.add_argument("--messages-only", action="store_true")
    c.set_defaults(func=collect)
    s = sub.add_parser("summarize")
    s.add_argument("--series", required=True)
    s.add_argument("--era-a", required=True, help="YYYY-MM-DD:YYYY-MM-DD")
    s.add_argument("--era-b", required=True, help="YYYY-MM-DD:YYYY-MM-DD")
    s.add_argument("--panel", help="file with one dashboard key per line — a FIXED "
                                   "same-key panel, so per-era ratios are reproducible")
    s.add_argument("--panel-auto", action="store_true",
                   help="print the keys present in BOTH eras (paste into a --panel file)")
    s.set_defaults(func=summarize)
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
