#!/usr/bin/env python3
"""Cache-read share per served lane, over the hub's loose response captures.

#886 — "what costs us on the OpenAI lane: cache misses on input, or output?"
The before/after instrument of the Codex session-affinity fix: the same
per-response reading, over a time window, for every lane whose name matches.

WHAT IT READS
-------------
Response captures only (`resp-<pid>-r<N>-<YYYY-MM-DDTHH-MM-SS-mmm>Z-<lane>.sse`). The usage of
one response is `message_start.usage` updated by the terminal
`message_delta.usage`; its prompt is the sum of the three DISJOINT counters

    input_tokens + cache_creation_input_tokens + cache_read_input_tokens

and its cache share is `cache_read / prompt`. A response whose prompt is 0
(an aborted stream, an error body) is not counted.

Never prints prompt or tool content — lane names and numbers only. Reads the
directory with os.scandir (no sorted listing, no glob): the capture directory
holds hundreds of thousands of files.

OUTPUT
------
One line per lane: responses, prompt total, mean prompt, aggregate cache-read
share, per-response p10/p50/p90 share, responses at exactly 0, output tokens.
`--hourly` adds one line per UTC hour. `--rates IN,CACHED,OUT` (credits or
price per 1M tokens, e.g. `50,2.5,250` for GPT-6.1 Sol on the ChatGPT plan)
adds the weighted split of the lane's spend between uncached input, cached
input and output.

A lane whose responses NEVER report a cache read (vLLM on the OpenAI wire)
is flagged: 0 % there is the instrument, not a miss.

    python -I scripts/lane-cache-share.py D:\\claudish-captures \\
        2026-11-05T00-00-00 2026-11-06T00-00-00 --lane 'gpt-6.1-sol' --rates 50,2.5,250
    python -I scripts/lane-cache-share.py --self-test
"""
import argparse
import json
import os
import re
import sys
import tempfile
from collections import defaultdict

RESP = re.compile(r"^resp-(\d+)-r(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})[^-]*-[^-]*Z-(.+)\.sse$")


def usage(path):
    """message_start.usage, overridden key by key by the terminal message_delta.usage."""
    start, delta = None, None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line.startswith("data:"):
                continue
            try:
                o = json.loads(line[5:])
            except ValueError:
                continue
            if not isinstance(o, dict):
                continue
            if o.get("type") == "message_start":
                start = (o.get("message") or {}).get("usage")
            elif o.get("type") == "message_delta":
                delta = o.get("usage")
    u = dict(start or {})
    u.update(delta or {})
    return u


def collect(cdir, since, until, lane_re):
    rows = defaultdict(list)  # lane -> [(ts, prompt, cache_read, output)]
    with os.scandir(cdir) as it:
        for e in it:
            m = RESP.match(e.name)
            if not m or not (since <= m.group(3) < until) or not lane_re.search(m.group(4)):
                continue
            u = usage(e.path)
            fresh = u.get("input_tokens") or 0
            cr = u.get("cache_read_input_tokens") or 0
            cw = u.get("cache_creation_input_tokens") or 0
            prompt = fresh + cr + cw
            if prompt:
                rows[m.group(4)].append((m.group(3), prompt, cr, u.get("output_tokens") or 0))
    return rows


def quantile(values, p):
    v = sorted(values)
    return v[min(len(v) - 1, int(p * len(v)))] if v else 0


def report(rows, hourly=False, rates=None):
    lines = []
    for lane, r in sorted(rows.items(), key=lambda x: -len(x[1])):
        n = len(r)
        prompt = sum(x[1] for x in r)
        cr = sum(x[2] for x in r)
        out = sum(x[3] for x in r)
        shares = [100 * x[2] / x[1] for x in r]
        zero = sum(1 for x in r if x[2] == 0)
        line = (f"{lane}: n={n} prompt={prompt} mean_prompt={prompt // n} cache_read={100 * cr / prompt:.1f}% "
                f"per-resp p10/p50/p90={quantile(shares, .1):.0f}/{quantile(shares, .5):.0f}/{quantile(shares, .9):.0f}% "
                f"zero-cache={zero} out={out} out/resp={out // n}")
        if cr == 0:
            line += "  [NO response on this lane reports a cache read: 0% is the instrument, not a miss]"
        lines.append(line)
        if rates:
            r_in, r_cached, r_out = rates
            w_un = (prompt - cr) / 1e6 * r_in
            w_cr = cr / 1e6 * r_cached
            w_out = out / 1e6 * r_out
            tot = w_un + w_cr + w_out
            if tot:
                lines.append(f"   weighted spend: uncached input {100 * w_un / tot:.1f}% | "
                             f"cached input {100 * w_cr / tot:.1f}% | output {100 * w_out / tot:.1f}%")
        if hourly:
            hours = defaultdict(lambda: [0, 0, 0])
            for ts, p, c, _ in r:
                h = hours[ts[:13]]
                h[0] += 1
                h[1] += p
                h[2] += c
            for h, (hn, hp, hc) in sorted(hours.items()):
                lines.append(f"   {h}Z n={hn} cache_read={100 * hc / hp:.0f}%")
    return lines


