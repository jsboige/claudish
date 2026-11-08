#!/usr/bin/env python3
r"""swarm-signal.py — alert-only subagent-swarm detector (#317 option 3).

Emits a WARN when ONE session's subagent traffic exceeds a sustained rate or
a daily total. Signal only: it never throttles, never kills, never mutates
anything — enforcement is options 1/2 of #317 and stays a user decision (the
"caps par essaim" registry question, ai-01 T#144 action 4, is still open).
Thresholds are parameters, not policy.

The bricks are REUSED from live-consumption.py (imported by path, same
pattern as its own test) — do not re-derive them here:

  billing_fields_of(raw)   3-state subagent verdict from the
                           x-anthropic-billing-header segment:
                           cc_is_subagent=true -> True, header without the
                           flag -> False (main), no header -> None (unknown).
                           LAST occurrence wins: an echo quoted in the
                           conversation comes before the real system block
                           (#334 B1).
  scan_billing_file(path)  chunked whole-file fallback for the captures
                           whose header sits in the dropped middle between
                           the capped head and tail reads.
  user_id_session(uid)     session id from body.metadata.user_id (the one
                           field that string really carries — trap 1).
  read_capped, REQ_NAME, MACHINE_RE, WORKLOAD_RE, ts_of.

Why the sliding rate and NOT a session count (measured 27/09 swarm, issue
#317 c.6025976638, VERIFIÉ on captures-2026-09-27.7z, 1-in-150 sample of
13:00→21:00Z): subagents SHARE the parent's session_id — the swarm device
showed 7 distinct sessions in a 0.67% sample where per-subagent ids would
have shown ~300. The detectable signal is the sustained THROUGHPUT of
marked requests per (machine, session): the 27/09 swarm ran 40→120 marked
req/min for 8 h on one session (peak 15h), while interactive and cycle
traffic stays under ~10/min bursts. Defaults: WARN at >=30 marked req/min
averaged over a >=10-min sliding window, or >=5000 marked reqs per session
over the WHOLE SCANNED WINDOW — an order of magnitude under the measured
swarm, comfortably above the noise.

Two semantics stated plainly (they were fuzzy names first):
- the rate rule is an AVERAGE over the window, not "sustained every
  minute": 300 marked reqs inside one 10-min window trip it even if a
  1-min burst carried them. A good proxy for the 27/09 shape, not a
  minute-level throttle measurement.
- the second rule counts the TOTAL over the scanned window (--since ..
  --until), NOT per calendar day: a session spread across several days of
  concatenated extractions trips it once on the window total.

--sample-factor scales measured rates when the input directory holds a
sampled extraction (e.g. 150 for a 1-in-150 retrospective probe); it is
displayed in every verdict so a scaled number can never pose as exhaustive.

Read-only. Exit 0 always — a WARN is a signal, not a failure state.
"""

import argparse
import importlib.util
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "live_consumption", os.path.join(_HERE, "live-consumption.py"))
lc = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(lc)

REQ_NAME = lc.REQ_NAME
MACHINE_RE = lc.MACHINE_RE
WORKLOAD_RE = lc.WORKLOAD_RE

MODEL_RE = re.compile(r'"model"\s*:\s*"([^"]*)"')

DEFAULT_RATE = 30.0          # marked req/min, averaged over the sliding window
DEFAULT_WINDOW_MIN = 10      # sliding window length in minutes
DEFAULT_WINDOW_TOTAL = 5000  # marked reqs per session over the WHOLE scanned window


