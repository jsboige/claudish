#!/usr/bin/env python3
"""prefix-shared-len.py — shared byte prefix between consecutive requests of a
session (#640 repli; reconnaissance for #1152 option (b)).

The hub writes one req-*.json per request and each carries the WHOLE
conversation (#1152): consecutive requests of a session repeat the same
prefix. This instrument measures, on a bounded sample of loose captures, the
longest common byte prefix (LCP) between each session's CONSECUTIVE request
files — the bytes a content-addressed prefix store would deduplicate, as an
UPPER bound: the raw-file LCP also covers the identical envelope head (ts
excepted: the envelope opens with ts, which differs — see TRAPS).

Read profile: session grouping needs `metadata.user_id`, which lives in the
BODY (up to ~300 KB in, measured by billed-attrib.py:140); with --limit in
the tens the instrument reads the sampled files fully (50 x ~0.5 MB = light,
unlike a whole-corpus census — the 05-07Z trough rule governs those, not
this).

Usage:
  python scripts/prefix-shared-len.py --dir D:\\claudish-captures --limit 50
  python scripts/prefix-shared-len.py --dir <dir> --machine myia-po-2023

TRAPS (each measured or pinned by a test):
  * Envelope ts: the file OPENS with {"ts": "..."} so the raw LCP of two
    files of the same second can include it — the LCP is a byte-level
    upper bound of the conversation redundancy, and the report says so.
  * A session with ONE request has no pair: counted in `sessions_nopair`,
    never fabricated.
  * Session id: `metadata.user_id` (JSON string with device/session ids);
    absent -> the file falls in session "(noid)" rather than being dropped
    (a dropped file would silently shrink the sample).
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

REQ_FN = re.compile(r"^req-(\d+)-(\d+)-(.+)\.json$")
USER_ID_RE = re.compile(r'"user_id"\s*:\s*"((?:[^"\\]|\\.)*)"')


def session_of(raw_text):
    """Session key from the body's metadata.user_id; '(noid)' when absent.

    Pinned by test: the regex must NOT match a user_id echoed inside a
    conversation message (the billing block quotes k=v pairs, never a JSON
    "user_id":), and an absent key must yield '(noid)', not a drop.
    """
    m = USER_ID_RE.search(raw_text)
    return m.group(1) if m else "(noid)"


def ts_of(raw_text):
    m = re.search(r'"ts"\s*:\s*"([^"]+)"', raw_text)
    return m.group(1) if m else ""


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


def sample(dirpath, limit, machine):
    """Pick up to `limit` req files, newest first, optionally filtered by the
    envelope `machine` field (head-read only)."""
    names = sorted(
        (fn for fn in os.listdir(dirpath) if REQ_FN.match(fn)),
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
    """Group by session, order by envelope ts, LCP each consecutive pair."""
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
        for (ts1, p1, raw1), (ts2, p2, raw2) in zip(items, items[1:]):
            shared = lcp_bytes(raw1, raw2)
            pairs.append({
                "session": key[:40],
                "older": os.path.basename(p1),
                "newer": os.path.basename(p2),
                "shared_bytes": shared,
                "older_bytes": len(raw1),
                "newer_bytes": len(raw2),
            })
    return pairs, len(sessions), nopair


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", required=True, help="loose capture dir (req-*.json)")
    ap.add_argument("--limit", type=int, default=50, help="sample size (default 50)")
    ap.add_argument("--machine", default=None,
                    help="keep only captures whose envelope machine equals this")
    ap.add_argument("--json", action="store_true", help="emit the pair table as JSON")
    args = ap.parse_args(argv)

    paths = sample(args.dir, args.limit, args.machine)
    if not paths:
        print("no req-*.json sample (dir empty, or machine filter matched nothing)")
        return 1
    pairs, n_sessions, nopair = measure(paths)

    tot_shared = sum(p["shared_bytes"] for p in pairs)
    tot_newer = sum(p["newer_bytes"] for p in pairs)
    print(f"sample: {len(paths)} files | sessions: {n_sessions} "
          f"({nopair} with a single request, no pair)")
    print(f"consecutive pairs measured: {len(pairs)}")
    if pairs:
        shared_kib = tot_shared / 1024.0
        newer_kib = tot_newer / 1024.0
        pct = (100.0 * tot_shared / tot_newer) if tot_newer else 0.0
        print(f"shared prefix bytes: {tot_shared:,} ({shared_kib:.1f} KiB) "
              f"over {tot_newer:,} newer-file bytes ({newer_kib:.1f} KiB) -> "
              f"{pct:.1f}% of the newer file repeats the older one "
              f"(byte-level UPPER bound: includes the identical envelope head)")
        if args.json:
            print(json.dumps(pairs, indent=1))
        else:
            for p in pairs:
                print(f"  {p['session']} | {p['older']} -> {p['newer']} | "
                      f"shared {p['shared_bytes']:,} / newer {p['newer_bytes']:,} "
                      f"({100.0 * p['shared_bytes'] / p['newer_bytes'] if p['newer_bytes'] else 0:.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
