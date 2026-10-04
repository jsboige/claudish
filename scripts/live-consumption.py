#!/usr/bin/env python3
r"""live-consumption.py — consumption snapshot by machine:workspace:session (Epic #41 v0).

Consolidates the 2026-10-02 bricks (decompose_minimax.py, multiday_7z.py) into
the ONE dimension the committed organs did not already cover. The consolidation
was done the way this repo defines it — each brick function analysed, then
matched against what already ships, so that only the real gap is written here:

  brick function                         already shipped as
  -------------------------------------  ---------------------------------------
  req index by (pid, counter)            traffic-consumption.py load_requests()
                                         + traffic-mxws.py pass 1
  usage MAX per field across blocks      traffic-consumption.py usage_max(),
                                         traffic-mxws.py pass 2, compaction-trend.py
  nearest-ts req<->resp join             traffic-consumption.py pick_request()
  machine x workspace x model rollup      traffic-mxws.py aggregate (incl. 7z days)
  session attribution                     billed-attrib.py — NATIVE lane only
  ---------------------------------------------------------------- gap, written here
  machine:workspace:SESSION, ALL LANES
  subagent split                          decompose_minimax.py took it from a
                                         CaptureUtils CSV column; NOT reused —
                                         see the trap below

Two traps encoded, both measured elsewhere in this repo:

1. `cc_is_subagent` must come from PARSING `metadata.user_id` as JSON. The head
   of a capture under-counts it and a whole-body grep over-counts it (any echo
   of the harness rule text matches) — only the parse tells the truth. A
   user_id that does not parse yields NO session and NO subagent verdict; it is
   counted as `unattributed`, never guessed at.
2. (pid, reqN) is not unique — the counter restarts with the container — so the
   key maps to a DATED LIST and the join picks the latest candidate that
   precedes its response.

Read-only. Emits a JSON snapshot and a markdown digest; the markdown is what an
hourly task is meant to drop where a human will see it.

Usage:
  python scripts/live-consumption.py [capture_dir] [--hours 3] [--json out.json] [--md out.md]
"""
import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

REQ_NAME = re.compile(r"^req-(\d+)-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})")
RESP_NAME = re.compile(r"^resp-(\d+)-r?(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})")
MACHINE_RE = re.compile(r'"machine"\s*:\s*"([^"]*)"')
WORKDIR_RE = re.compile(r"Primary working directory:\s*(.+?)\\n")
SEP_RE = re.compile(r"[\\/]+")
USAGE_RX = re.compile(r'"usage"\s*:\s*\{([^}]*)\}')
FIELD_RX = re.compile(
    r'"(input_tokens|cache_read_input_tokens|cache_creation_input_tokens|output_tokens)"\s*:\s*(\d+)')
# Three attribution markers at three depths, measured on 254 sampled captures
# over a 2 h hub window: the ENVELOPE (`machine`) opens the file; the workspace
# marker (`Primary working directory`, first occurrence inside messages) sits in
# the MIDDLE at p50 267 KB / p95 351 KB — `messages` itself starts around byte
# 200, but the conversation turns precede the message that carries the marker;
# and `body.metadata.user_id` closes the body, near the end. A head-only read
# measured 4 559 captures as `unattributed` (user_id lost); a 256 KB head then
# left a large share of attributed captures with workspace `-` (marker inside
# the dropped middle of files p50 649 KB / p95 899 KB). Hence a DEEP head that
# must reach the workdir marker, plus a short tail that only has to reach the
# trailing metadata. What the dropped middle of >640 KB files holds is later
# conversation turns, which nothing here reads.
HEAD_BYTES = 512 * 1024
TAIL_BYTES = 128 * 1024


def ts_of(m):
    """`2026-10-04T21-09-18` -> aware datetime (UTC). The capture name spells the
    ISO timestamp with dashes in the time part."""
    return datetime.strptime(m.group(3) + "Z", "%Y-%m-%dT%H-%M-%SZ").replace(tzinfo=timezone.utc)


