#!/usr/bin/env python3
"""Compaction census over hub captures: how many Claude Code compactions, on which served lane,
at what cache share, and how much of each lane's output they account for.

Wire shape (measured 05/11/2026 on CC 2.1.31x, docs/reference/compaction-on-the-wire.md): a
compaction request is the main conversation re-sent unchanged (same messages, tools, model,
effort) with an instruction block appended to the LAST user message. It is detected by two
built-in instruction phrases, both inside that last user message's text blocks. The older marker
"create a detailed summary of the conversation" does not match this shape.

Join trap (instrument-pieges §48): the hub's request counter restarts with the container, so a
(pid, reqN) pair can name several response files in one window. Each request is joined to the
FIRST response with the same (pid, reqN) that ends at or after the request, within 30 minutes.

Prints counts, token numbers, served lane and idle gap. Never prints prompt or tool content.

    python scripts/compaction-census.py D:\\claudish-captures 2026-11-05T08-00-00 2026-11-05T12-30-00 --denominator
    python scripts/compaction-census.py --self-test
"""
import argparse
import json
import os
import re
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime

REQ = re.compile(r"^req-(\d+)-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})")
RESP = re.compile(r"^resp-(\d+)-r(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})[^-]*-[^-]*Z-(.+)\.sse$")
MARKS = ("conversation so far", "do not call any tools")
JOIN_WINDOW_S = 1800
IDLE_MIN = 50


def ts(s):
    return datetime.strptime(s, "%Y-%m-%dT%H-%M-%S")


def is_compaction(body):
    """True when the LAST user message's text blocks carry both instruction phrases."""
    msgs = body.get("messages") or []
    last = next((m for m in reversed(msgs) if isinstance(m, dict) and m.get("role") == "user"), None)
    if last is None:
        return False
    c = last.get("content")
    if isinstance(c, list):
        txt = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    else:
        txt = c or ""
    low = txt.lower()
    return all(k in low for k in MARKS)


def session_of(body):
    uid = (body.get("metadata") or {}).get("user_id") or ""
    m = re.search(r'"session_id":\s*"([0-9a-f]{8})', uid) or re.search(r"session_([0-9a-f]{8})", uid)
    return m.group(1) if m else "nosid"


def usage(path):
    """message_start usage merged with the terminal message_delta usage (the delta wins)."""
    st, dl = None, None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if not line.startswith("data:"):
                    continue
                try:
                    o = json.loads(line[5:])
                except ValueError:
                    continue
                if o.get("type") == "message_start":
                    st = (o.get("message") or {}).get("usage")
                elif o.get("type") == "message_delta":
                    dl = o.get("usage")
    except OSError:
        return None
    u = dict(st or {})
    u.update(dl or {})
    return u


def scan(cdir, since, until):
    reqs, resps = [], {}
    with os.scandir(cdir) as it:
        for e in it:
            m = REQ.match(e.name)
            if m and since <= m.group(3) < until:
                reqs.append((m.group(3), m.group(1), int(m.group(2)), e.path))
                continue
            r = RESP.match(e.name)
            if r and since <= r.group(3):  # a response ends after its request: no upper bound
                resps.setdefault((r.group(1), int(r.group(2))), []).append((r.group(3), e.path, r.group(4)))
    reqs.sort()
    return reqs, resps


def pick(resps, pid, n, req_ts):
    """First response with the same (pid, reqN) ending at or after the request, within the window."""
    best = None
    for end, path, lane in resps.get((pid, n), []):
        if end >= req_ts and (ts(end) - ts(req_ts)).total_seconds() <= JOIN_WINDOW_S:
            if best is None or end < best[0]:
                best = (end, path, lane)
    return (best[1], best[2]) if best else None


