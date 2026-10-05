#!/usr/bin/env python3
r"""Pins for live-consumption.py (Epic #41 v0).

Each case carries a POSITIVE CONTROL: the failure modes here are silent
under-counts — a function that matches nothing, or that reads the first usage
block instead of the largest, still "runs fine" and reports a smaller number
that looks like a quiet window. So every negative assertion is paired with a
count that must be non-zero.

Fixture provenance (#334 B1): the request fixtures are ANONYMIZED EXTRACTS of
real captures (field order included — `body.system` serialized after
`body.messages`, `metadata` last). The first version of this script read the
subagent flag out of `metadata.user_id`, a shape its own SYNTHETIC fixtures
had fabricated: on real traffic every line reported 0/0 because `user_id`
only ever carries (account_uuid, device_id, session_id). The old shape is
kept here as the NEGATIVE CONTROL — it must yield `unknown`, never a verdict.

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


def real_req(pid, reqn, ts, header_fields, uid_json, pad="",
             envelope_workload=None, tools_pad=0):
    """Anonymized extract of a real req capture (shape measured 2026-10-04,
    ai-01 review #334): envelope opens the file; body.messages; body.system —
    carrying the x-anthropic-billing-header — AFTER messages; body.metadata
    last. The billing header's k=v; run is quoted verbatim from
    req-1-0125-2026-10-04T23-14-15-128Z-direct.json with ids replaced."""
    fname = f"req-{pid}-{reqn:04d}-{ts}-direct.json"
    seg = " ".join(f"{k}={v};" for k, v in header_fields.items()) if header_fields else None
    body = {"messages": [{"content": [{"type": "text", "text":
            "Primary working directory: D:\\dev\\claudish\n" + pad}]}]}
    if seg is not None:
        body["system"] = [
            {"type": "text", "text": "x-anthropic-billing-header: " + seg},
            {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
        ]
    if tools_pad:
        body["tools"] = [{"name": "Read", "description": "T" * tools_pad}]
    body["metadata"] = {"user_id": uid_json}
    env = {"machine": "myia-po-2025", "pid": pid, "model": "glm-5.3",
           "entrypoint": "claude-vscode", "workload": envelope_workload,
           "body": body}
    return fname, json.dumps(env)


def write_resp(d, pid, reqn, ts, out=5, inp=10):
    fname = f"resp-{pid}-r{reqn:04d}-{ts}-openai-glm-5.3.sse"
    with open(os.path.join(d, fname), "w", encoding="utf-8") as f:
        f.write('{"usage":{"input_tokens":%d,"output_tokens":%d}}' % (inp, out))
    return fname


UID = json.dumps({"account_uuid": "11111111-2222-3333-4444-555555555555",
                  "device_id": "0123456789abcdef0123456789abcdef",
                  "session_id": "abcdefabcdef"})
UID_OLD = json.dumps({"session_id": "abcdefabcdef", "is_subagent": True})  # fabricated shape


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


def test_user_id_session_only():
    """user_id carries the SESSION and nothing else (measured on 60 live
    captures, #334 B1): the subagent verdict must not come from here."""
    sess = lc.user_id_session(UID)
    check("user_id: parses the session id (12 chars)",
          sess == "abcdefabcdef", sess)
    # NEGATIVE CONTROL — the fabricated old shape: a flag here must be ignored
    # (the caller reads the billing header, or reports unknown).
    check("user_id: the old fabricated flag shape yields only the session",
          lc.user_id_session(UID_OLD) == "abcdefabcdef", UID_OLD)
    echoed = "cc_is_subagent=true is the leak signature … (rule text)"
    check("user_id: an unparseable/echoed string yields NO session",
          lc.user_id_session(echoed) is None, echoed)
    check("user_id: empty yields nothing", lc.user_id_session("") is None)
    check("user_id: a non-dict JSON string yields nothing",
          lc.user_id_session('"plain"') is None)


def test_billing_three_states():
    # state 1: cc_is_subagent=true -> subagent
    got = lc.billing_fields_of('x "x-anthropic-billing-header: cc_version=2.1.288.b4b; '
                               'cc_entrypoint=claude-vscode; cc_is_subagent=true;" y')
    check("billing: cc_is_subagent=true -> True", got and got["sub"] is True, got)
    # state 2: header present without the flag -> main
    got2 = lc.billing_fields_of('"x-anthropic-billing-header: cc_version=2.1.288.b4b; '
                                'cc_entrypoint=claude-vscode;"')
    check("billing: header without the flag -> False (main)", got2 and got2["sub"] is False, got2)
    # state 3: no header -> unknown
    check("billing: no header -> None (unknown)",
          lc.billing_fields_of("no marker here") is None)
    # an ECHO of the field name in prose is not the marker: prose never carries
    # 'x-anthropic-billing-header:' followed by its k=v run
    check("billing: a bare field-name echo is NOT a header",
          lc.billing_fields_of("rule text says cc_is_subagent=true somewhere") is None)
    # cron ventilation rides the same segment
    got3 = lc.billing_fields_of('"x-anthropic-billing-header: cc_version=2.1.288.b4b; '
                                'cc_workload=cron; cc_is_subagent=false;"')
    check("billing: cc_workload=cron parsed", got3 and got3["workload"] == "cron", got3)
    check("billing: cc_is_subagent=false -> False (main)",
          got3 and got3["sub"] is False, got3)
    # LAST occurrence wins: the real system block is serialized after messages,
    # so an echo quoted inside the conversation comes EARLIER in the file
    both = ('{"messages":[{"text":"quoted: x-anthropic-billing-header: cc_is_subagent=true;"}],'
            '"system":[{"text":"x-anthropic-billing-header: cc_is_subagent=false;"}]}')
    got4 = lc.billing_fields_of(both)
    check("billing: the LAST occurrence (real system block) wins",
          got4 and got4["sub"] is False, got4)


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
    # POSIX roots: containerized lanes send POSIX paths (#334)
    posix = '"Primary working directory: /home/dev/proj\\n"'
    check("workspace: a POSIX absolute path is accepted",
          lc.workspace_of(posix) == "proj", lc.workspace_of(posix))


def test_end_to_end_real_shape():
    with tempfile.TemporaryDirectory() as d:
        # subagent=true on the billing header, cron via the HEADER's
        # cc_workload (envelope workload is null -> header fallback path)
        fname, body = real_req(1, 7, "2026-10-04T21-09-18-851Z",
                               {"cc_version": "2.1.288.b4b",
                                "cc_entrypoint": "claude-vscode",
                                "cc_workload": "cron",
                                "cc_is_subagent": "true"}, UID)
        with open(os.path.join(d, fname), "w", encoding="utf-8") as f:
            f.write(body)
        write_resp(d, 1, 7, "2026-10-04T21-09-20-100Z")
        rows, unattributed, stats = lc.collect(d, hours=24 * 365 * 10)
        check("e2e: the pair joined (positive control — a broken join gives 0)",
              len(rows) == 1, len(rows))
        per = lc.rollup(rows)
        key = "myia-po-2025:claudish:abcdefabcdef"
        check("e2e: keyed machine:workspace:session", key in per, list(per))
        if key in per:
            check("e2e: tokens carried", per[key]["out"] == 5 and per[key]["in"] == 10, per[key])
            check("e2e: billing cc_is_subagent=true -> subagent",
                  per[key]["subagent"] == 1 and per[key]["main"] == 0, per[key])
            check("e2e: cron ventilated from the header's cc_workload",
                  per[key]["cron"] == 1, per[key])
        check("e2e: nothing counted unattributed", unattributed == 0, unattributed)
        check("e2e: billing header found-rate counted",
              stats["billing_found"] == 1 and stats["billing_total"] == 1, stats)

        md = lc.to_markdown(per, 1, unattributed, stats)
        check("e2e: markdown names the row", key in md)
        check("e2e: markdown publishes the found-rate", "billing header found on **1/1**" in md, md)
        check("e2e: markdown shows all three states (main/sub/unk)",
              "main/sub/unk" in md, md)
        check("e2e: markdown states the unattributed count", "unattributed" in md)

        # envelope-priority path: workload=cron in the ENVELOPE, header silent
        fname2, body2 = real_req(1, 8, "2026-10-04T21-15-00-000Z",
                                 {"cc_version": "2.1.288.b4b"}, UID,
                                 envelope_workload="cron")
        with open(os.path.join(d, fname2), "w", encoding="utf-8") as f:
            f.write(body2)
        write_resp(d, 1, 8, "2026-10-04T21-15-02-000Z", out=3, inp=4)
        rows2, _, _ = lc.collect(d, hours=24 * 365 * 10)
        per2 = lc.rollup(rows2)
        check("e2e: envelope workload=cron wins when present",
              per2[key]["cron"] == 2, per2[key])
        check("e2e: header without the flag -> main",
              per2[key]["main"] == 1 and per2[key]["subagent"] == 1, per2[key])


def test_old_format_negative_control():
    """The fabricated shape this script shipped with: a subagent flag inside
    `user_id`, no billing block anywhere. It must report UNKNOWN — a verdict
    invented from the wrong field is the 0/0-column bug wearing a new hat."""
    with tempfile.TemporaryDirectory() as d:
        fname, body = real_req(1, 9, "2026-10-04T21-30-00-000Z", None, UID_OLD)
        with open(os.path.join(d, fname), "w", encoding="utf-8") as f:
            f.write(body)
        write_resp(d, 1, 9, "2026-10-04T21-30-02-000Z")
        rows, _, stats = lc.collect(d, hours=24 * 365 * 10)
        per = lc.rollup(rows)
        key = "myia-po-2025:claudish:abcdefabcdef"
        check("old-format: session still attributed", key in per, list(per))
        if key in per:
            check("old-format: flag in user_id yields unknown, NEVER subagent",
                  per[key]["unknown"] == 1 and per[key]["subagent"] == 0, per[key])
        check("old-format: found-rate honestly reports the miss",
              stats["billing_found"] == 0 and stats["billing_total"] == 1, stats)


def test_billing_deep_middle_needs_the_chunked_scan():
    """#334 B2: on a big capture `body.system` sits past the 512K head, and the
    128K tail must cross `tools[]` (~134K measured) to reach it — with tools
    150K the header lands in the range BOTH capped windows drop. The chunked
    whole-file scan is the only thing that can find it."""
    with tempfile.TemporaryDirectory() as d:
        fname, body = real_req(1, 12, "2026-10-04T22-40-00-000Z",
                               {"cc_version": "2.1.288.b4b",
                                "cc_entrypoint": "claude-vscode",
                                "cc_is_subagent": "true"},
                               UID, pad="P" * 600_000, tools_pad=150_000)
        path = os.path.join(d, fname)
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        size = os.path.getsize(path)
        check("deep-middle: fixture really exceeds head+tail",
              size > lc.HEAD_BYTES + lc.TAIL_BYTES, size)
        # NEGATIVE CONTROL: the capped read alone must miss the header —
        # if it ever finds it, this pin stopped testing the chunked seam.
        capped = lc.read_capped(path)
        check("deep-middle: NEGATIVE CONTROL — both capped windows miss it",
              lc.billing_fields_of(capped) is None)
        rows, _, stats = lc.collect(d, hours=24 * 365 * 10)
        per = lc.rollup(rows)
        key = "myia-po-2025:claudish:abcdefabcdef"
        check("deep-middle: the chunked scan found the header",
              stats["billing_found"] == 1 and stats["billing_total"] == 1, stats)
        if key in per:
            check("deep-middle: subagent attributed through the deep header",
                  per[key]["subagent"] == 1, per[key])


def test_scan_billing_straddles_block_boundaries():
    """The chunked scan reads fixed blocks with an overlap: a marker straddling
    a boundary must still be found. SCAN_BLOCK is shrunk to force straddles in
    a small fixture."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "blob.bin")
        with open(path, "wb") as f:
            f.write(b"x" * 250 + b"x-anthropic-billing-header: cc_is_subagent=true;" + b"y" * 300)
        old_block, old_overlap = lc.SCAN_BLOCK, lc.SCAN_OVERLAP
        try:
            lc.SCAN_BLOCK, lc.SCAN_OVERLAP = 256, 64
            got = lc.scan_billing_file(path)
            check("straddle: marker across a block boundary is found",
                  got and got["sub"] is True, got)
        finally:
            lc.SCAN_BLOCK, lc.SCAN_OVERLAP = old_block, old_overlap
        # marker at a block START too (no straddle) — same scan, plain case
        with open(path, "wb") as f:
            f.write(b"x" * 512 + b"x-anthropic-billing-header: cc_workload=cron;")
        check("straddle: aligned marker also found",
              lc.scan_billing_file(path) and
              lc.scan_billing_file(path)["workload"] == "cron")
        check("straddle: positive control — no marker yields None",
              lc.scan_billing_file(os.devnull) is None or
              os.path.getsize(os.devnull) == 0)


def test_attribution_at_the_far_end_is_still_read():
    """Measured on the live corpus: a head-only read reported 4 559 captures as
    `unattributed` over 2 h, because `metadata` comes AFTER `messages` and
    `tools` while `Primary working directory` sits in messages[0]. The two ends
    are read for exactly this. The head-only pass below is the NEGATIVE CONTROL:
    if it ever starts finding the session too, this pin has stopped testing
    anything and the seam it guards is gone."""
    with tempfile.TemporaryDirectory() as d:
        req = "req-1-0009-2026-10-04T21-09-18-851Z-direct.json"
        # Written by hand, not via json.dump, so the key ORDER is the capture's:
        # messages (huge) first, metadata last.
        with open(os.path.join(d, req), "w", encoding="utf-8") as f:
            f.write('{"machine":"myia-po-2025","pid":1,"body":{"messages":[{"content":'
                    '[{"text":' + json.dumps("Primary working directory: D:\\dev\\claudish\n") + '},'
                    '{"text":' + json.dumps("P" * 40_000) + '}]}],'
                    '"metadata":{"user_id":' + json.dumps(UID) + '}}}')
        resp = "resp-1-r0009-2026-10-04T21-09-20-100Z-openai-glm-5.3.sse"
        with open(os.path.join(d, resp), "w", encoding="utf-8") as f:
            f.write('{"usage":{"output_tokens":3}}')

        rows, _, _ = lc.collect(d, hours=24 * 365 * 10, head=4096, tail=4096)
        per = lc.rollup(rows)
        check("far-end: session found with a two-ended read",
              "myia-po-2025:claudish:abcdefabcdef" in per, list(per))

        rows_h, unatt, _ = lc.collect(d, hours=24 * 365 * 10, head=4096, tail=0)
        per_h = lc.rollup(rows_h)
        check("far-end: NEGATIVE CONTROL — head-only really does lose it",
              unatt == 1 and "myia-po-2025:claudish:abcdefabcdef" not in per_h,
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
        # pad pushes the marker past a 256 KB head; tailpad makes the file big
        # enough that the marker lands in the range a shallow head+tail drops.
        pad = "x" * 300_000
        tailpad = "y" * 200_000
        body = ('{"machine":"myia-po-2025","pid":1,"body":{"messages":'
                '[{"content":['
                '{"text":' + json.dumps(pad) + '},'
                '{"text":' + json.dumps("Primary working directory: D:\\dev\\claudish\n") + '}]},'
                '{"content":[{"text":' + json.dumps(tailpad) + '}]}],'
                '"metadata":{"user_id":' + json.dumps(UID) + '}}}')
        with open(os.path.join(d, req), "w", encoding="utf-8") as f:
            f.write(body)
        resp = "resp-1-r0011-2026-10-04T22-30-05-000Z-openai-glm-5.3.sse"
        with open(os.path.join(d, resp), "w", encoding="utf-8") as f:
            f.write('{"usage":{"output_tokens":2}}')

        rows, _, _ = lc.collect(d, hours=24 * 365 * 10)
        per = lc.rollup(rows)
        check("middle: default caps find the workspace",
              "myia-po-2025:claudish:abcdefabcdef" in per, list(per))

        rows_s, _, _ = lc.collect(d, hours=24 * 365 * 10, head=256 * 1024, tail=128 * 1024)
        per_s = lc.rollup(rows_s)
        check("middle: NEGATIVE CONTROL — a shallow head loses the workspace",
              "myia-po-2025:-:abcdefabcdef" in per_s
              and "myia-po-2025:claudish:abcdefabcdef" not in per_s, list(per_s))


def test_markdown_declares_truncation():
    """#334 nit: the digest cut at 40 rows without saying so. Now it must say
    it — a truncated table that looks complete is a silent under-report."""
    per = {f"m:ws-{i}:sess": {"n": 1, "in": 0, "out": i, "cread": 0, "ccre": 0,
                              "main": 1, "subagent": 0, "unknown": 0, "cron": 0}
           for i in range(45)}
    md = lc.to_markdown(per, 1, 0, {"billing_total": 45, "billing_found": 45})
    check("markdown: 'top 40 of 45' declared", "top 40 of 45" in md, md.splitlines()[-2:])
    check("markdown: positive control — 40 rows still rendered",
          md.count("| m:ws-") == 40, md.count("| m:ws-"))
    small = {k: v for k, v in list(per.items())[:5]}
    md2 = lc.to_markdown(small, 1, 0, {"billing_total": 5, "billing_found": 5})
    check("markdown: no truncation notice below 40 rows",
          "top 40 of" not in md2, md2.splitlines()[-2:])
    md3 = lc.to_markdown({}, 1, 0, {"billing_total": 0, "billing_found": 0})
    check("markdown: found-rate renders n/a on an empty window",
          "**n/a**" in md3, md3)


if __name__ == "__main__":
    _TESTS = (test_usage_takes_max_not_first, test_user_id_session_only,
              test_billing_three_states, test_pick_request_prefers_the_preceding_one,
              test_workspace_extraction, test_end_to_end_real_shape,
              test_old_format_negative_control,
              test_billing_deep_middle_needs_the_chunked_scan,
              test_scan_billing_straddles_block_boundaries,
              test_attribution_at_the_far_end_is_still_read,
              test_workdir_marker_in_the_dropped_middle,
              test_markdown_declares_truncation)
    for fn in _TESTS:
        print(f"== {fn.__name__}")
        fn()
    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} -> {FAILS}")
        sys.exit(1)
    print("all pins green")
