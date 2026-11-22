#!/usr/bin/env python3
"""prefix-shared-len.py — redundancy between consecutive requests of a
session (#640 repli; reconnaissance for #1152 option (b)).

The hub writes one req-*.json per request and each carries the WHOLE
conversation (#1152). Three measurements per consecutive pair:

  raw    — longest common byte prefix of the WHOLE files. Fixed by the
           format: the envelope opens with {"ts": "..."} and two requests
           diverge at the seconds digit BY CONSTRUCTION, so this column is
           ~21-25 B whatever the conversation holds. Kept as the baseline
           that proves a raw-file prefix store dedupes ~nothing (review
           #1153 point 2).
  body   — LCP computed from each file's own `"body"` offset (the bytes
           after the envelope). This is where the conversation lives: the
           number a content-addressed prefix store would actually recover.
  msgs   — count of IDENTICAL leading messages[] entries between the two
           requests, plus their serialized bytes (canonical form:
           sort_keys, tight separators — a stable proxy, not the raw
           serialization).

Read profile: session grouping needs `metadata.user_id`, which lives in the
BODY (up to ~300 KB in, measured by billed-attrib.py:140); the instrument
reads the sampled files fully. --limit is capped at 500 (memory: each file
is held in memory, ~0.5 MB each -> 500 x 0.5 MB = ~250 MB) — a
whole-corpus census would need the 05-07Z trough window, not this.

Sampling order: NEWEST FIRST by the ts group of the FILENAME
(`req-<pid>-<counter>-<ts>-<src>.json`), pinned by test. A plain reverse
NAME sort is WRONG twice over: the counter restarts at every process start
(so pid dominates), and its width changes at 10 000 ("9999" > "10000" as
strings) — measured on the live hub corpus (review #1153 point 1): the
name-sort top 50 and the ts top 50 overlap on 0 files.

Usage:
  python scripts/prefix-shared-len.py --dir D:\\claudish-captures --limit 50
  python scripts/prefix-shared-len.py --dir <dir> --machine myia-po-2023

TRAPS (each measured or pinned by a test):
  * Envelope ts: the file OPENS with {"ts": "..."} so the raw LCP of two
    files of the same second can include it — the raw column is a
    format-fixed baseline, and the report says so.
  * A session with ONE request has no pair: counted in `sessions_nopair`,
    never fabricated.
  * Session id: `metadata.user_id` (JSON string with device/session ids);
    absent -> the file falls in session "(noid)" rather than being dropped
    (a dropped file would silently shrink the sample). An ESCAPED
    `"user_id"` echoed inside a conversation message cannot match the
    regex: the backslash before the closing quote breaks the pattern
    (pinned by test).
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

REQ_FN = re.compile(r"^req-(\d+)-(\d+)-(.+)\.json$")
USER_ID_RE = re.compile(r'"user_id"\s*:\s*"((?:[^"\\]|\\.)*)"')
BODY_MARK = b'"body"'
LIMIT_CAP = 500


def session_of(raw_text):
    """Session key from the body's metadata.user_id; '(noid)' when absent.

    Pinned by test: the regex must NOT match a user_id echoed inside a
    conversation message (JSON escaping puts a backslash before the quote,
    which breaks the pattern — the echo occurs before the real metadata in
    the pin), and an absent key must yield '(noid)', not a drop.
    """
    m = USER_ID_RE.search(raw_text)
    return m.group(1) if m else "(noid)"


def ts_of(raw_text):
    m = re.search(r'"ts"\s*:\s*"([^"]+)"', raw_text)
    return m.group(1) if m else ""


def name_ts_key(fn):
    """Sort key: the ts group of the filename (newest last, caller reverses).

    The ts group is fixed-width ISO (`YYYY-MM-DDTHH-MM-SS-mmmZ-<src>`), so
    its plain string order IS time order. Sorting on the whole name sorts
    by pid then counter-as-string, which is not time (pinned by test).
    """
    m = REQ_FN.match(fn)
    return m.group(3) if m else fn


def lcp_bytes(a, b):
    """Longest common byte prefix of two byte strings (guard pinned by test)."""
    n = min(len(a), len(b))
    lo, hi = 0, n
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if a[:mid] == b[:mid]:
            lo = mid
        else:
            hi = mid - 1
    return lo


def body_offset(raw):
    """Byte offset of the body marker, -1 when absent."""
    return raw.find(BODY_MARK)


def canon_entry(obj):
    """Canonical serialization of one messages[] entry (stable bytes proxy)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def shared_leading_messages(body_a, body_b):
    """Count and canonical bytes of the identical leading messages[] entries."""
    msgs_a = body_a.get("messages", []) if isinstance(body_a, dict) else []
    msgs_b = body_b.get("messages", []) if isinstance(body_b, dict) else []
    n = 0
    total = 0
    for ea, eb in zip(msgs_a, msgs_b):
        ca, cb = canon_entry(ea), canon_entry(eb)
        if ca != cb:
            break
        n += 1
        total += len(ca.encode("utf-8"))
    return n, total


