#!/usr/bin/env python3
"""Pins for traffic-consumption.py `--harness-lanes` (#1055 g1, follow-up to PR #1059).

The harness-lane rollup reads the capture ENVELOPE field `lane` (written
unconditionally since #1055: `""` = no lane header, key ABSENT = pre-#1055
capture) and groups by `"<lane> | <machine>"` — the lane alone cannot tell two
seats carrying the same harness apart, the machine alone cannot tell the
harness from the rest of the seat.

Pinned here:
1. Two requests of one lane on one seat aggregate into ONE key with the bucket
   split preserved (cron / interactive / agent-sdk).
2. A lane-less request (`"lane": ""`) and a pre-#1055 request (no key at all)
   are EXCLUDED from the rollup — but still counted in the main table (the
   rollup is a lens, not a filter).
3. The envelope bounding survives its trap: a `"lane"` occurrence PLANTED IN
   THE BODY of a pre-#1055 capture must not create a rollup key. The search
   stops at `"body"` for exactly this reason — without the bound, a web tool
   result quoting `"lane": "evil"` would win the first-match scan.
4. Without the flag the JSON carries `harness_lanes: null` — the pre-#1055
   output shape is byte-identical.
5. With the flag and NO carrier, the text report NAMES the absence instead of
   rendering nothing (an absent table reads as a 0).

Mutation proof expected: dropping the `head.find('"body"')` bound makes pin 3
fail (the planted lane wins); removing the `if info.get("hlane")` guard makes
pin 2 fail; not passing `args.harness_lanes` through makes pins 1/5 fail.

Run: python scripts/tests/test_traffic_consumption_harness_lanes.py
"""

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(_HERE, "..", "traffic-consumption.py")

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def _ts(minutes_ago):
    """The writer's filename timestamp: `2026-11-15T01-10-11-203Z` (dashes)."""
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime(
        "%Y-%m-%dT%H-%M-%S-000Z")


def write_pair(cdir, pid, n, served_model, out_tokens, lane=None):
    """One req-*.json + one resp-*.sse, paired by (pid, reqN) and time.

    `lane=None` omits the envelope key entirely (pre-#1055 capture); the body
    always carries a planted `"lane": "evil"` so the bounding pin has its trap
    on every capture (post-#1055 captures simply carry their own lane first —
    the regex takes the FIRST match, which is the envelope one).
    """
    req_ts = _ts(30)
    resp_ts = _ts(29)
    envelope = {
        "ts": req_ts,
        "src": "direct",
        "machine": "myia-po-2028",
        "model": "nb-minimax",
    }
    if lane is not None:
        envelope["lane"] = lane
    envelope["pid"] = pid
    envelope["instanceId"] = "abcdef12"
    envelope["entrypoint"] = "cli"
    envelope["workload"] = "cron"
    envelope["hops"] = []
    # The planted occurrence AFTER "body" — the bounding pin's trap. It must be
    # a NESTED OBJECT, not a string: a string field serializes with escaped
    # quotes (`{\"lane\": \"evil\"}`) and the regex would not match it at all —
    # the first fixture version did exactly that and the M1 mutation SURVIVED
    # (a trap that cannot bite proves nothing). Measured: nested object ⇒
    # literal `"lane":"evil"` on disk ⇒ M1 goes red.
    body = {"messages": [{"role": "user", "content": [
        {"type": "text", "text": "hi", "lane": "evil"}]}]}
    payload = dict(envelope)
    payload["body"] = body
    with open(os.path.join(cdir, f"req-{pid}-{n:04d}-{req_ts}-direct.json"), "w",
              encoding="utf-8") as fh:
        json.dump(payload, fh)

    with open(os.path.join(cdir, f"resp-{pid}-r{n:04d}-{resp_ts}-anthropic-sse.sse"),
              "w", encoding="utf-8") as fh:
        fh.write(f"# parser=anthropic-sse model={served_model} reqN={n} pid={pid}\n")
        fh.write('data: {"type":"message_delta","usage":{"input_tokens":67,'
                 '"cache_read_input_tokens":244800,'
                 f'"cache_creation_input_tokens":0,"output_tokens":{out_tokens}}}}}\n')


