#!/usr/bin/env python3
r"""Attribute captured requests to a working directory, from the request body alone.

Enquiry #328 (grain M1) / epic #445. The fleet reports "responses per merged PR",
a ratio whose numerator is counted per REQUEST and whose denominator is counted
per REPOSITORY. Nothing supplied the missing axis on the numerator side. This
instrument does, using only what a captured `req-*` body already carries: Claude
Code writes its environment preamble into every prompt, and the first line of it
names the working directory.

Marker contract (measured 2026-11-03 on capture archives 2026-07-27 .. 09-07):

    Primary working directory: d:\\dev\\CoursIA
    - Is a git repository: true
    - Platform: win32

and, in the SAME field from ~2026-09-08, the previous directory too:

    Primary working directory: d:\\dev\\CoursIA (was c:\\dev\\CoursIA)

⚠ TRAP 1 — the ` (was …)` suffix. Splitting the line on the separator before
dropping that suffix yields `coursia)` as a workspace key. Measured on ONE day of
the 2026-09-07 week (300 sampled bodies): 38 landed in `coursia)`, 33 in
`coursia-2)`, 13 in `roo-extensions)` — the naive parse splits every workspace in
two and halves the main bucket. Pin: `test_previous_directory_suffix`.

⚠ TRAP 2 — a path segment ENDING IN the letter `n`. In the JSON-escaped body a
literal backslash is `\\`, and the preamble's newline is `\n`; a naive
`find("\\n")` therefore cuts at the first backslash of `d:\\dev\\new`, i.e. at
`d:` — which is how a `d:` workspace bucket with hundreds of responses/day
appeared in the first run of this analysis. Unescape the double backslashes
BEFORE turning `\n` into a newline. Pin: `test_path_segment_ending_in_n`.

⚠ TRAP 3 — a body can carry many markers (a transcript quoted inside a
tool_result, a compaction summary). The LAST one is the request's own directory:
bodies are appended to, never rewritten. Pin: `test_last_marker_wins`.

A body with NO marker is not "unknown": the preamble is emitted by Claude Code, so
its absence means the request did not come from a Claude Code client at all — an
MCP server, a script, another agent. It is bucketed `(non-cc)` and kept in the
denominator under its own name, never dropped: that population can never produce
a PR, and hiding it is what makes a per-PR ratio look like a regression.

Sampling is a stride over each period's request names, not a head slice: a head
slice of an archive follows one hour of one machine. The estimate assumes the
stride sample is representative of the period — it is an ESTIMATE, and the tool
says so in its own output.

Usage:
    python scripts/capture-workspace-attribution.py --week 2026-09-07
    python scripts/capture-workspace-attribution.py --from 2026-07-27 --to 2026-09-07
    python scripts/capture-workspace-attribution.py --day 2026-09-08 --sample 300 --json out.json
    python scripts/capture-workspace-attribution.py --week 2026-09-07 --census census-days.jsonl
    python scripts/capture-workspace-attribution.py --from 2026-10-27 --to 2026-11-03 --tours --json tours.json

`--tours` adds the tour-level series (enquiry #328 / epic #445, extension M1): per
day x workspace, (tours, in_tokens, out_tokens), where a TOUR is a distinct
`session_id` from the capture envelope's `metadata.user_id` — the unit a PR is
produced by, so tours/PR and tokens/PR become computable. Tokens come from the
response capture paired by request number (`req-1-<N>-…` <-> `resp-1-r<N>-…`,
same instance counter; a recreate resets it, which is why the pairing never
crosses a day boundary).

Estimation contract: token sums scale LINEARLY with the stride sample (each
sampled request stands for `1/fraction`), but a DISTINCT-session count does not
scale at all — a stride catches a long session whole and a short one rarely.
The honest statement is a BOUND: the true tour count sits in
`tours <= T <= tours / fraction`. The lower end is tight when sessions are long
relative to `1/fraction` (a work tour is hundreds of requests; at the default
--sample 400 over ~50k requests/day, f*L >> 1 and the sample's distinct count
IS the answer); the upper end is what a purely short-session population would
justify. Dividing by the fraction and calling it an estimate was the first
draft's error — it inflated a 7-session day to ~978.
"""

import argparse
import collections
import importlib.util
import json
import os
import re
import sys
from datetime import date, timedelta

