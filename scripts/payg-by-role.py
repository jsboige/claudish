#!/usr/bin/env python
"""PAYG share per ROLE, from the hub's request/response capture pairs (#41).

Why this exists
---------------
The cascade can serve a `claude-sonnet-5-5` request from GLM (forfait), DeepSeek
Flash (PAYG), MiniMax (forfait), swift (local) or the Anthropic lane. The hub
log knows the ROLE (`[Request] model=`) and the SERVED model (`[ttft] model=`)
but never pairs them — `[Request]` carries no reqN. The capture pair does:

    req-1-<N>-<ts>-direct.json            the request body: model = the ROLE
    resp-1-r<N>-<ts>-<format>-<model>.sse the served response: model = SERVED

Counting traps this script exists to avoid
------------------------------------------
1. reqN RESTARTS, so `N` alone is NOT a key (#48, measured). Two resp files named
   `r10100` exist — one from 27/10, one from 28/10. A pair is accepted only when
   both halves name the same `N` AND the response timestamp falls inside
   [req_ts, req_ts + MAX_STREAM_S]; everything else is reported UNMATCHED, never
   guessed.
2. The capture directory is FLAT and holds ~145k files. `glob` dies there (>120 s,
   and returns an EMPTY set under write load — silence is not "no traffic").
   One `os.scandir` pass, no glob, no recursion — and NO `is_file()`: on a
   Docker-Desktop bind mount each stat costs ~14 ms, measured 2026-10-28 as
   5.6 s of CPU inside 35 min of wall clock for a 24 h run (I/O-blocked on
   145k per-entry stats, not on work). The name decides; the regexes already
   require a .json/.sse suffix. Body reads are bounded by --max-pairs and the
   overflow is REPORTED, never silently dropped.
3. A role is read from the request BODY, never inferred from the served model:
   `glm-5.3` serves sonnet, fable and haiku requests alike.
4. PAYG is decided by an explicit MODEL -> PLAN table (below), never by "not
   Anthropic": `deepseek-v4.1-flash-1017` is the QWEN PREPAID alias, while
   `deepseek-flash` and `deepseek-v4-flash` are PAYG. The names differ by a
   suffix; the table is the only thing that can be reviewed.
5. Request bodies can be megabytes (msgs=446). Only the first HEAD_BYTES of each
   request file is read — the `model` field is at the top of the JSON object.

Usage
-----
  python -I scripts/payg-by-role.py                         # last 24 h, human table
  python -I scripts/payg-by-role.py --hours 6               # the wall episode itself
  python -I scripts/payg-by-role.py --json                  # machine-readable
  python -I scripts/payg-by-role.py --print-table           # the plan classifier
  python -I scripts/payg-by-role.py --selftest              # synthetic, no real data

Exit: 0 ok, 2 nothing in the window or selftest failure.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

# Generous upper bound for "this response belongs to that request": the capture
# name carries the FIRST-BYTE time, measured 8.6 s after the request on a real
# pair; a long stream can push it further, but past MAX_STREAM_S the same-N
# candidate is more likely a counter reuse than this request's own response.
MAX_STREAM_S = 300

HEAD_BYTES = 4096

TS_PAT = r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z"
TS_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$")
# The timestamp is spelled out in both patterns: with a lazy `(.+?)` the dash
# inside the date splits first and every file is silently skipped (measured —
# the first selftest returned 0/3 because of exactly that).
REQ_RE = re.compile(r"^req-(\d+)-(\d+)-(" + TS_PAT + r")-(.+)\.json$")
# Longer formats first: `openai-responses` must win over `openai`.
RESP_RE = re.compile(r"^resp-(\d+)-r(\d+)-(" + TS_PAT +
                     r")-(openai-responses|openai|anthropic|gemini|ollama)-(.+)\.sse$")
ROLE_RE = re.compile(r'^claude-(opus|sonnet|haiku|fable)')

# MODEL -> PLAN. Prepaid = a subscription/forfait pays it; local = our own engine
# (no per-token bill); payg = metered money. Anything not listed reads UNKNOWN and
# is reported as such — an unclassified model must never be silently counted as
# prepaid (that is how a PAYG leak stays invisible).
PLAN = {
    # --- forfaits ---
    "glm-5.3": "prepaid",
    "glm-5.2": "prepaid",
    "glm-4.5-air": "prepaid",
    "MiniMax-M3.1-Flash": "prepaid",
    "MiniMax-M3": "prepaid",
    "gpt-6.1-sol": "prepaid",
    # Kimi forfait is cancelled (27/10) but the rung still exists on some seats:
    # labelled apart so it can never be read as "forfait still paying".
    "k3.1-pro": "forfait-cancelled",
    "kimi-k3": "forfait-cancelled",
    # --- local engines (free) ---
    "swift-1.5-27b": "local",
    "swift-1.5-27b-no-thinking": "local",
    "qwen3.6-35b-a3b": "local",
    "frognano-4b": "local",
    # --- PAYG (metered) ---
    "deepseek-flash": "payg",
    "deepseek-v4-flash": "payg",     # the RSM condensation client names it directly (#713)
    "deepseek-chat": "payg",
    "deepseek-reasoner": "payg",
    # --- prepaid alias whose NAME looks PAYG: never classify by name ---
    "deepseek-v4.1-flash-1017": "prepaid",  # qwen-token-plan alias (Qwen plan, walled until 11/11)
}


def parse_ts(s: str):
    m = TS_RE.match(s)
    if not m:
        return None
    y, mo, d, h, mi, se, ms = (
        int(m.group(1)), int(m.group(2)), int(m.group(3)),
        int(m.group(4)), int(m.group(5)), int(m.group(6)), int(m.group(7)),
    )
    return datetime(y, mo, d, h, mi, se, ms * 1000, tzinfo=timezone.utc).timestamp()


def role_of(model: str) -> str:
    if not model:
        return "unknown"
    m = ROLE_RE.match(model)
    return m.group(1) if m else "other:" + model


def plan_of(model: str) -> str:
    if not model:
        return "unknown"
    if model in PLAN:
        return PLAN[model]
    if model.startswith("claude-"):
        return "native"
    # family fallbacks, deliberately narrow
    if model.startswith("glm-") or model.startswith("zai-glm-"):
        return "prepaid"
    if model.startswith("MiniMax-"):
        return "prepaid"
    return "unknown"


def read_requested_model(path: str) -> str:
    """The requested model, read from the head of the body only."""
    try:
        with open(path, "rb") as f:
            head = f.read(HEAD_BYTES).decode("utf-8", "replace")
    except OSError:
        return ""
    m = re.search(r'"model"\s*:\s*"([^"]+)"', head)
    return m.group(1) if m else ""


def scan(captures: str, since_ts: float, until_ts: float, max_pairs: int = 4000):
    """One pass over the flat capture dir. Returns (pairs, stats).

    No `entry.is_file()`: on a Docker-Desktop bind mount every stat costs ~14 ms
    here (MEASURED 2026-10-28: 145k entries, 5.6 s of CPU in 35 min of wall
    clock - the scan was I/O-blocked on per-entry stats, not on work). The name
    decides, and the regexes already require a `.json`/`.sse` suffix, so a
    directory can never match. Directory enumeration alone is fast.
    """
    reqs = defaultdict(list)   # N -> [(ts, path, raw_ts)]
    resps = defaultdict(list)  # N -> [(ts, model, raw_ts)]
    for entry in os.scandir(captures):
        name = entry.name
        if name.startswith("req-"):
            m = REQ_RE.match(name)
            if not m:
                continue
            ts = parse_ts(m.group(3))
            if ts is None or ts < since_ts or ts > until_ts:
                continue
            reqs[m.group(2)].append((ts, entry.path, m.group(3)))
        elif name.startswith("resp-"):
            m = RESP_RE.match(name)
            if not m:
                continue
            ts = parse_ts(m.group(3))
            if ts is None or ts < since_ts - MAX_STREAM_S or ts > until_ts + MAX_STREAM_S:
                continue
            resps[m.group(2).lstrip("0") or "0"].append((ts, m.group(5), m.group(3)))
    pairs = []
    unmatched = 0
    ambiguous = 0
    capped = 0
    for n, items in reqs.items():
        cand = sorted(resps.get(n, []))
        for ts, path, raw in items:
            ok = [c for c in cand if ts <= c[0] <= ts + MAX_STREAM_S]
            if len(ok) == 1:
                # The body read is the other measured cost (one open per pair).
                # Past the bound the pair is counted as capped, NEVER silently
                # dropped: a truncated window that reports itself complete is
                # the same lie as a glob returning an empty set.
                if len(pairs) >= max_pairs:
                    capped += 1
                    continue
                pairs.append((read_requested_model(path), ok[0][1], raw, ok[0][2]))
            elif not ok:
                unmatched += 1
            else:
                ambiguous += 1
    return pairs, {"requests": sum(len(v) for v in reqs.values()),
                   "responses": sum(len(v) for v in resps.values()),
                   "matched": len(pairs), "unmatched": unmatched, "ambiguous": ambiguous,
                   "capped": capped}


def aggregate(pairs):
    """role -> plan -> count, plus the served-model detail per role."""
    by_role = defaultdict(Counter)
    served = defaultdict(Counter)
    for req_model, served_model, _ts, _rts in pairs:
        role = role_of(req_model)
        by_role[role][plan_of(served_model)] += 1
        served[role][served_model] += 1
    return by_role, served


def render(by_role, served, stats, hours):
    out = []
    out.append(f"PAYG by role — last {hours} h (capture pairs)")
    out.append(f"pairs: {stats['matched']} matched / {stats['requests']} requests "
               f"({stats['unmatched']} unmatched, {stats['ambiguous']} ambiguous"
               + (f", {stats['capped']} CAPPED - raise --max-pairs" if stats.get("capped") else "")
               + ")")
    out.append("")
    out.append(f"{'role':8} {'n':>6} {'payg':>6} {'payg%':>6}  plans")
    for role in sorted(by_role, key=lambda r: -sum(by_role[r].values())):
        plans = by_role[role]
        n = sum(plans.values())
        payg = plans.get("payg", 0)
        share = f"{100.0 * payg / n:5.1f}%" if n else "    -"
        detail = " · ".join(f"{k}={v}" for k, v in plans.most_common())
        out.append(f"{role:8} {n:6d} {payg:6d} {share:>6}  {detail}")
    out.append("")
    out.append("served model per role:")
    for role in sorted(served, key=lambda r: -sum(served[r].values())):
        detail = " · ".join(f"{k}={v}" for k, v in served[role].most_common(6))
        out.append(f"  {role:8} {detail}")
    return "\n".join(out)


def selftest():
    """Synthetic corpus: one clean pair, one cross-day impostor (#48), one unmatched."""
    with tempfile.TemporaryDirectory() as d:
        def write(name, body=b""):
            with open(os.path.join(d, name), "wb") as f:
                f.write(body)

        ts_req = "2026-10-28T00-49-38-569Z"
        write(f"req-1-10100-{ts_req}-direct.json",
              b'{"model":"claude-sonnet-5-5","max_tokens":128000}')
        write("resp-1-r10100-2026-10-28T00-49-47-162Z-openai-glm-5.3.sse", b"data: {}\n\n")
        # trap #48: same N, different day — must NOT be paired
        write("resp-1-r10100-2026-10-27T07-15-21-921Z-openai-deepseek-flash.sse", b"data: {}\n\n")
        # a haiku served by PAYG, clean pair
        write("req-1-10101-2026-10-28T00-50-00-000Z-direct.json",
              b'{"model":"claude-haiku-5-5","max_tokens":64000}')
        write("resp-1-r10101-2026-10-28T00-50-02-000Z-openai-deepseek-flash.sse", b"data: {}\n\n")
        # unmatched request: no response at all
        write("req-1-10102-2026-10-28T00-51-00-000Z-direct.json",
              b'{"model":"claude-opus-5-5","max_tokens":64000}')

        since = parse_ts("2026-10-28T00-00-00-000Z")
        until = parse_ts("2026-10-29T00-00-00-000Z")
        pairs, stats = scan(d, since, until)
        by_role, _served = aggregate(pairs)

        fails = []
        if stats["matched"] != 2:
            fails.append(f"expected 2 matched pairs, got {stats['matched']}")
        if stats["unmatched"] != 1:
            fails.append(f"expected 1 unmatched, got {stats['unmatched']}")
        if stats["ambiguous"] != 0:
            fails.append(f"expected 0 ambiguous, got {stats['ambiguous']}")
        if by_role["sonnet"].get("prepaid") != 1:
            fails.append("sonnet must be 1 prepaid (glm-5.3)")
        if by_role["haiku"].get("payg") != 1:
            fails.append("haiku must be 1 payg (deepseek-flash)")
        # the cross-day resp must not leak into sonnet as payg
        if by_role["sonnet"].get("payg"):
            fails.append("trap #48: the 27/10 impostor was paired")
        # the plan table must not read the prepaid alias as PAYG
        if plan_of("deepseek-v4.1-flash-1017") != "prepaid":
            fails.append("qwen prepaid alias classified as PAYG")
        if plan_of("deepseek-v4-flash") != "payg":
            fails.append("condensation model not classified as PAYG")

        if fails:
            print("SELFTEST FAIL")
            for f in fails:
                print("  -", f)
            return 2
        print("SELFTEST OK — 6 pins (2 pairs, 1 unmatched, trap #48, alias, condensation)")
        return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="PAYG share per role, from capture pairs")
    ap.add_argument("--captures", default=r"D:/claudish-captures")
    ap.add_argument("--hours", type=float, default=24.0)
    ap.add_argument("--max-pairs", type=int, default=4000,
                    help="bound on request-body reads (one open per pair); "
                         "overflow is reported as CAPPED, never dropped silently")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--print-table", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    if args.print_table:
        for k in sorted(PLAN):
            print(f"{k:28} {PLAN[k]}")
        return 0

    now = time.time()
    since = now - args.hours * 3600
    pairs, stats = scan(args.captures, since, now, max_pairs=args.max_pairs)
    if not pairs:
        print("no capture pair in the window — a quiet dir and an unreadable dir "
              "look alike, check --captures before concluding 'no PAYG'")
        return 2
    by_role, served = aggregate(pairs)
    if args.json:
        print(json.dumps({
            "hours": args.hours, "stats": stats,
            "by_role": {r: dict(c) for r, c in by_role.items()},
            "served": {r: dict(c) for r, c in served.items()},
        }, indent=2))
    else:
        print(render(by_role, served, stats, args.hours))
    return 0


if __name__ == "__main__":
    sys.exit(main())
