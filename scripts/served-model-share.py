#!/usr/bin/env python
"""Served-model share: who actually served each turn, per UTC day, from Claude Code transcripts.

Why this exists
---------------
The engine's 400 "maximum context length" family (nominal `swift-1.5-27b`,
window 262 144 on the vllm-myia engine) is INVISIBLE client-side: the cascade
absorbs it and the client sees a 200. So the only seat-side instrument is
`message.model` on each assistant entry - who served - read against
`requestedModel` - the role the client asked for. The share of the nominal
versus the fallback is the cost signal that the `AUTO_COMPACT_WINDOW` alignment
is meant to move, and it stays comparable before/after without any hub-side
access (which a WAN seat may not have at all).

Traps this script avoids
------------------------
1. DEDUPLICATE BY `requestRef`. One API response writes one entry PER CONTENT
   BLOCK (`apiBlockIndex` 0,1,2...), all carrying the same requestRef and model.
   Counting entries over-counts ~2.4x (see scripts/seat-charge.py). The SHARE is
   a ratio and survives that inflation; the absolute counts do not.
2. FILTER ON THE ENTRY TIMESTAMP, NEVER ON FILE MTIME (a touched file holds
   whole sessions).
3. A failover BANNER count is an EPISODE marker, not a per-turn counter
   (measured 12/11 on po-2027: 2 banners for 4 180 served turns). Never use it
   as an occurrence count.

Read-only: opens jsonl files under ~/.claude/projects, writes nothing.

Usage
-----
  python -I scripts/served-model-share.py --list-projects
  python -I scripts/served-model-share.py --project D--dev-CoursIA-2
  python -I scripts/served-model-share.py --project D--dev-CoursIA-2 --since 2026-11-08
  python -I scripts/served-model-share.py --project D--dev-CoursIA-2 --pair swift,minimax --runs
  python -I scripts/served-model-share.py --project D--dev-CoursIA-2 --json

Exit: 0 ok, 2 no transcript in the window.
"""

from __future__ import annotations

import argparse
import fnmatch
import glob
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone


def projects_root() -> str:
    return os.path.expanduser(os.path.join("~", ".claude", "projects"))


def resolve_projects(pattern: str) -> list[str]:
    root = projects_root()
    if not os.path.isdir(root):
        return []
    names = sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
    if any(ch in pattern for ch in "*?["):
        return [os.path.join(root, n) for n in names if fnmatch.fnmatch(n, pattern)]
    if os.path.isdir(pattern):
        return [pattern]
    exact = [n for n in names if n == pattern]
    if exact:
        return [os.path.join(root, n) for n in exact]
    return [os.path.join(root, n) for n in names if pattern.lower() in n.lower()]


def parse_ts(value: str):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def collect(paths: list[str], since: datetime):
    """Return per-day served/requested counts, api-error counts, and serving runs.

    A run is a maximal sequence of deduped turns served by the same model whose
    consecutive timestamps are closer than `gap_min` minutes.
    """
    served = defaultdict(lambda: defaultdict(int))
    requested = defaultdict(lambda: defaultdict(int))
    apierr = defaultdict(int)
    events = []  # (ts, served_model) after requestRef dedup, chronologically within each file
    seen_refs = set()

    for proj in paths:
        for f in sorted(glob.glob(os.path.join(proj, "*.jsonl"))):
            try:
                fh = open(f, encoding="utf-8", errors="ignore")
            except OSError:
                continue
            with fh:
                for line in fh:
                    if '"model":"' not in line and "isApiErrorMessage" not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    ts = d.get("timestamp")
                    if not ts:
                        continue
                    dt = parse_ts(ts)
                    if dt is None or dt < since:
                        continue
                    msg = d.get("message") or {}
                    day = dt.strftime("%Y-%m-%d")
                    if msg.get("isApiErrorMessage"):
                        apierr[day] += 1
                        continue
                    if msg.get("role") != "assistant" and d.get("type") != "assistant":
                        continue
                    ref = d.get("requestRef") or d.get("uuid") or f"{f}:{ts}"
                    if ref in seen_refs:
                        continue
                    seen_refs.add(ref)
                    model = msg.get("model") or "?"
                    served[day][model] += 1
                    asked = d.get("requestedModel") or "?"
                    requested[day][asked] += 1
                    events.append((dt, model))
    events.sort(key=lambda e: e[0])
    return served, requested, apierr, events


def build_runs(events, gap_min: int):
    runs = []
    cur = None
    for dt, model in events:
        if cur and cur[2] == model and (dt - cur[1]).total_seconds() <= gap_min * 60:
            cur[1] = dt
            cur[3] += 1
        else:
            if cur:
                runs.append(cur)
            cur = [dt, dt, model, 1]
    if cur:
        runs.append(cur)
    return runs


