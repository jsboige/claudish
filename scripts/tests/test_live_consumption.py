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
    # Measured live: the marker is ECHOED in prose (quoted rule text, harness
    # summaries), yielding values like `CoursIA)` or a whole clause — which
    # split one session across two rows. Echoes are skipped, scanning continues.
    echo_first = ('prose "Primary working directory: D:\\\\Dev\\\\CoursIA)\\n" '
                  'then the real "Primary working directory: D:\\\\dev\\\\claudish\\n"')
    check("workspace: an echoed marker yielding a non-path is skipped",
          lc.workspace_of(echo_first) == "claudish", lc.workspace_of(echo_first))
    clause = '"Primary working directory: continue` cron prompt remains.\\n"'
    check("workspace: a clause echo yields None, never a sentence row",
          lc.workspace_of(clause) is None, lc.workspace_of(clause))
    spaced = '"Primary working directory: C:\\\\Users\\\\jsboi\\\\some dir\\\\proj\\n"'
    check("workspace: spaces inside a real path stay valid",
          lc.workspace_of(spaced) == "proj", lc.workspace_of(spaced))


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


def test_attribution_at_the_far_end_is_still_read():
    """Measured on the live corpus: a head-only read reported 4 559 captures as
    `unattributed` over 2 h, because `metadata` comes AFTER `messages` and
    `tools` while `Primary working directory` sits in messages[0]. The two ends
    are read for exactly this. The head-only pass below is the NEGATIVE CONTROL:
    if it ever starts finding the session too, this pin has stopped testing
    anything and the seam it guards is gone."""
    with tempfile.TemporaryDirectory() as d:
        req = "req-1-0009-2026-10-04T21-09-18-851Z-direct.json"
        uid = json.dumps({"session_id": "deadbeefcafe", "is_subagent": False})
        workdir = "Primary working directory: D:\\dev\\claudish\n"
        # Written by hand, not via json.dump, so the key ORDER is the capture's:
        # messages (huge) first, metadata last.
        with open(os.path.join(d, req), "w", encoding="utf-8") as f:
            f.write('{"machine":"myia-po-2025","pid":1,"body":{"messages":[{"content":'
                    '[{"text":' + json.dumps(workdir) + '},'
                    '{"text":' + json.dumps("P" * 40_000) + '}]}],'
                    '"metadata":{"user_id":' + json.dumps(uid) + '}}}')
        resp = "resp-1-r0009-2026-10-04T21-09-20-100Z-openai-glm-5.3.sse"
        with open(os.path.join(d, resp), "w", encoding="utf-8") as f:
            f.write('{"usage":{"output_tokens":3}}')

        rows, _ = lc.collect(d, hours=24 * 365 * 10, head=4096, tail=4096)
        per = lc.rollup(rows)
        check("far-end: session found with a two-ended read",
              "myia-po-2025:claudish:deadbeefcafe" in per, list(per))

        rows_h, unatt = lc.collect(d, hours=24 * 365 * 10, head=4096, tail=0)
        per_h = lc.rollup(rows_h)
        check("far-end: NEGATIVE CONTROL — head-only really does lose it",
              unatt == 1 and "myia-po-2025:claudish:deadbeefcafe" not in per_h,
              (unatt, list(per_h)))


def test_workdir_marker_in_the_dropped_middle():
    """Measured live: the workspace marker sits at p50 267 KB inside `messages`
    (conversation turns precede the message carrying it), while `messages`
    starts around byte 200 — so a head too shallow loses the workspace on
    captures p50 649 KB even though it finds machine and session. The shallow
    pass below is the NEGATIVE CONTROL: if it ever starts finding the workspace
    too, this pin has stopped testing the seam."""
    with tempfile.TemporaryDirectory() as d:
        req = "req-1-0011-2026-10-04T22-30-00-000Z-direct.json"
        uid = json.dumps({"session_id": "feedfacefeed", "is_subagent": False})
        # pad pushes the marker past a 256 KB head; tailpad makes the file big
        # enough that the marker lands in the range a shallow head+tail drops.
        pad = "x" * 300_000
        tailpad = "y" * 200_000
        body = ('{"machine":"myia-po-2025","pid":1,"body":{"messages":'
                '[{"content":['
                '{"text":' + json.dumps(pad) + '},'
                '{"text":' + json.dumps("Primary working directory: D:\\dev\\claudish\n") + '}]},'
                '{"content":[{"text":' + json.dumps(tailpad) + '}]}],'
                '"metadata":{"user_id":' + json.dumps(uid) + '}}}')
        with open(os.path.join(d, req), "w", encoding="utf-8") as f:
            f.write(body)
        resp = "resp-1-r0011-2026-10-04T22-30-05-000Z-openai-glm-5.3.sse"
        with open(os.path.join(d, resp), "w", encoding="utf-8") as f:
            f.write('{"usage":{"output_tokens":2}}')

        rows, _ = lc.collect(d, hours=24 * 365 * 10)
        per = lc.rollup(rows)
        check("middle: default caps find the workspace",
              "myia-po-2025:claudish:feedfacefeed" in per, list(per))

        rows_s, _ = lc.collect(d, hours=24 * 365 * 10, head=256 * 1024, tail=128 * 1024)
        per_s = lc.rollup(rows_s)
        check("middle: NEGATIVE CONTROL — a shallow head loses the workspace",
              "myia-po-2025:-:feedfacefeed" in per_s
              and "myia-po-2025:claudish:feedfacefeed" not in per_s, list(per_s))


if __name__ == "__main__":
    for fn in (test_usage_takes_max_not_first, test_user_id_parse_and_the_echo_trap,
               test_pick_request_prefers_the_preceding_one, test_workspace_extraction,
               test_end_to_end_rollup, test_attribution_at_the_far_end_is_still_read,
               test_workdir_marker_in_the_dropped_middle):
        print(f"== {fn.__name__}")
        fn()
    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} -> {FAILS}")
        sys.exit(1)
    print("all pins green")