def extract_usage(text):
    """MAX per counter across every usage block. GLM (openai wire) emits a ZERO
    block before the real one, so first-wins under-reports by the whole turn."""
    best = {"input_tokens": 0, "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0, "output_tokens": 0}
    for blk in USAGE_RX.findall(text):
        for k, v in FIELD_RX.findall(blk):
            v = int(v)
            if v > best[k]:
                best[k] = v
    return best


def user_id_fields(uid):
    """Parse `body.metadata.user_id` — a JSON STRING — for its attribution.

    Returns (session_id, is_subagent) with None for anything not established:
    a regex fallback would re-open the trap the docstring describes."""
    if not uid:
        return None, None
    try:
        d = json.loads(uid)
    except (json.JSONDecodeError, TypeError):
        return None, None
    if not isinstance(d, dict):
        return None, None
    sess = d.get("session_id")
    sub = d.get("is_subagent")
    if sub is None:
        sub = d.get("cc_is_subagent")
    return (sess[:12] if isinstance(sess, str) else None,
            bool(sub) if sub is not None else None)


# The marker string is ECHOED in conversation prose — quoted rule text, harness
# summaries — and an echo captures a sentence fragment, not the path (measured
# live: workspace values like `CoursIA)` or a whole clause, splitting one
# session across two rows). Only an absolute path is accepted; echoes are
# skipped and the scan continues to the next occurrence.
PATHISH_RE = re.compile(r"^[A-Za-z]:[\\/][^()<>|?*{}'\"]*$")


def workspace_of(raw):
    for m in WORKDIR_RE.finditer(raw):
        val = m.group(1).strip()
        if not PATHISH_RE.match(val):
            continue
        seg = SEP_RE.split(val)[-1]
        if seg:
            return seg
    return None


def pick_request(candidates, resp_ts):
    """The request PRECEDES its response: latest candidate whose ts <= resp_ts,
    else the earliest one (a clock skew must not silently drop the pair)."""
    if not candidates:
        return None
    prior = [c for c in candidates if c[0] <= resp_ts]
    if prior:
        return max(prior, key=lambda c: c[0])[1]
    return min(candidates, key=lambda c: c[0])[1]


def read_capped(path, head=HEAD_BYTES, tail=TAIL_BYTES):
    """Head + tail. See HEAD_BYTES for why one end is not enough. A file shorter
    than the sum is returned whole, so small fixtures behave as before."""
    size = os.path.getsize(path)
    # Binary mode: text mode refuses a nonzero end-relative seek, and the tail is
    # the whole point of this function.
    with open(path, "rb") as f:
        if size <= head + tail:
            blob = f.read()
        else:
            first = f.read(head)
            f.seek(-tail, os.SEEK_END)
            blob = first + f.read()
    return blob.decode("utf-8", errors="replace")


def collect(capture_dir, hours, head=HEAD_BYTES, tail=TAIL_BYTES):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    reqs = defaultdict(list)
    resps = []
    unattributed = 0
    for name in os.listdir(capture_dir):
        path = os.path.join(capture_dir, name)
        if not os.path.isfile(path):
            continue
        rm = REQ_NAME.match(name)
        if rm and name.endswith(".json"):
            try:
                ts = ts_of(rm)
            except ValueError:
                continue
            if ts < cutoff:
                continue
            raw = read_capped(path, head, tail)
            mm = MACHINE_RE.search(raw)
            env = mm.group(1) if mm else None
            uid = None
            uid_m = re.search(r'"user_id"\s*:\s*"((?:[^"\\]|\\.)*)"', raw)
            if uid_m:
                try:
                    uid = json.loads('"' + uid_m.group(1) + '"')
                except json.JSONDecodeError:
                    uid = None
            sess, sub = user_id_fields(uid)
            if sess is None:
                unattributed += 1
            reqs[(int(rm.group(1)), int(rm.group(2)))].append(
                (ts, {"machine": env or "(direct)", "ws": workspace_of(raw) or "-",
                      "session": sess or "unattributed", "sub": sub}))
            continue
        sm = RESP_NAME.match(name)
        if sm and name.endswith(".sse"):
            try:
                ts = ts_of(sm)
            except ValueError:
                continue
            if ts < cutoff:
                continue
            resps.append((ts, int(sm.group(1)), int(sm.group(2)),
                          extract_usage(read_capped(path, head, tail))))

    rows = []
    for ts, pid, reqn, usage in resps:
        info = pick_request(reqs.get((pid, reqn)), ts)
        if info is None:
            continue
        rows.append((info, usage))
    return rows, unattributed


def rollup(rows):
    per = defaultdict(lambda: {"n": 0, "in": 0, "out": 0, "cread": 0, "ccre": 0,
                               "main": 0, "subagent": 0, "unknown": 0})
    for info, u in rows:
        key = f"{info['machine']}:{info['ws']}:{info['session']}"
        r = per[key]
        r["n"] += 1
        r["in"] += u["input_tokens"]
        r["out"] += u["output_tokens"]
        r["cread"] += u["cache_read_input_tokens"]
        r["ccre"] += u["cache_creation_input_tokens"]
        r["main" if info["sub"] is False else
          "subagent" if info["sub"] is True else "unknown"] += 1
    return per


def to_markdown(per, hours, unattributed):
    tot_out = sum(r["out"] for r in per.values())
    tot_n = sum(r["n"] for r in per.values())
    lines = [f"# Live consumption — {hours}h window",
             "",
             f"- sessions/rows: **{len(per)}**  ·  responses: **{tot_n}**  ·  OUT tokens: **{tot_out:,}**",
             f"- captures with an unparseable `user_id` (counted `unattributed`, never guessed): **{unattributed}**",
             "",
             "| machine:workspace:session | resp | in | out | cache_read | cache_cre | main/sub |",
             "|---|---:|---:|---:|---:|---:|---|"]
    for key in sorted(per, key=lambda k: -per[k]["out"])[:40]:
        r = per[key]
        lines.append(f"| {key} | {r['n']} | {r['in']:,} | {r['out']:,} | "
                     f"{r['cread']:,} | {r['ccre']:,} | {r['main']}/{r['subagent']} |")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("capture_dir", nargs="?", default=r"D:\claudish-captures")
    ap.add_argument("--hours", type=float, default=3.0)
    ap.add_argument("--json", dest="json_out")
    ap.add_argument("--md", dest="md_out")
    args = ap.parse_args(argv)
    rows, unattributed = collect(args.capture_dir, args.hours)
    per = rollup(rows)
    md = to_markdown(per, args.hours, unattributed)
    print(md)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({"hours": args.hours, "unattributed": unattributed,
                       "sessions": per}, f, indent=2, sort_keys=True)
    if args.md_out:
        with open(args.md_out, "w", encoding="utf-8") as f:
            f.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
