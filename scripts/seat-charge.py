#!/usr/bin/env python
"""Seat charge: turns/h and real context size, per workspace and per role.

Why this exists
---------------
ai-01:vllm cannot attribute hub traffic by machine (the hairpin NAT destroys the
source IP one level before ARR, #41), so "which seat do I send to Minimax" was
being decided without numbers. The query asked of each seat (27/10 21:10Z) is
"turns/h + taille contexte par siege". This script answers it from the one
instrument every seat already has: Claude Code's own transcripts.

What makes it trustworthy
-------------------------
- The prompt size is the REAL wire size read from `message.usage`
  (input + cache_read + cache_creation), not a chars/4 estimate.
- `requestedModel` is what the CLIENT asked for (the role: haiku/sonnet), while
  `message.model` is who actually served it. The pair is the remap, visible
  seat-side, which is the whole point: a haiku-requested turn served by
  `deepseek-flash` is PAYG volume that no hub-side counter sees.

Two counting traps this script exists to avoid
----------------------------------------------
1. FILTER ON THE MESSAGE TIMESTAMP, NEVER ON THE FILE MTIME. A touched file
   holds whole sessions; an mtime filter inflates a busy workspace by an order
   of magnitude (measured: CoursIA read 35 598 turns for a 24 h window that
   really held ~1 900).
2. DEDUPLICATE BY `requestRef`. One API response writes one entry PER CONTENT
   BLOCK (`apiBlockIndex` 0,1,2...) with the same requestRef and the same
   usage. Counting entries counts blocks - ~2.4x too many (measured on this
   seat, po-2027). After dedup the total reconciles with the proxy's own
   `[ttft]` line count within 2 % (3 238 vs 3 179 over 13 h), which is the
   control that the two instruments agree.

Read-only: opens jsonl files under ~/.claude/projects, writes nothing.

Usage
-----
  python -I scripts/seat-charge.py                 # last 24 h
  python -I scripts/seat-charge.py --hours 13      # the proxy log's own window
  python -I scripts/seat-charge.py --json          # machine-readable, for a
                                                   # fleet roll-up
  python -I scripts/seat-charge.py --selftest      # synthetic, no real data

Exit: 0 ok, 2 no transcript in the window or selftest failure.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import tempfile
import time
from collections import defaultdict

PROJECTS = os.path.join(os.path.expanduser("~"), ".claude", "projects")


def prompt_size(usage):
    """The prompt as the provider billed it: totals live in three fields."""
    return (
        (usage.get("input_tokens") or 0)
        + (usage.get("cache_read_input_tokens") or 0)
        + (usage.get("cache_creation_input_tokens") or 0)
    )


def iter_messages(paths, cutoff_iso):
    """Yield (workspace, entry) for assistant messages inside the window."""
    for path in paths:
        ws = os.path.basename(os.path.dirname(path))
        try:
            handle = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with handle:
            for line in handle:
                # Cheap prefilter: only assistant messages carry usage.
                if '"usage"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(entry.get("message"), dict):
                    continue
                if not isinstance(entry["message"].get("usage"), dict):
                    continue
                ts = entry.get("timestamp") or ""
                if ts[:4] != "2026" or ts < cutoff_iso:
                    continue
                yield ws, entry


def aggregate(paths, cutoff_iso):
    """-> (rows, totals) with one row per workspace x requested->served."""
    rows = defaultdict(
        lambda: {"n": 0, "sizes": [], "out": 0, "hours": defaultdict(int)}
    )
    seen = set()
    requests = 0
    for ws, entry in iter_messages(paths, cutoff_iso):
        ref = entry.get("requestRef")
        if ref:
            if ref in seen:
                continue
            seen.add(ref)
        msg = entry["message"]
        usage = msg["usage"]
        key = (
            ws
            + "|"
            + (entry.get("requestedModel") or "?")
            + "->"
            + (msg.get("model") or "?")
        )
        row = rows[key]
        row["n"] += 1
        row["sizes"].append(prompt_size(usage))
        row["out"] += usage.get("output_tokens") or 0
        row["hours"][(entry.get("timestamp") or "")[:13]] += 1
        requests += 1
    return rows, requests


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[min(int(len(ordered) * fraction), len(ordered) - 1)]


def render(rows, requests, hours, json_out):
    served = defaultdict(int)
    served_tok = defaultdict(int)
    for key, row in rows.items():
        model = key.split("->", 1)[1]
        served[model] += row["n"]
        served_tok[model] += sum(row["sizes"])
    if json_out:
        payload = {
            "window_hours": hours,
            "requests": requests,
            "rows": [
                {
                    "workspace": key.split("|", 1)[0],
                    "requested": key.split("|", 1)[1].split("->")[0],
                    "served": key.split("->", 1)[1],
                    "turns": row["n"],
                    "turns_per_hour": round(row["n"] / hours, 1) if hours else 0,
                    "prompt_p50": percentile(row["sizes"], 0.5),
                    "prompt_p90": percentile(row["sizes"], 0.9),
                    "prompt_max": max(row["sizes"]),
                    "out_per_turn": row["out"] // max(row["n"], 1),
                }
                for key, row in sorted(rows.items(), key=lambda kv: -kv[1]["n"])
            ],
            "served_totals": {
                model: {
                    "turns": served[model],
                    "share_pct": round(100.0 * served[model] / requests, 1),
                    "prompt_tokens": served_tok[model],
                }
                for model in sorted(served, key=lambda m: -served[m])
            },
        }
        print(json.dumps(payload, indent=1))
        return

    print(f"window: {hours} h   requests: {requests}   ({requests / hours:.0f}/h)")
    print(
        f"\n{'workspace|requested->served':<58} {'turns':>6} {'/h':>6} "
        f"{'p50tok':>8} {'p90tok':>8} {'max':>8} {'out/trn':>7}"
    )
    for key, row in sorted(rows.items(), key=lambda kv: -kv[1]["n"]):
        print(
            f"{key:<58} {row['n']:>6} {row['n'] / hours:>6.1f} "
            f"{percentile(row['sizes'], 0.5):>8} {percentile(row['sizes'], 0.9):>8} "
            f"{max(row['sizes']):>8} {row['out'] // max(row['n'], 1):>7}"
        )

    print("\nserved by (who actually pays):")
    for model in sorted(served, key=lambda m: -served[m]):
        share = 100.0 * served[model] / requests
        print(
            f"  {model:<28} {served[model]:>6} {share:>5.1f}%  "
            f"{served_tok[model] // 1000000:>5} M prompt tok"
        )

    print("\nhourly turns where the CLIENT asked for haiku:")
    for key, row in sorted(rows.items(), key=lambda kv: -kv[1]["n"]):
        if "claude-haiku" not in key:
            continue
        stamp = " ".join(f"{h[-2:]}h:{c}" for h, c in sorted(row["hours"].items()))
        print(f"  {key}\n    {stamp}")


SELFTEST_LINES = [
    # One response, three content blocks, same requestRef: must count ONCE.
    {
        "timestamp": "2026-10-28T01:00:00Z",
        "requestRef": "r1",
        "apiBlockIndex": 0,
        "requestedModel": "claude-haiku-5-5",
        "message": {
            "model": "deepseek-flash",
            "usage": {
                "input_tokens": 10,
                "cache_read_input_tokens": 90,
                "cache_creation_input_tokens": 0,
                "output_tokens": 5,
            },
        },
    },
    {
        "timestamp": "2026-10-28T01:00:01Z",
        "requestRef": "r1",
        "apiBlockIndex": 1,
        "requestedModel": "claude-haiku-5-5",
        "message": {
            "model": "deepseek-flash",
            "usage": {
                "input_tokens": 10,
                "cache_read_input_tokens": 90,
                "cache_creation_input_tokens": 0,
                "output_tokens": 5,
            },
        },
    },
    {
        "timestamp": "2026-10-28T01:00:02Z",
        "requestRef": "r1",
        "apiBlockIndex": 2,
        "requestedModel": "claude-haiku-5-5",
        "message": {
            "model": "deepseek-flash",
            "usage": {
                "input_tokens": 10,
                "cache_read_input_tokens": 90,
                "cache_creation_input_tokens": 0,
                "output_tokens": 5,
            },
        },
    },
    {
        "timestamp": "2026-10-28T01:05:00Z",
        "requestRef": "r2",
        "requestedModel": "claude-sonnet-5-5",
        "message": {
            "model": "glm-5.3",
            "usage": {
                "input_tokens": 1,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
                "output_tokens": 2,
            },
        },
    },
    # Outside the window: must be dropped by the MESSAGE timestamp even though
    # the file itself is fresh.
    {
        "timestamp": "2026-10-20T01:05:00Z",
        "requestRef": "r0",
        "requestedModel": "claude-haiku-5-5",
        "message": {
            "model": "swift-1.5-27b",
            "usage": {"input_tokens": 7, "output_tokens": 7},
        },
    },
]


def selftest():
    with tempfile.TemporaryDirectory() as tmp:
        ws_dir = os.path.join(tmp, "d--dev-selftest")
        os.makedirs(ws_dir)
        with open(os.path.join(ws_dir, "s.jsonl"), "w", encoding="utf-8") as fh:
            for entry in SELFTEST_LINES:
                fh.write(json.dumps(entry) + "\n")
        paths = glob.glob(os.path.join(tmp, "*", "*.jsonl"))
        rows, requests = aggregate(paths, "2026-10-28T00:00:00Z")
        checks = [
            ("two requests, not four entries", requests, 2),
            (
                "block dedup keeps one haiku row at 100 tok",
                rows["d--dev-selftest|claude-haiku-5-5->deepseek-flash"]["n"],
                1,
            ),
            (
                "prompt size sums the three usage fields",
                sum(rows["d--dev-selftest|claude-haiku-5-5->deepseek-flash"]["sizes"]),
                100,
            ),
            (
                "out-of-window request dropped",
                "d--dev-selftest|claude-haiku-5-5->swift-1.5-27b" in rows,
                False,
            ),
            ("requested/served pair kept separate", len(rows), 2),
        ]
        failed = 0
        for label, got, want in checks:
            ok = got == want
            failed += 0 if ok else 1
            print(f"[{'PASS' if ok else 'FAIL'}] {label}: got {got!r} want {want!r}")
        return 0 if failed == 0 else 2


def main(argv=None):
    parser = argparse.ArgumentParser(description="Seat charge from CC transcripts")
    parser.add_argument("--hours", type=float, default=24.0)
    parser.add_argument("--projects", default=PROJECTS)
    parser.add_argument("--json", action="store_true", dest="json_out")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()
    if not os.path.isdir(args.projects):
        print(f"no transcript directory: {args.projects}", file=sys.stderr)
        return 2

    cutoff = time.time() - args.hours * 3600
    cutoff_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(cutoff))
    paths = [
        p
        for p in glob.glob(os.path.join(args.projects, "*", "*.jsonl"))
        if os.path.getmtime(p) >= cutoff
    ]
    rows, requests = aggregate(paths, cutoff_iso)
    if not requests:
        print(f"no assistant message in the last {args.hours} h", file=sys.stderr)
        return 2
    render(rows, requests, args.hours, args.json_out)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="ascii", errors="replace")
    sys.exit(main())