MARKER = b"Primary working directory:"
WINDOW = 400
PREVIOUS = re.compile(r"\s+\((?:was|previously)\b[^)]*\)", re.IGNORECASE)
ABSOLUTE = re.compile(r"^(?:[A-Za-z]:[\\/]|[/\\])")
REQ = re.compile(r"req-\d+-\d+-\d{4}-\d{2}-\d{2}T[\d-]+Z-.+\.json$")
REQNO = re.compile(r"^req-(\d+)-(\d+)-")          # req-<shard>-<N>-…  (N as written)
SESSION_JSON = re.compile(rb'"session_id"\s*:\s*"([0-9a-fA-F-]{8,})"')
SESSION_FLAT = re.compile(rb"_session_([0-9a-f-]{8,})")
NON_CC = "(non-cc)"
UNPARSED = "(unparsed)"
ROOT = "(root)"
NO_SESSION = "(no-session)"
DEFAULT_DIRS = (r"D:\claudish-captures\archive", r"G:\Mon Drive\Backups-Cloud\claudish")


def marker_line(body: bytes) -> str | None:
    """The workspace line of the LAST environment preamble in the body, unescaped."""
    idx = body.rfind(MARKER)
    if idx < 0:
        return None
    chunk = body[idx + len(MARKER): idx + len(MARKER) + WINDOW].decode("utf-8", "replace")
    chunk = chunk.replace("\\\\", "\x00")          # a literal path separator
    chunk = chunk.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"')
    chunk = chunk.replace("\x00", "\\")
    line = chunk.split("\n", 1)[0].split('"', 1)[0]
    return line.strip().rstrip("\\").strip()


def workspace_key(body: bytes) -> tuple[str, bool]:
    """(workspace key, came_from_claude_code)."""
    line = marker_line(body)
    if line is None:
        return NON_CC, False
    path = PREVIOUS.sub("", line).strip()
    if not ABSOLUTE.match(path):
        # The marker also appears inside quoted CODE (a script or a prompt that
        # discusses this very string). Such a hit is not a directory: bucket it
        # visibly instead of minting a workspace out of a fragment of source.
        return UNPARSED, True
    path = path.replace("\\", "/").rstrip("/")
    leaf = path.split("/")[-1].strip() if path else ""
    # No generic trailing-punctuation strip: a workspace may legitimately end in
    # `)`. An unknown rendering must show up in the table as itself, not be
    # silently folded into a neighbouring bucket.
    return (leaf.lower() or ROOT), True


def session_key(raw: bytes) -> str | None:
    """The request's session id, from `metadata.user_id` — or None.

    A capture file is an ENVELOPE (`{"body": {…the request…}}`); before the
    envelope existed the file was the bare body, so both shapes are read. The
    user_id is either a JSON string (Claude Code >= 2.1: `{"device_id":…,
    "session_id":…}`) or the flat `user_<hash>_account_<uuid>_session_<uuid>`.
    A body without metadata is NOT an error: non-CC traffic has none, and a
    missing session stays `None` rather than a fake bucket.
    """
    payload = None
    try:
        env = json.loads(raw)
        if isinstance(env, dict):
            payload = env.get("body") if isinstance(env.get("body"), dict) else env
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        uid = (payload.get("metadata") or {}).get("user_id")
        if isinstance(uid, str):
            if uid.lstrip().startswith("{"):
                try:
                    sid = (json.loads(uid) or {}).get("session_id")
                    if isinstance(sid, str) and sid:
                        return sid
                except ValueError:
                    pass
            m = re.search(r"_session_([0-9a-f-]{8,})", uid)
            if m:
                return m.group(1)
            return None
    # Envelope unparseable or metadata absent: last-ditch scan. Quoted session
    # ids inside transcript content are a real hazard (the marker's TRAP 3),
    # which is why this path only runs when the structured read found nothing.
    m = SESSION_JSON.search(raw) or SESSION_FLAT.search(raw)
    return m.group(1).decode("ascii", "replace") if m else None


def resp_prefix_for(req_name: str) -> str | None:
    """`req-1-0001-<ts>-tag.json` -> `resp-1-r0001-` (prefix, ts differs).

    The request number is kept AS WRITTEN (zero-padded on older builds, natural
    today) — the response file writes the same rendering.
    """
    m = REQNO.match(req_name)
    if not m:
        return None
    return f"resp-{m.group(1)}-r{m.group(2)}-"