def run_json(cdir, *extra):
    p = subprocess.run(
        [sys.executable, SCRIPT, "--hours", "24", "--dir", cdir, "--json", *extra],
        capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        print(p.stdout)
        print(p.stderr)
        raise SystemExit(f"traffic-consumption.py --json exited {p.returncode}")
    return json.loads(p.stdout)


def run_text(cdir, *extra):
    p = subprocess.run(
        [sys.executable, SCRIPT, "--hours", "24", "--dir", cdir, *extra],
        capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        print(p.stdout)
        print(p.stderr)
        raise SystemExit(f"traffic-consumption.py exited {p.returncode}")
    return p.stdout


cdir = tempfile.mkdtemp(prefix="tc-hlanes-")
try:
    # Pin 1 + 2: two nb-coder requests on one seat (cron bucket by default in
    # write_pair), one nb-luna, one lane-less (""), one pre-#1055 (no key).
    write_pair(cdir, 1111, 1, "MiniMax-M3.1-Flash", 123, lane="nb-coder")
    write_pair(cdir, 1111, 2, "MiniMax-M3.1-Flash", 77, lane="nb-coder")
    write_pair(cdir, 1111, 3, "gpt-6-luna", 40, lane="nb-luna")
    write_pair(cdir, 1111, 4, "MiniMax-M3.1-Flash", 55, lane="")
    write_pair(cdir, 1111, 5, "MiniMax-M3.1-Flash", 11)  # pre-#1055: no key

    data = run_json(cdir, "--harness-lanes")
    hl = data.get("harness_lanes")
    check("--harness-lanes --json emits the section", isinstance(hl, dict), f"(got {type(hl)})")

    key = "nb-coder | myia-po-2028"
    check(f"one aggregate key {key!r}", key in (hl or {}), f"(keys: {sorted(hl or {})})")
    tot = {k: sum(b[k] for b in (hl or {}).get(key, {}).values())
           for k in ("n", "inp", "out", "cread", "ccre")} if key in (hl or {}) else {}
    check("nb-coder n=2 (two requests, one seat)", tot.get("n") == 2, f"(got {tot.get('n')})")
    check("nb-coder out=200 (123+77 summed)", tot.get("out") == 200, f"(got {tot.get('out')})")
    check("nb-coder inp=134 (67x2 coherent triples)", tot.get("inp") == 134, f"(got {tot.get('inp')})")
    check("nb-coder cread=489600", tot.get("cread") == 489600, f"(got {tot.get('cread')})")
    cron = (hl or {}).get(key, {}).get("cron")
    check("bucket split preserved (cron n=2)", cron is not None and cron["n"] == 2,
          f"(got {cron})")

    luna = (hl or {}).get("nb-luna | myia-po-2028")
    check("nb-luna keyed separately", luna is not None and luna["cron"]["n"] == 1,
          f"(got {luna})")

    # Pin 3: the body-planted lane never becomes a key (bounding).
    check("planted body lane NOT a rollup key",
          not any("evil" in k for k in (hl or {})), f"(keys: {sorted(hl or {})})")

    # Pin 2: lens, not filter — all five requests stay in the main table.
    main_n = sum(b["n"] for lane_d in data["lanes"].values() for b in lane_d.values())
    check("main table still counts all 5 requests", main_n == 5, f"(got {main_n})")
    hl_n = sum(b["n"] for lane_d in (hl or {}).values() for b in lane_d.values())
    check("rollup counts only the 3 carriers", hl_n == 3, f"(got {hl_n})")

    # Pin 4: without the flag the JSON shape is pre-#1055.
    data_no = run_json(cdir)
    check("without the flag: harness_lanes is null", data_no.get("harness_lanes") is None,
          f"(got {data_no.get('harness_lanes')!r})")

    # Pin 5: flag + no carrier = the absence is NAMED, not rendered as nothing.
    bare = tempfile.mkdtemp(prefix="tc-hlanes-bare-")
    try:
        write_pair(bare, 2222, 1, "MiniMax-M3.1-Flash", 9, lane="")
        txt = run_text(bare, "--harness-lanes")
        check("empty rollup names the absence",
              "aucune requete porteuse de lane harnais dans la fenetre" in txt,
              "(line absent)")
        check("empty rollup still renders its header",
              "== par lane harnais (#1055) ==" in txt, "(header absent)")
    finally:
        for fn in os.listdir(bare):
            os.remove(os.path.join(bare, fn))
        os.rmdir(bare)
finally:
    for fn in os.listdir(cdir):
        os.remove(os.path.join(cdir, fn))
    os.rmdir(cdir)

print()
if FAILS:
    print(f"FAILED: {len(FAILS)} -> {FAILS}")
    sys.exit(1)
print("all pins green")