def self_test():
    # normalize_bound: colon and Z spellings must land on the capture format.
    assert normalize_bound("2026-11-06T00:02:00Z") == "2026-11-06T00-02-00"
    assert normalize_bound("2026-11-06T00:02:00") == "2026-11-06T00-02-00"
    assert normalize_bound("2026-11-06T00-02-00") == "2026-11-06T00-02-00"
    assert normalize_bound("2026-11-06") == "2026-11-06"
    def sse(path, start_usage, delta_usage):
        with open(path, "w", encoding="utf-8") as f:
            f.write("event: message_start\n")
            f.write("data: " + json.dumps({"type": "message_start", "message": {"usage": start_usage}}) + "\n\n")
            f.write("event: message_delta\n")
            f.write("data: " + json.dumps({"type": "message_delta", "usage": delta_usage}) + "\n\n")

    with tempfile.TemporaryDirectory() as d:
        t = "2026-11-05T10-00-00"
        # lane A: 2 responses, 1000 prompt each; one 75 % cached, one 0 %
        sse(os.path.join(d, f"resp-1-r1-{t}-000Z-responses-sol.sse"),
            {"input_tokens": 0}, {"input_tokens": 250, "cache_read_input_tokens": 750, "output_tokens": 10})
        sse(os.path.join(d, f"resp-1-r2-{t}-000Z-responses-sol.sse"),
            {"input_tokens": 1000}, {"output_tokens": 30})
        # lane B: never reports a cache read
        sse(os.path.join(d, f"resp-1-r3-{t}-000Z-openai-swift.sse"),
            {"input_tokens": 500}, {"output_tokens": 5})
        # out of window, and an empty-prompt response: both ignored
        sse(os.path.join(d, "resp-1-r4-2026-11-04T10-00-00-000Z-responses-sol.sse"),
            {"input_tokens": 999}, {})
        sse(os.path.join(d, f"resp-1-r5-{t}-000Z-responses-sol.sse"), {}, {})
        rows = collect(d, "2026-11-05T00-00-00", "2026-11-06T00-00-00", re.compile("."))
        assert sorted(rows) == ["openai-swift", "responses-sol"], rows
        assert len(rows["responses-sol"]) == 2, rows
        out = report(rows, rates=(50, 2.5, 250))
        sol = next(x for x in out if x.startswith("responses-sol"))
        assert "cache_read=37.5%" in sol, sol  # 750 / 2000
        assert "zero-cache=1" in sol, sol
        swift = next(x for x in out if x.startswith("openai-swift"))
        assert "0% is the instrument" in swift, swift
        # weighted: uncached 1250*50=62500, cached 750*2.5=1875, out 40*250=10000 (per 1M scale cancels)
        w = next(x for x in out if "weighted" in x and out.index(x) == out.index(sol) + 1)
        assert "uncached input 84.0%" in w, w
    print("self-test OK")


def normalize_bound(v):
    """Accept both capture-format bounds (YYYY-MM-DDTHH-MM-SS) and the
    ISO-habit spellings (T HH:MM:SS, optional trailing Z). The window test is
    a plain string compare against the file-name timestamp, so a colon-form
    bound silently excludes whole hours — measured 06/11: a `T00:02:00Z`
    since dropped every hour-00 capture of the window, hiding the entire
    gpt-6.1-sol failover lane (00:02-00:28) behind "no response with a
    non-zero prompt in the window"."""
    v = v.strip()
    if v.endswith("Z"):
        v = v[:-1]
    head, sep, tail = v.partition("T")
    if sep and ":" in tail:
        tail = tail.replace(":", "-")
    return head + sep + tail


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("captures", nargs="?")
    ap.add_argument("since", nargs="?", help="capture timestamp, YYYY-MM-DDTHH-MM-SS (UTC; HH:MM:SS also accepted), inclusive")
    ap.add_argument("until", nargs="?", help="capture timestamp, exclusive; same formats as since")
    ap.add_argument("--lane", default=".", help="regex on the served-lane suffix of the file name")
    ap.add_argument("--hourly", action="store_true")
    ap.add_argument("--rates", help="IN,CACHED,OUT per 1M tokens — adds the weighted spend split")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args(argv)
    if a.self_test:
        self_test()
        return 0
    if not (a.captures and a.since and a.until):
        ap.error("captures, since and until are required (or --self-test)")
    rates = None
    if a.rates:
        parts = [float(x) for x in a.rates.split(",")]
        if len(parts) != 3:
            ap.error("--rates takes three numbers: IN,CACHED,OUT")
        rates = tuple(parts)
    rows = collect(a.captures, normalize_bound(a.since), normalize_bound(a.until), re.compile(a.lane))
    if not rows:
        print("no response with a non-zero prompt in the window")
        return 1
    for line in report(rows, hourly=a.hourly, rates=rates):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
