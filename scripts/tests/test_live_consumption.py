#!/usr/bin/env python3
r"""Pins for live-consumption.py (Epic #41 v0).

Each case carries a POSITIVE CONTROL: the failure modes here are silent
under-counts — a function that matches nothing, or that reads the first usage
block instead of the largest, still "runs fine" and reports a smaller number
that looks like a quiet window. So every negative assertion is paired with a
count that must be non-zero.

Run standalone:  python scripts/tests/test_live_consumption.py
Or under pytest: pytest scripts/tests/test_live_consumption.py
"""

import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "live_consumption", os.path.join(_HERE, "..", "live-consumption.py"))
lc = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(lc)

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def test_usage_takes_max_not_first():
    text = ('{"usage":{"input_tokens":0,"output_tokens":0,'
            '"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'
            '{"usage":{"input_tokens":120,"output_tokens":45,'
            '"cache_read_input_tokens":900,"cache_creation_input_tokens":30}}')
    u = lc.extract_usage(text)
    check("usage: MAX wins over the leading zero block",
          u == {"input_tokens": 120, "output_tokens": 45,
                "cache_read_input_tokens": 900, "cache_creation_input_tokens": 30}, u)
    single = lc.extract_usage('{"usage":{"input_tokens":7,"output_tokens":3}}')
    check("usage: positive control — a single real block is read",
          single["input_tokens"] == 7 and single["output_tokens"] == 3, single)


def test_user_id_parse_and_the_echo_trap():
    uid = json.dumps({"device_id": "abc123", "session_id": "0123456789abcdef",
                      "is_subagent": True})
    sess, sub = lc.user_id_fields(uid)
    # session_id is deliberately shortened to 12 chars for the rollup key.
    check("user_id: parses session + subagent",
          sess == "0123456789abcdef"[:12] and sub is True, (sess, sub))
    # The trap: an echoed harness rule mentioning cc_is_subagent must NOT be read
    # as a subagent verdict — it does not parse as JSON, so it yields nothing.
    echoed = "cc_is_subagent=true is the leak signature … (rule text)"
    sess2, sub2 = lc.user_id_fields(echoed)
    check("user_id: an unparseable/echoed string yields NO verdict",
          sess2 is None and sub2 is None, (sess2, sub2))
    check("user_id: and never a guessed subagent=True", sub2 is not True, sub2)
    sess3, sub3 = lc.user_id_fields("")
    check("user_id: empty yields nothing", sess3 is None and sub3 is None, (sess3, sub3))
    # main-vs-subagent must stay distinguishable from "unknown"
    sess4, sub4 = lc.user_id_fields(json.dumps({"session_id": "ffffffffffff"}))
    check("user_id: absent flag is None (unknown), not False (main)",
          sess4 == "ffffffffffff" and sub4 is None, (sess4, sub4))


def test_pick_request_prefers_the_preceding_one():
    t = lambda h: datetime(2026, 10, 4, h, tzinfo=timezone.utc)
    cands = [(t(10), {"session": "a"}), (t(12), {"session": "b"}), (t(14), {"session": "c"})]
    got = lc.pick_request(cands, t(13))
    check("pairing: latest candidate PRECEDING the response", got["session"] == "b", got)
    check("pairing: positive control — a later candidate is never picked",
          got["session"] != "c", got)
    skew = lc.pick_request([(t(14), {"session": "c"})], t(10))
    check("pairing: clock skew falls back to the earliest, dropping nothing",
          skew == {"session": "c"}, skew)
    check("pairing: no candidates -> None", lc.pick_request([], t(10)) is None)


def test_workspace_extraction():
    raw = 'x "Primary working directory: D:\\\\dev\\\\claudish\\n" y'
    check("workspace: last path segment", lc.workspace_of(raw) == "claudish",
          lc.workspace_of(raw))
    check("workspace: positive control — a doc without the marker yields None",
          lc.workspace_of("no marker here") is None)


def test_end_to_end_rollup():
    with tempfile.TemporaryDirectory() as d:
        # One request and its response, same (pid, reqN), response after request.
        req = ("req-1-0007-2026-10-04T21-09-18-851Z-direct.json")
        resp = ("resp-1-r0007-2026-10-04T21-09-20-100Z-openai-glm-5.3.sse")
        uid = json.dumps({"session_id": "abcdefabcdef", "is_subagent": False})
        # A real capture spells the marker with a JSON-escaped newline; write the
        # fixture through json.dump so the escaping is the capture's, not ours.
        workdir = "Primary working directory: D:\\dev\\claudish\n"
        with open(os.path.join(d, req), "w", encoding="utf-8") as f:
            json.dump({"machine": "myia-po-2025", "pid": 1,
                       "body": {"metadata": {"user_id": uid},
                                "messages": [{"content": [{"text": workdir}]}]}},
                      f)
        with open(os.path.join(d, resp), "w", encoding="utf-8") as f:
            f.write('{"usage":{"input_tokens":10,"output_tokens":5}}')
        rows, unattributed = lc.collect(d, hours=24 * 365 * 10)
        check("e2e: the pair joined (positive control — a broken join gives 0)",
              len(rows) == 1, len(rows))
        per = lc.rollup(rows)
        key = "myia-po-2025:claudish:abcdefabcdef"
        check("e2e: keyed machine:workspace:session", key in per, list(per))
        if key in per:
            check("e2e: tokens carried", per[key]["out"] == 5 and per[key]["in"] == 10, per[key])
            check("e2e: main/subagent split", per[key]["main"] == 1, per[key])
        check("e2e: nothing counted unattributed", unattributed == 0, unattributed)

        md = lc.to_markdown(per, 1, unattributed)
        check("e2e: markdown names the row", key in md)
        check("e2e: markdown states the unattributed count", "unattributed" in md)


if __name__ == "__main__":
    for fn in (test_usage_takes_max_not_first, test_user_id_parse_and_the_echo_trap,
               test_pick_request_prefers_the_preceding_one, test_workspace_extraction,
               test_end_to_end_rollup):
        print(f"== {fn.__name__}")
        fn()
    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} -> {FAILS}")
        sys.exit(1)
    print("all pins green")
