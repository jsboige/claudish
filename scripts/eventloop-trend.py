#!/usr/bin/env python3
"""Event-loop lag series reader — the single reader of eventloop-blocked.log.

The sampler (scripts/eventloop-sampler.ps1) appends one NDJSON line a minute:
`{ts, probe, status, role, instanceId, uptimeSec, activeStreams, max60sMs,
blocked5mMs, maxCumulativeMs}`. This script answers the three questions that
motivated the series (#739 item b):

  * WHEN did the hub stall?          -> episodes (ticks over the proxy's own
                                        250 ms [EventLoop] log threshold)
  * HOW LONG did it stay stalled?    -> blocked5mMs, the five-minute sum
  * was the SAMPLER alive at all?    -> tick coverage + probe failures

Reading rules that change a verdict
-----------------------------------
* `maxCumulativeMs` is a high-water mark SINCE PROCESS START: it never falls,
  and one GC pause pins it forever. It dates nothing on its own — an episode is
  dated by `max60sMs`, never by a rise in the cumulative mark.
* `max60sMs` is a 60 s windowed max that RETIRES. Sampled once a minute, one
  window can retire unread; `blocked5mMs` (five-minute window) is the durable
  field. An hourly max over `max60sMs` is therefore a LOWER BOUND, and this
  script says `>=` rather than pretending otherwise.
* A GAP IN TICKS IS NOT A CALM PERIOD. A missing minute is reported as a hole
  (see `--gaps`), never averaged into the hour as if it had been measured.
* A `probe:"fail"` tick means the sampler RAN and /health did not answer —
  distinct from the sampler not running at all, which shows as a missing tick.
* Rows are grouped by `instanceId` inside an hour: a recreate splits a series,
  and mixing two processes' cumulative marks into one column invents a jump.

Usage
-----
  python scripts/eventloop-trend.py                    # last 24 h, hourly
  python scripts/eventloop-trend.py --hours 72
  python scripts/eventloop-trend.py --episodes         # every tick >= 250 ms
  python scripts/eventloop-trend.py --gaps --hours 12
  python scripts/eventloop-trend.py --include-rotated
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

DEFAULT_LOG = os.path.join(os.path.expanduser("~"), ".claudish", "eventloop-blocked.log")

# The proxy's own LAG_LOG_THRESHOLD_MS (proxy-server.ts): the value at which it
# writes a `[EventLoop]` line. Using the same number keeps the file series and
# the docker log joinable on one threshold instead of inventing a second one.
EPISODE_THRESHOLD_MS = 250.0

# Sampler cadence, for gap detection. A hole is only claimed beyond this.
EXPECTED_INTERVAL_SEC = 60
GAP_FACTOR = 2.5


def parse_ts(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def read_rows(path, include_rotated):
    paths = [path]
    if include_rotated:
        for i in sorted(range(1, 10), reverse=True):
            cand = f"{path}.{i}"
            if os.path.exists(cand):
                paths.insert(0, cand)

    rows, bad = [], 0
    for p in paths:
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        bad += 1
                        continue
                    ts = parse_ts(obj.get("ts"))
                    if ts is None:
                        bad += 1
                        continue
                    obj["_ts"] = ts
                    rows.append(obj)
        except FileNotFoundError:
            continue
    rows.sort(key=lambda r: r["_ts"])
    # A rotated file plus the live one can overlap; keep one row per instant.
    seen, deduped = set(), []
    for r in rows:
        key = (r["_ts"], r.get("instanceId"), r.get("probe"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    return deduped, bad


def num(value):
    return value if isinstance(value, (int, float)) else None


def fmt(v, suffix=""):
    return "—" if v is None else f"{v:g}{suffix}"


def hourly(rows, hours):
    if not rows:
        print("no samples in the file — the sampler never ran, or the path is wrong")
        return
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    window = [r for r in rows if r["_ts"] >= cutoff]
    if not window:
        print(f"no sample in the last {hours} h (last sample {rows[-1]['ts']})")
        return

    buckets = defaultdict(list)
    for r in window:
        buckets[r["_ts"].strftime("%Y-%m-%d %H:00")].append(r)

    print(f"event-loop lag — hourly, last {hours} h ({len(window)} samples)")
    print("hour(UTC)        n  fail  max60s>=  blocked5m>=  cumulMax  instances  first..last")
    for hour in sorted(buckets):
        rs = buckets[hour]
        ok = [r for r in rs if r.get("probe") == "ok"]
        fails = len(rs) - len(ok)
        m60 = [num(r.get("max60sMs")) for r in ok]
        m60 = [v for v in m60 if v is not None]
        b5 = [num(r.get("blocked5mMs")) for r in ok]
        b5 = [v for v in b5 if v is not None]
        cum = [num(r.get("maxCumulativeMs")) for r in ok]
        cum = [v for v in cum if v is not None]
        inst = {r.get("instanceId") for r in ok if r.get("instanceId")}
        print(
            f"{hour}  {len(rs):3d}  {fails:4d}  "
            f"{fmt(max(m60) if m60 else None, ' ms'):>9}  "
            f"{fmt(max(b5) if b5 else None, ' ms'):>11}  "
            f"{fmt(max(cum) if cum else None, ' ms'):>8}  "
            f"{len(inst):9d}  {rs[0]['_ts']:%H:%M}..{rs[-1]['_ts']:%H:%M}"
        )
    print()
    print("max60s/blocked5m columns are LOWER bounds: a 60 s window can retire "
          "between two 60 s ticks; blocked5m is the durable one.")
    recreated = len({r.get("instanceId") for r in window if r.get("instanceId")})
    if recreated > 1:
        print(f"⚠ {recreated} distinct instanceId in the window — a recreate splits "
              "the series; maxCumulativeMs is per-process and does not compare across them.")


def episodes(rows, since):
    hot = [r for r in rows if r["_ts"] >= since
           and r.get("probe") == "ok"
           and (num(r.get("max60sMs")) or 0) >= EPISODE_THRESHOLD_MS]
    if not hot:
        print(f"no tick over {EPISODE_THRESHOLD_MS:g} ms — the loop never blocked "
              "long enough for the proxy to log one either")
        return 0
    print(f"{len(hot)} tick(s) with max60s >= {EPISODE_THRESHOLD_MS:g} ms "
          f"(the proxy's own [EventLoop] log threshold)")
    print("ts(UTC)                    max60s   blocked5m  cumul   streams  instance")
    for r in hot:
        print(f"{r['ts']}  {fmt(num(r.get('max60sMs')),' ms'):>8}  "
              f"{fmt(num(r.get('blocked5mMs')),' ms'):>9}  "
              f"{fmt(num(r.get('maxCumulativeMs')),' ms'):>7}  "
              f"{fmt(num(r.get('activeStreams'))):>7}  "
              f"{(r.get('instanceId') or '')[:8]}")
    return len(hot)


def gaps(rows, since):
    rs = [r for r in rows if r["_ts"] >= since]
    if len(rs) < 2:
        print("not enough samples to look for holes")
        return
    limit = EXPECTED_INTERVAL_SEC * GAP_FACTOR
    holes = 0
    for prev, cur in zip(rs, rs[1:]):
        delta = (cur["_ts"] - prev["_ts"]).total_seconds()
        if delta > limit:
            holes += 1
            print(f"HOLE {prev['ts']} -> {cur['ts']}  ({delta:.0f} s unmeasured)")
    if holes == 0:
        print(f"no hole > {limit:.0f} s in the window — the sampler ran continuously")
    else:
        print(f"{holes} hole(s): a missing minute is UNMEASURED, never 'calm'.")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Read the event-loop lag series.")
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--hours", type=float, default=24.0)
    ap.add_argument("--include-rotated", action="store_true")
    ap.add_argument("--episodes", action="store_true", help="list ticks over the 250 ms threshold")
    ap.add_argument("--gaps", action="store_true", help="list unmeasured holes")
    ap.add_argument("--raw", action="store_true")
    args = ap.parse_args(argv)

    rows, bad = read_rows(args.log, args.include_rotated)
    if not rows:
        print(f"no samples under {args.log}")
        return 2
    since = datetime.now(timezone.utc) - timedelta(hours=args.hours)

    if args.raw:
        for r in rows:
            if r["_ts"] >= since:
                print(json.dumps({k: v for k, v in r.items() if k != "_ts"}, ensure_ascii=False))
        return 0

    hourly(rows, args.hours)
    if args.episodes:
        print()
        episodes(rows, since)
    if args.gaps:
        print()
        gaps(rows, since)
    if bad:
        print(f"\n⚠ {bad} unparseable line(s) skipped — the sampler writes one JSON "
              "object per line; a torn line means a write was interrupted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