def parse_iso(s):
    if not s:
        return None
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def collect_swarm_rows(capture_dir, since=None, until=None):
    """Req-only pass — no resp join, no usage: the swarm signal is the
    request stream itself. Returns (rows, stats) where each row is
    (ts, machine, session, sub, workload, model); ts comes from the FILE
    NAME (same source as ts_of), never from body content."""
    rows = []
    stats = {"files": 0, "marked": 0, "main": 0, "unknown": 0,
             "unattributed": 0, "billing_fallback": 0, "outside_window": 0}
    for name in os.listdir(capture_dir):
        if not name.endswith(".json"):
            continue
        rm = REQ_NAME.match(name)
        if rm is None:
            continue
        path = os.path.join(capture_dir, name)
        if not os.path.isfile(path):
            continue
        try:
            ts = lc.ts_of(rm)
        except ValueError:
            continue
        if since and ts < since:
            stats["outside_window"] += 1
            continue
        if until and ts > until:
            stats["outside_window"] += 1
            continue
        raw = lc.read_capped(path)
        mm = MACHINE_RE.search(raw)
        machine = mm.group(1) if mm else "(direct)"
        uid_m = re.search(r'"user_id"\s*:\s*"((?:[^"\\]|\\.)*)"', raw)
        uid = None
        if uid_m:
            try:
                uid = json.loads('"' + uid_m.group(1) + '"')
            except json.JSONDecodeError:
                uid = None
        session = lc.user_id_session(uid)
        if session is None:
            stats["unattributed"] += 1
        billing = lc.billing_fields_of(raw)
        if billing is None:
            billing = lc.scan_billing_file(path)
            if billing is not None:
                stats["billing_fallback"] += 1
        sub = billing["sub"] if billing else None
        wl_m = WORKLOAD_RE.search(raw)
        workload = wl_m.group(1) if wl_m else (billing or {}).get("workload")
        models = MODEL_RE.findall(raw)
        model = models[-1] if models else "?"
        stats["files"] += 1
        if sub is True:
            stats["marked"] += 1
        elif sub is False:
            stats["main"] += 1
        else:
            stats["unknown"] += 1
        rows.append((ts, machine, session or "unattributed", sub,
                     workload, model))
    rows.sort(key=lambda r: r[0])
    return rows, stats


def peak_window_rate(ts_list, window_min):
    """Max marked-request count inside any sliding window of window_min,
    anchored on each event (a maximal window always starts at an event).
    Returns (peak_count, window_start)."""
    if not ts_list:
        return 0, None
    span = timedelta(minutes=window_min)
    best, best_ts = 0, None
    j = 0
    for i, t in enumerate(ts_list):
        while ts_list[j] < t - span:
            j += 1
        n = i - j + 1
        if n > best:
            best, best_ts = n, ts_list[j]
    return best, best_ts


def verdicts(rows, stats, rate=DEFAULT_RATE, window_min=DEFAULT_WINDOW_MIN,
             window_total=DEFAULT_WINDOW_TOTAL, sample_factor=1.0):
    """Group by (machine, session), apply the two WARN rules. `unknown`
    subagent state never counts toward a verdict — it is published in the
    digest so a silent header-parser regression stays visible. Marked reqs
    WITHOUT an attributable session are counted (`unattributed_marked` in
    stats, surfaced in the digest) but never verdict-keyed: there is no
    reliable key to warn on, and a parse regression must not silence the
    visible counter by hiding behind one."""
    per = defaultdict(list)
    models = defaultdict(Counter)
    for ts, machine, session, sub, workload, model in rows:
        if sub is True:
            if session == "unattributed":
                stats["unattributed_marked"] = stats.get("unattributed_marked", 0) + 1
                continue
            per[(machine, session)].append(ts)
            models[(machine, session)][model] += 1
    out = []
    for (machine, session), ts_list in per.items():
        total = len(ts_list) * sample_factor
        peak_n, peak_ts = peak_window_rate(ts_list, window_min)
        peak_rate = peak_n * sample_factor / window_min
        hit_rate = peak_rate >= rate
        hit_total = total >= window_total
        if not (hit_rate or hit_total):
            continue
        span = (ts_list[0], ts_list[-1])
        out.append({
            "machine": machine, "session": session,
            "warn": "rate" if hit_rate else "window-total",
            "marked_total": int(total),
            "peak_rate_per_min": round(peak_rate, 1),
            "peak_window_start": peak_ts.isoformat() if peak_ts else None,
            "peak_window_min": window_min,
            "first_marked": span[0].isoformat(),
            "last_marked": span[1].isoformat(),
            "top_models": dict(models[(machine, session)].most_common(3)),
        })
    out.sort(key=lambda v: -v["peak_rate_per_min"])
    return out