def sample(dirpath, limit, machine):
    """Pick up to `limit` req files, NEWEST FIRST by the filename ts group,
    optionally filtered by the envelope `machine` field (head-read only)."""
    names = sorted(
        (fn for fn in os.listdir(dirpath) if REQ_FN.match(fn)),
        key=name_ts_key,
        reverse=True,
    )
    picked = []
    for fn in names:
        if len(picked) >= limit:
            break
        path = os.path.join(dirpath, fn)
        with open(path, "rb") as fh:
            head = fh.read(1024).decode("utf-8", errors="replace")
        if machine:
            m = re.search(r'"machine"\s*:\s*"([^"]*)"', head)
            if not m or m.group(1) != machine:
                continue
        picked.append(path)
    return picked


def measure(paths):
    """Group by session, order by envelope ts, measure each consecutive pair."""
    sessions = defaultdict(list)
    for path in paths:
        with open(path, "rb") as fh:
            raw = fh.read()
        text = raw.decode("utf-8", errors="replace")
        sessions[session_of(text)].append((ts_of(text), path, raw))
    pairs = []
    nopair = 0
    for key, items in sessions.items():
        if len(items) < 2:
            nopair += 1
            continue
        items.sort(key=lambda t: (t[0], t[1]))
        bodies = {}
        for _ts, path, raw in items:
            try:
                doc = json.loads(raw.decode("utf-8", errors="replace"))
                bodies[path] = doc.get("body", {}) if isinstance(doc, dict) else {}
            except ValueError:
                bodies[path] = {}
        for (ts1, p1, raw1), (ts2, p2, raw2) in zip(items, items[1:]):
            shared_raw = lcp_bytes(raw1, raw2)
            o1, o2 = body_offset(raw1), body_offset(raw2)
            if o1 >= 0 and o2 >= 0:
                shared_body = lcp_bytes(raw1[o1:], raw2[o2:])
            else:
                shared_body = None
            n_msgs, msgs_bytes = shared_leading_messages(bodies.get(p1, {}),
                                                         bodies.get(p2, {}))
            pairs.append({
                "session": key[:40],
                "older": os.path.basename(p1),
                "newer": os.path.basename(p2),
                "shared_bytes_raw": shared_raw,
                "shared_bytes_body": shared_body,
                "shared_messages": n_msgs,
                "shared_messages_bytes_canon": msgs_bytes,
                "older_bytes": len(raw1),
                "newer_bytes": len(raw2),
            })
    return pairs, len(sessions), nopair


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", required=True, help="loose capture dir (req-*.json)")
    ap.add_argument("--limit", type=int, default=50,
                    help="sample size (default 50, hard cap %d — each sampled "
                         "file is read fully into memory, ~0.5 MB each)"
                         % LIMIT_CAP)
    ap.add_argument("--machine", default=None,
                    help="keep only captures whose envelope machine equals this")
    ap.add_argument("--json", action="store_true", help="emit the pair table as JSON")
    args = ap.parse_args(argv)
    limit = args.limit
    if limit > LIMIT_CAP:
        print(f"note: --limit {limit} clamped to {LIMIT_CAP} (memory bound)")
        limit = LIMIT_CAP

    paths = sample(args.dir, limit, args.machine)
    if not paths:
        print("no req-*.json sample (dir empty, or machine filter matched nothing)")
        return 1
    pairs, n_sessions, nopair = measure(paths)

    tot_newer = sum(p["newer_bytes"] for p in pairs)
    tot_raw = sum(p["shared_bytes_raw"] for p in pairs)
    tot_body = sum(p["shared_bytes_body"] or 0 for p in pairs)
    tot_msgs = sum(p["shared_messages"] for p in pairs)
    tot_msgs_bytes = sum(p["shared_messages_bytes_canon"] for p in pairs)

    def pct(x):
        return (100.0 * x / tot_newer) if tot_newer else 0.0

    print(f"sample: {len(paths)} files (newest first by filename ts) | "
          f"sessions: {n_sessions} ({nopair} with a single request, no pair)")
    print(f"consecutive pairs measured: {len(pairs)}")
    if pairs:
        print(f"[raw ] shared prefix bytes: {tot_raw:,} -> {pct(tot_raw):.1f}% of newer-file bytes "
              f"(format-fixed baseline: the envelope opens with ts, so this "
              f"diverges at the seconds digit by construction)")
        print(f"[body] LCP from the body offset: {tot_body:,} -> {pct(tot_body):.1f}% of newer-file bytes "
              f"(the redundancy a prefix store would recover)")
        print(f"[msgs] identical leading messages[]: {tot_msgs:,} entries, "
              f"{tot_msgs_bytes:,} canonical bytes -> {pct(tot_msgs_bytes):.1f}% of newer-file bytes")
        if args.json:
            print(json.dumps(pairs, indent=1))
        else:
            for p in pairs:
                sb = p["shared_bytes_body"]
                sb = f"{sb:,}" if sb is not None else "n/a"
                print(f"  {p['session']} | {p['older']} -> {p['newer']} | "
                      f"raw {p['shared_bytes_raw']:,} | body {sb} | "
                      f"msgs {p['shared_messages']} ({p['shared_messages_bytes_canon']:,} B canon) | "
                      f"newer {p['newer_bytes']:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