def usage_max(usage: dict) -> tuple[int, int]:
    """(input, output) of a usage object, nesting-aware. Max, never summed:
    `message_start` carries the real input, the terminal delta the output —
    summing frames would multiply input by frame count (#179)."""
    i = usage.get("input_tokens")
    if not i and isinstance(usage.get("input_tokens_details"), dict):
        i = usage["input_tokens_details"].get("input_tokens")
    return int(i or 0), int(usage.get("output_tokens") or 0)


def usage_from_resp(path: str) -> tuple[int, int] | None:
    """(input, output) tokens from a response capture — .sse or .json.

    None when the file carries no usage at all (kept out of token sums but
    still counted as a response for the tour/req axes)."""
    tin = tout = 0
    try:
        if path.endswith(".json"):
            with open(path, "rb") as f:
                obj = json.load(f)
            for u in (obj.get("usage"), (obj.get("message") or {}).get("usage")):
                if isinstance(u, dict):
                    i, o = usage_max(u)
                    tin, tout = max(tin, i), max(tout, o)
            return (tin, tout) if (tin or tout) else None
        with open(path, "rb") as f:
            for raw in f:
                if not raw.startswith(b"data:"):
                    continue
                try:
                    obj = json.loads(raw[5:].strip())
                except ValueError:
                    continue
                u = obj.get("usage") or (obj.get("message") or {}).get("usage")
                if isinstance(u, dict):
                    i, o = usage_max(u)
                    tin, tout = max(tin, i), max(tout, o)
        return (tin, tout) if (tin or tout) else None
    except OSError:
        return None


def archive_for(day: str, dirs) -> str | None:
    for d in dirs:
        p = os.path.join(d, f"captures-{day}.7z")
        if os.path.isfile(p):
            return p
    return None


def request_names(path: str) -> list[str]:
    import py7zr

    with py7zr.SevenZipFile(path) as z:
        return sorted(n for n in z.getnames() if REQ.search(os.path.basename(n)))


