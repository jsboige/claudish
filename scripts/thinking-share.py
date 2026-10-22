#!/usr/bin/env python3
r"""Thinking share of output tokens on a lane, from `resp-*.sse` captures.

Why this exists: on a thinking-capable lane the `output_tokens` a provider bills
include the model's internal reasoning. That share is invisible in the request
captures and in the normal proxy log (`[ttft]` carries timings only), but the
hub persists every response as `resp-<pid>-r<N>-<date>-<wire>-<model>.sse` and
the terminal `message_delta` carries the breakdown:

    "usage":{"input_tokens":23240,"output_tokens":1214,
             "cache_read_input_tokens":128,
             "output_tokens_details":{"thinking_tokens":945}}

Measured 2026-10-22 on the MiniMax-M3.1-Flash lane: 50.4% of output tokens were
thinking (2 329 019 / 4 616 802 over 4 404 responses, p50 259 tokens). That is
the number any `CLAUDISH_MINIMAX_THINKING` effort decision has to move.

Reading rules (each one cost a wrong number once):

  * The terminal usage is the one with the largest `output_tokens` in the file —
    an early `message_start` can carry a zeroed or seeded usage block. Taking the
    first match reports 0.
  * `thinking_tokens` is a SUBSET of `output_tokens` (a breakdown of the same
    total), never an addition to it.
  * A response without the field is EXCLUDED from the ratio, never counted as
    zero: those are non-terminal writes or pre-breakdown files, and folding them
    in at zero silently halves the share.
  * The capture timestamp uses DASHES (`T06-18-15-927Z`), not colons: a
    `T06:18` pattern matches nothing and reads as a missing day.
  * `--day` is a filename prefix match, so it works on the live loose day and on
    the members of a 7z listing alike.

Usage:
    python scripts/thinking-share.py --day 2026-10-22 --model MiniMax
    python scripts/thinking-share.py --day 2026-10-22 --model MiniMax --json
"""
import argparse
import json
import os
import re
import statistics
import sys

DEFAULT_DIR = os.environ.get("CLAUDISH_CAPTURE_DIR_HOST", r"D:\claudish-captures")

OUT_RX = re.compile(rb'"output_tokens":(\d+)')
THK_RX = re.compile(rb'"thinking_tokens":(\d+)')


def collect(captures_dir, day, model):
    rows = []
    with os.scandir(captures_dir) as it:
        for entry in it:
            name = entry.name
            if not name.startswith("resp-") or day not in name or model not in name:
                continue
            try:
                with open(entry.path, "rb") as fh:
                    data = fh.read()
            except OSError:
                continue
            outs = [int(x) for x in OUT_RX.findall(data)]
            if not outs:
                continue
            thks = [int(x) for x in THK_RX.findall(data)]
            rows.append((name, max(outs), max(thks) if thks else None))
    return rows


def pct(values, q):
    if not values:
        return 0
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, int(round(q * len(ordered))) - 1))
    return ordered[idx]


def main():
    ap = argparse.ArgumentParser(description="Thinking share of output tokens on a lane")
    ap.add_argument("--captures-dir", default=DEFAULT_DIR)
    ap.add_argument("--day", required=True, help="date prefix, e.g. 2026-10-22")
    ap.add_argument("--model", default="", help="model substring, e.g. MiniMax")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    rows = collect(args.captures_dir, args.day, args.model)
    if not rows:
        print(f"no resp files for day={args.day} model={args.model!r} in {args.captures_dir}",
              file=sys.stderr)
        return 2

    with_thk = [r for r in rows if r[2] is not None]
    total_out = sum(r[1] for r in rows)
    total_thk = sum(r[2] for r in with_thk)
    thk_out = [r[1] for r in with_thk]
    thk_vals = [r[2] for r in with_thk]

    result = {
        "day": args.day,
        "model_filter": args.model,
        "responses": len(rows),
        "responses_with_thinking_field": len(with_thk),
        "output_tokens_total": total_out,
        "thinking_tokens_total": total_thk,
        "thinking_share_pct": round(100.0 * total_thk / max(1, total_out), 1),
        "thinking_p50": statistics.median(thk_vals) if thk_vals else None,
        "thinking_p90": pct(thk_vals, 0.9) if thk_vals else None,
        "thinking_max": max(thk_vals) if thk_vals else None,
        "output_p50": statistics.median(thk_out) if thk_out else None,
        "output_p90": pct(thk_out, 0.9) if thk_out else None,
    }
    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    print(f"day={args.day} model={args.model or '*'} responses={result['responses']} "
          f"with_thinking_field={result['responses_with_thinking_field']}")
    print(f"output total={total_out} thinking total={total_thk} "
          f"share={result['thinking_share_pct']}% of output")
    if thk_vals:
        print(f"per-response thinking: p50={result['thinking_p50']} "
              f"p90={result['thinking_p90']} max={result['thinking_max']}")
        print(f"per-response output  : p50={result['output_p50']} "
              f"p90={result['output_p90']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