def census(cdir, since, until, denominator, out=sys.stdout):
    reqs, resps = scan(cdir, since, until)
    last_seen, hits, per_mach = {}, [], Counter()
    for req_ts, pid, n, p in reqs:
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                env = json.load(f)
        except (OSError, ValueError):
            continue
        body = env.get("body") if isinstance(env, dict) else None
        if not isinstance(body, dict):
            continue
        mach = env.get("machine") or "?"
        per_mach[mach] += 1
        key = (mach, session_of(body))
        if is_compaction(body):
            prev = last_seen.get(key)
            gap = (ts(req_ts) - ts(prev)).total_seconds() / 60 if prev else None
            hits.append((req_ts, mach, key[1], pid, n, env.get("model"), len(body.get("messages") or []), gap))
        last_seen[key] = req_ts

    print("window", since, "->", until, "| req files", len(reqs),
          "| resp files", sum(len(v) for v in resps.values()),
          "| (pid,reqN) keys with >1 resp (counter restart)", sum(1 for v in resps.values() if len(v) > 1), file=out)
    print("requests per machine", dict(per_mach.most_common()), file=out)
    print("compaction requests", len(hits), file=out)
    agg = defaultdict(Counter)
    for req_ts, mach, sid, pid, n, model, nm, gap in hits:
        rp = pick(resps, pid, n, req_ts)
        u = usage(rp[0]) if rp else None
        lane = rp[1] if rp else "no-resp"
        fresh = (u or {}).get("input_tokens") or 0
        cr = (u or {}).get("cache_read_input_tokens") or 0
        cw = (u or {}).get("cache_creation_input_tokens") or 0
        o = (u or {}).get("output_tokens") or 0
        tot = fresh + cr + cw
        print(f"  {req_ts[11:]} {mach:13} {sid} r{n} asked={model} served={lane} msgs={nm} "
              f"in={tot} cache_read={cr} ({(100 * cr / tot if tot else 0):.0f}%) cache_write={cw} out={o} "
              f"gap_min={'%.0f' % gap if gap is not None else 'first-seen'}", file=out)
        a = agg[lane]
        a["n"] += 1
        a["in"] += tot
        a["cr"] += cr
        a["out"] += o
        if gap is not None and gap >= IDLE_MIN:
            a["idle"] += 1
    den = defaultdict(Counter)
    if denominator:
        for req_ts, pid, n, _p in reqs:
            rp = pick(resps, pid, n, req_ts)
            if not rp:
                den["no-resp"]["n"] += 1
                continue
            u = usage(rp[0]) or {}
            d = den[rp[1]]
            d["n"] += 1
            cr = u.get("cache_read_input_tokens") or 0
            d["in"] += (u.get("input_tokens") or 0) + cr + (u.get("cache_creation_input_tokens") or 0)
            d["cr_nonzero"] += 1 if cr else 0
            d["out"] += u.get("output_tokens") or 0
    print(f"by served lane (compaction | all requests in window if --denominator; idle = gap >= {IDLE_MIN} min):", file=out)
    for lane in sorted(set(agg) | set(den), key=lambda x: -agg[x]["n"] if x in agg else 0):
        a, d = agg[lane], den[lane]
        share = ""
        if d["in"] and d["out"]:
            share = (f" | all n={d['n']} in={d['in']} out={d['out']} -> compaction share "
                     f"in={100 * a['in'] / d['in']:.1f}% out={100 * a['out'] / d['out']:.1f}%")
            if d["n"] and not d["cr_nonzero"]:
                share += " | NO response on this lane reports a cache read: 0% is the instrument, not a miss"
        print(f"  {lane:45} n={a['n']:3} in={a['in']} cache_read%={(100 * a['cr'] / a['in'] if a['in'] else 0):.0f} "
              f"out={a['out']} idle={a['idle']}{share}", file=out)
    return hits, agg, den


def _write(d, name, obj, sse=False):
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        if sse:
            for o in obj:
                f.write("data: " + json.dumps(o) + "\n\n")
        else:
            json.dump(obj, f)


def self_test():
    """Synthetic corpus pinning the two traps: last-user-message-only detection, time-based join."""
    instr = "Your task is to create a summary of the conversation so far. Do not call any tools."
    with tempfile.TemporaryDirectory() as d:
        def req(n, t, sid, msgs):
            _write(d, f"req-1-{n}-{t}-000Z-x.json", {"machine": "m1", "model": "claude-opus-5-5", "body": {
                "metadata": {"user_id": json.dumps({"session_id": sid + "-0000"})}, "messages": msgs}})

        def resp(n, t, lane, cr, out):
            _write(d, f"resp-1-r{n}-{t}-000Z-{lane}.sse", [
                {"type": "message_start", "message": {"usage": {"input_tokens": 10, "cache_read_input_tokens": cr}}},
                {"type": "message_delta", "usage": {"output_tokens": out}}], sse=True)
        u = lambda text: {"role": "user", "content": [{"type": "text", "text": text}]}
        a = {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}
        # 1: ordinary turn. 2: compaction. 3: instruction quoted in an EARLIER user message -> not one.
        req(1, "2026-11-05T10-00-00", "aaaaaaaa", [u("hello")])
        req(2, "2026-11-05T11-00-00", "aaaaaaaa", [u("hello"), a, u(instr)])
        req(3, "2026-11-05T11-10-00", "bbbbbbbb", [u(instr), a, u("next")])
        resp(1, "2026-11-05T10-00-05", "native-x", 90, 5)
        # counter restart: an OLDER resp-1-r2 from the previous container life must not be picked
        resp(2, "2026-11-05T10-59-59", "wrong-lane", 0, 999)
        resp(2, "2026-11-05T11-03-00", "native-x", 990, 50)
        resp(3, "2026-11-05T11-10-04", "native-x", 90, 5)
        sink = open(os.devnull, "w")
        hits, agg, den = census(d, "2026-11-05T00-00-00", "2026-11-06T00-00-00", True, out=sink)
        sink.close()
        assert len(hits) == 1 and hits[0][4] == 2, hits
        assert hits[0][7] == 60.0, hits[0]  # idle gap from the previous request of the same session
        assert "wrong-lane" not in agg and agg["native-x"]["out"] == 50, dict(agg)
        assert agg["native-x"]["idle"] == 1
        assert den["native-x"]["n"] == 3 and den["native-x"]["out"] == 60, dict(den)
    print("self-test OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("captures", nargs="?")
    ap.add_argument("since", nargs="?", help="capture timestamp, e.g. 2026-11-05T08-00-00")
    ap.add_argument("until", nargs="?")
    ap.add_argument("--denominator", action="store_true", help="also total every request of the window per served lane")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        self_test()
        return
    if not (args.captures and args.since and args.until):
        ap.error("captures, since and until are required")
    census(args.captures, args.since, args.until, args.denominator)


if __name__ == "__main__":
    main()