def sample_period(days: list[str], dirs, per_period: int) -> tuple[dict[str, list[str]], list[str], dict[str, int]]:
    """Stride-sample request names across a period.

    Returns (by_day_picked, missing_days, totals_by_day) — the totals feed the
    tour estimator's sample fraction (`--tours`): the stride sample stands for
    `total/sampled` requests, and only that ratio makes token sums scalable.
    """
    by_day: dict[str, list[str]] = {}
    missing: list[str] = []
    for day in days:
        p = archive_for(day, dirs)
        if not p:
            missing.append(day)
            by_day[day] = []
            continue
        by_day[day] = request_names(p)
    totals = {d: len(v) for d, v in by_day.items()}
    total = sum(totals.values())
    if total == 0:
        return {d: [] for d in by_day}, missing, totals
    stride = max(total // per_period, 1)
    picked: dict[str, list[str]] = {d: [] for d in by_day}
    i = 0
    flat = [(d, n) for d, names in by_day.items() for n in names]
    while i < len(flat):
        d, n = flat[i]
        picked[d].append(n)
        i += stride
    return picked, missing, totals


def read_bodies(day: str, names: list[str], dirs, scratch: str) -> list[bytes]:
    path = archive_for(day, dirs)
    if not path or not names:
        return []
    import py7zr

    out: list[bytes] = []
    with py7zr.SevenZipFile(path) as z:
        available = set(z.getnames())
        targets = [n for n in names if n in available]
        if not targets:
            return []
        z.extract(targets=targets, path=scratch)
    for n in targets:
        fp = os.path.join(scratch, n)
        if os.path.isfile(fp):
            with open(fp, "rb") as f:
                out.append(f.read())
            os.remove(fp)
    return out


def read_tour_rows(day: str, names: list[str], dirs, scratch: str) -> list[dict]:
    """One row per sampled request: workspace, session, tokens, pairing state.

    Response captures are paired by request number INSIDE the same archive —
    the instance counter resets at a container recreate, so a same-number pair
    never crosses an archive (day) boundary in practice; a missing resp is
    reported as `no_resp`, not guessed from a neighbour.
    """
    path = archive_for(day, dirs)
    if not path or not names:
        return []
    import py7zr

    rows: list[dict] = []
    with py7zr.SevenZipFile(path) as z:
        available = {os.path.basename(n): n for n in z.getnames()}
        # one pass over the archive index: {resp prefix -> archive path}
        resp_index: dict[str, str] = {}
        for base in available:
            m = re.match(r"^(resp-\d+-r\d+-)", base)
            if m:
                resp_index.setdefault(m.group(1), available[base])
        targets = [available[n] for n in names if n in available]
        resp_targets = []
        for n in targets:
            pref = resp_prefix_for(os.path.basename(n))
            if pref and pref in resp_index:
                resp_targets.append(resp_index[pref])
        if not targets:
            return []
        z.extract(targets=targets + resp_targets, path=scratch)

    # index what extraction actually wrote, by basename — archive members may
    # carry an internal directory prefix the scratch tree recreates.
    on_disk: dict[str, str] = {}
    for root, _dirs, files in os.walk(scratch):
        for fn in files:
            on_disk.setdefault(fn, os.path.join(root, fn))

    def take(path: str | None) -> bytes | None:
        if not path or not os.path.isfile(path):
            return None
        with open(path, "rb") as f:
            raw = f.read()
        os.remove(path)
        del on_disk[os.path.basename(path)]
        return raw

    req_paths = {os.path.basename(n): on_disk.get(os.path.basename(n)) for n in names}
    for name in names:
        base = os.path.basename(name)
        raw = take(req_paths.get(base))
        if raw is None:
            continue
        key, _cc = workspace_key(raw)
        row = {"ws": key, "session": session_key(raw), "in": 0, "out": 0, "paired": False}
        pref = resp_prefix_for(base)
        if pref:
            for cand_base in list(on_disk):
                if cand_base.startswith(pref):
                    usage = usage_from_resp(on_disk[cand_base])
                    if usage is not None:
                        row["in"], row["out"] = usage
                        row["paired"] = True
                    take(on_disk[cand_base])
                    break
        rows.append(row)
    # sweep anything extraction left behind (aborted pairs, orphans)
    for path in list(on_disk.values()):
        if os.path.isfile(path):
            os.remove(path)
    return rows


def aggregate_tours(rows: list[dict], fraction: float | None) -> dict:
    """Rows -> per-workspace {reqs, tours, in, out} (+ bounds when fraction known).

    `tours` counts DISTINCT session ids per workspace — a session spanning three
    days is one tour on each of them (the series is per-day activity, which is
    what a per-day PR count joins against). Rows without a session id keep
    their workspace row but land in `no_session`, never in a fake session.
    The tour count is reported as a BOUND: `tours` is the floor (what the
    sample saw) and `tours_hi = tours / fraction` the ceiling a purely
    short-session population would justify — neither is an estimate, because
    distinct counts do not scale with the sample fraction the way token sums
    do (long sessions are caught whole, inflating a naive division ~f*L-fold).
    """
    per: dict[str, dict] = {}
    no_session = 0
    for r in rows:
        w = per.setdefault(r["ws"], {"reqs": 0, "sessions": set(), "in": 0, "out": 0, "paired": 0})
        w["reqs"] += 1
        if r["session"]:
            w["sessions"].add(r["session"])
        else:
            no_session += 1
        w["in"] += r["in"]
        w["out"] += r["out"]
        w["paired"] += 1 if r["paired"] else 0
    out: dict[str, dict] = {}
    for k, v in per.items():
        entry = {"reqs": v["reqs"], "tours": len(v["sessions"]),
                 "in_tok": v["in"], "out_tok": v["out"], "paired": v["paired"]}
        if fraction and fraction > 0:
            entry["tours_hi"] = round(len(v["sessions"]) / fraction)
            entry["est_in_tok"] = round(v["in"] / fraction)
            entry["est_out_tok"] = round(v["out"] / fraction)
        out[k] = entry
    return {"workspaces": out, "no_session": no_session}


def load_census(path: str) -> dict[str, int]:
    """{day: responses} from a jsonl of {"day","resp"} rows."""
    census: dict[str, int] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            census[row["day"]] = row.get("resp", 0)
    return census


def periods(start: date, end: date, weekly: bool) -> list[list[str]]:
    out: list[list[str]] = []
    cur = start
    step = 7 if weekly else 1
    while cur <= end:
        out.append([(cur + timedelta(days=k)).isoformat() for k in range(step)])
        cur += timedelta(days=step)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--day")
    ap.add_argument("--week", help="any day of the week to measure (Monday-based)")
    ap.add_argument("--from", dest="start")
    ap.add_argument("--to", dest="end")
    ap.add_argument("--sample", type=int, default=400, help="request bodies per period (default 400)")
    ap.add_argument("--tours", action="store_true",
                    help="tour-level series: per day x workspace (tours, in_tokens, out_tokens)")
    ap.add_argument("--archives-dir", action="append", default=None)
    ap.add_argument("--census", help="jsonl of {day, resp} to scale counts into responses/day")
    ap.add_argument("--json", help="write the full result here")
    ap.add_argument("--scratch", default=None, help="extraction directory (default: system temp)")
    args = ap.parse_args(argv)

    dirs = tuple(args.archives_dir or DEFAULT_DIRS)
    if args.day:
        d = date.fromisoformat(args.day)
        periods_list = periods(d, d, weekly=False)
    elif args.week:
        d = date.fromisoformat(args.week)
        monday = d - timedelta(days=d.weekday())
        periods_list = periods(monday, monday + timedelta(days=6), weekly=True)
    elif args.start:
        s = date.fromisoformat(args.start)
        e = date.fromisoformat(args.end or args.start)
        periods_list = periods(s, e, weekly=s.weekday() == 0)
    else:
        ap.error("one of --day / --week / --from is required")

    census = load_census(args.census) if args.census else {}
    scratch = args.scratch or os.path.join(os.getcwd(), ".tmp", "ws-attribution")
    os.makedirs(scratch, exist_ok=True)

    results = {}
    for days in periods_list:
        label = days[0]
        picked, missing, totals = sample_period(days, dirs, args.sample)
        if args.tours:
            rows: list[dict] = []
            for day, names in picked.items():
                rows.extend(read_tour_rows(day, names, dirs, scratch))
            period_total = sum(totals.values())
            fraction = (len(rows) / period_total) if period_total else None
            agg = aggregate_tours(rows, fraction)
            results[label] = {"period": label, "days": days, "sampled": len(rows),
                              "req_total": period_total, "missing_days": missing, **agg}
            pct = f" ({100 * fraction:.2f}%)" if fraction else ""
            print(f"{label}  sampled={len(rows)}/{period_total}{pct}  no_session={agg['no_session']}"
                  + (f"  missing={','.join(missing)}" if missing else ""), flush=True)
            for k, v in sorted(agg["workspaces"].items(), key=lambda kv: -kv[1]["reqs"])[:12]:
                est = (f"  tours bound {v['tours']}..{v['tours_hi']}  ~in {v['est_in_tok']}  ~out {v['est_out_tok']}"
                       if "tours_hi" in v else "")
                print(f"    {k:<32} reqs={v['reqs']:>4}  tours={v['tours']:>3}"
                      f"  in={v['in_tok']}  out={v['out_tok']}  paired={v['paired']}{est}", flush=True)
            continue
        counts: collections.Counter = collections.Counter()
        n = 0
        for day, names in picked.items():
            for body in read_bodies(day, names, dirs, scratch):
                key, _cc = workspace_key(body)
                counts[key] += 1
                n += 1
        rows = {k: v for k, v in counts.most_common()}
        entry = {"period": label, "days": days, "sampled": n, "workspaces": rows, "missing_days": missing}
        seen = [d for d in days if census.get(d)]
        if census and seen:
            total = sum(census[d] for d in seen)
            entry["resp_in_period"] = total
            entry["days_with_census"] = len(seen)
            entry["resp_per_day"] = total / len(seen)
            entry["est_resp_per_day"] = {
                k: (v / max(n, 1)) * entry["resp_per_day"] for k, v in rows.items()
            }
        results[label] = entry

        print(f"{label}  sampled={n}  days={len(days)}"
              + (f"  missing={','.join(missing)}" if missing else ""), flush=True)
        for k, v in list(rows.items())[:12]:
            share = 100 * v / max(n, 1)
            line = f"    {k:<40} {v:>5}  {share:5.1f}%"
            if "est_resp_per_day" in entry:
                line += f"   ~{entry['est_resp_per_day'][k]:8.0f} resp/d"
            print(line, flush=True)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=1)
        print(f"\nwrote {args.json}")
    if not args.census:
        print("\nNOTE: counts are raw samples; pass --census to scale them to responses/day.")
    if args.tours:
        print("NOTE: `tours` = distinct session ids in the SAMPLE (the floor); the true count sits"
              " in `tours .. tours_hi` — long sessions make the floor tight, a naive division"
              " makes the ceiling, and neither is an estimate.")
    print("NOTE: stride sample — an estimate, not a census. `(non-cc)` = no Claude Code preamble.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