def main() -> int:
    ap = argparse.ArgumentParser(description="Per-day served-model share from Claude Code transcripts")
    ap.add_argument("--project", default="*", help="project dir name (exact, glob or substring); default all")
    ap.add_argument("--since", default=None, help="UTC date YYYY-MM-DD (default: 7 days ago)")
    ap.add_argument("--days", type=int, default=7, help="window when --since is omitted")
    ap.add_argument("--pair", default="swift,minimax", help="NOMINAL,FALLBACK substrings, case-insensitive")
    ap.add_argument("--runs", action="store_true", help="also print contiguous serving runs")
    ap.add_argument("--gap-min", type=int, default=10, help="run split threshold in minutes (default 10)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--list-projects", action="store_true", help="list project dirs and exit")
    args = ap.parse_args()

    if args.list_projects:
        root = projects_root()
        if not os.path.isdir(root):
            print("no", root, file=sys.stderr)
            return 2
        for d in sorted(os.listdir(root)):
            if os.path.isdir(os.path.join(root, d)):
                print(d)
        return 0

    since = (
        datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        if args.since
        else (datetime.now(timezone.utc) - timedelta(days=args.days))
    )
    paths = resolve_projects(args.project)
    if not paths:
        print(f"no project matches {args.project!r}", file=sys.stderr)
        return 2
    nominal, fallback = (s.strip().lower() for s in args.pair.split(",", 1))
    served, requested, apierr, events = collect(paths, since)
    total_turns = sum(sum(m.values()) for m in served.values())
    if total_turns == 0:
        print(f"no assistant turn since {since.isoformat()}", file=sys.stderr)
        return 2

    runs = build_runs(events, args.gap_min) if args.runs else []

    if args.json:
        payload = {
            "since": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "projects": paths,
            "days": {
                day: {
                    "served": dict(served[day]),
                    "requested": dict(requested[day]),
                    "api_errors": apierr.get(day, 0),
                }
                for day in sorted(served)
            },
            "runs": [
                {
                    "start": r[0].isoformat(),
                    "end": r[1].isoformat(),
                    "model": r[2],
                    "turns": r[3],
                }
                for r in runs
            ],
        }
        print(json.dumps(payload, indent=2))
        return 0

    print(f"projects: {', '.join(os.path.basename(p) for p in paths)}")
    print(f"since {since.strftime('%Y-%m-%dT%H:%MZ')} · {len(events)} deduped turns\n")
    header = f"{'day':12} {'turns':>6} {'nominal':>8} {'fallback':>9} {'other':>6} {'fb_share':>8} {'apierr':>6}"
    print(header)
    print("-" * len(header))
    tot = defaultdict(int)
    for day in sorted(served):
        m = served[day]
        nom = sum(v for k, v in m.items() if nominal in k.lower())
        fb = sum(v for k, v in m.items() if fallback in k.lower())
        other = sum(m.values()) - nom - fb
        total = sum(m.values())
        share = 100.0 * fb / total if total else 0.0
        print(f"{day:12} {total:>6} {nom:>8} {fb:>9} {other:>6} {share:>7.1f}% {apierr.get(day, 0):>6}")
        tot["total"] += total
        tot["nom"] += nom
        tot["fb"] += fb
        tot["other"] += other
        tot["apierr"] += apierr.get(day, 0)
    share = 100.0 * tot["fb"] / tot["total"] if tot["total"] else 0.0
    print("-" * len(header))
    print(f"{'TOTAL':12} {tot['total']:>6} {tot['nom']:>8} {tot['fb']:>9} {tot['other']:>6} {share:>7.1f}% {tot['apierr']:>6}")

    print("\nserved models (deduped):")
    allm = defaultdict(int)
    for m in served.values():
        for k, v in m.items():
            allm[k] += v
    for k, v in sorted(allm.items(), key=lambda kv: -kv[1]):
        print(f"  {k:36} {v:>6}")
    asked = defaultdict(int)
    for m in requested.values():
        for k, v in m.items():
            asked[k] += v
    print("\nrequested models (client role):")
    for k, v in sorted(asked.items(), key=lambda kv: -kv[1]):
        print(f"  {k:36} {v:>6}")

    if runs:
        print(f"\nserving runs (split at gaps > {args.gap_min} min):")
        for st, en, model, n in runs:
            span = int((en - st).total_seconds())
            print(f"  {st.strftime('%m-%d %H:%M:%S')}Z -> {en.strftime('%H:%M:%S')}Z  {model:30} n={n:>4} span={span}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())