def to_markdown(v_list, stats, args):
    lines = [f"**[WARN] swarm-signal — {len(v_list)} session(s) over threshold**",
             f"dir: `{args.capture_dir}` · rate ≥ {args.rate}/min "
             f"(**average over a {args.window_min}-min sliding window**) · "
             f"window total ≥ {args.window_total} (whole scanned window, NOT per-day)"]
    if args.sample_factor != 1.0:
        lines.append(f"⚠ SAMPLED input — rates scaled ×{args.sample_factor:g} "
                     f"(extraction sample, not exhaustive counts)")
    for v in v_list:
        lines.append(
            f"- `{v['machine']}` session `{v['session']}…` — **{v['peak_rate_per_min']}/min** "
            f"peak (window {v['peak_window_min']} min from {v['peak_window_start']}), "
            f"{v['marked_total']} marked total "
            f"[{v['first_marked']} → {v['last_marked']}], "
            f"rule={v['warn']}, models={v['top_models']}")
    lines.append(f"\nscanned: {stats['files']} req (marked {stats['marked']}, "
                 f"main {stats['main']}, unknown {stats['unknown']}, "
                 f"unattributed {stats['unattributed']}"
                 + (f", **unattributed_marked {stats['unattributed_marked']} "
                    f"(marked traffic with no session key — never verdict-keyed)**"
                    if stats.get("unattributed_marked") else "")
                 + (f", header-chunk-fallback {stats['billing_fallback']}" if stats['billing_fallback'] else "")
                 + ")")
    return "\n".join(lines)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--capture-dir", required=True,
                   help="directory of req-*.json (loose day or extracted archive)")
    p.add_argument("--since", help="ISO UTC, inclusive lower bound on file ts")
    p.add_argument("--until", help="ISO UTC, inclusive upper bound on file ts")
    p.add_argument("--rate", type=float, default=DEFAULT_RATE,
                   help="WARN threshold, marked req/min averaged over the sliding window (default %(default)s)")
    p.add_argument("--window-min", type=int, default=DEFAULT_WINDOW_MIN,
                   help="sliding window length in minutes (default %(default)s)")
    p.add_argument("--window-total", type=int, default=DEFAULT_WINDOW_TOTAL,
                   help="WARN threshold, marked reqs per session over the WHOLE scanned window, not per-day (default %(default)s)")
    p.add_argument("--sample-factor", type=float, default=1.0,
                   help="scale rates/totals when the dir holds a sampled extraction (e.g. 150)")
    p.add_argument("--json", action="store_true", help="emit JSON instead of markdown")
    args = p.parse_args(argv)

    rows, stats = collect_swarm_rows(args.capture_dir,
                                     since=parse_iso(args.since),
                                     until=parse_iso(args.until))
    v = verdicts(rows, stats, rate=args.rate, window_min=args.window_min,
                 window_total=args.window_total, sample_factor=args.sample_factor)
    if args.json:
        print(json.dumps({"verdicts": v, "stats": stats,
                          "params": {"rate": args.rate,
                                     "window_min": args.window_min,
                                     "window_total": args.window_total,
                                     "sample_factor": args.sample_factor}},
                         indent=2))
    else:
        if v:
            print(to_markdown(v, stats, args))
        else:
            extra = (f", unattributed_marked {stats['unattributed_marked']}"
                     if stats.get("unattributed_marked") else "")
            print(f"swarm-signal: no session over threshold "
                  f"(scanned {stats['files']} req, marked {stats['marked']}{extra})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
