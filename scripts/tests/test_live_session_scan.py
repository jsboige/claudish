#!/usr/bin/env python3
r"""Pins for live-session-scan.py (#362).

Fixture provenance follows the repo rule born from live-consumption.py trap 1
(synthetic fixtures had fabricated a shape the real traffic never sends): every
fixture here is the MEASURED envelope shape, field order included —

  {"ts","src","machine","model","pid","device_id8","entrypoint","workload",
   "body":{"model","messages":[...],"tools":[...]?,"metadata":{...}}}

with `body.metadata` serialized LAST (measured 2026-10-06: 368-426 B before
EOF, after every message and tool block). The echo class that can actually
reach the wire is NOT a quoted `"metadata":{` inside message prose (it would
be escaped as `\"metadata\":{` and cannot match), but a TOOL SCHEMA property
named `metadata` — an unescaped structural `"metadata":{` that precedes the
real one. The fast pass must take the LAST occurrence; that is pinned here.

Each case carries a positive control: the failure modes are silent
under-counts and mis-attributions, not crashes.

Run standalone:  python scripts/tests/test_live_session_scan.py
Or under pytest: pytest scripts/tests/test_live_session_scan.py
"""

import importlib.util
import json
import os
import sys
import tempfile
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "live_session_scan", os.path.join(_HERE, "..", "live-session-scan.py"))
lss = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(lss)

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def capture(model="glm-5.3", machine="myia-po-2025",
            user_id=None, session_id=None, tools_schema_metadata=False,
            pad_kb=24, workdir=None, sdk_shape=False):
    """Build a capture file body in the measured shape. `pad_kb` pushes the
    real metadata well past the 6 KiB fast head so the tail path is exercised;
    `tools_schema_metadata` injects the echo class that can really occur."""
    uid = user_id if user_id is not None else json.dumps({
        "device_id": "0123456789abcdef" * 2,
        "account_uuid": "11111111-2222-3333-4444-555555555555",
        "session_id": "abcdef01-2345-6789-abcd-ef0123456789"})
    msg_text = ("<system-reminder>\nrule prose " + "x" * (pad_kb * 1024) + "\n")
    if workdir:
        msg_text += "working in %s\n" % workdir
    body = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": msg_text},
            {"role": "user", "content": "second message"}]},
        ],
    }
    if tools_schema_metadata:
        body["tools"] = [
            {"name": "send",
             "description": "sends",
             "input_schema": {"type": "object",
                              "properties": {"metadata": {
                                  "type": "object",
                                  "properties": {"user_id": {"type": "string"}},
                              }}}},
        ]
    if not sdk_shape:
        meta = {"user_id": uid}
        if session_id is not None:
            meta["session_id"] = session_id
        body["metadata"] = meta
    body["stream"] = True
    env = {"ts": "2026-10-06T00-00-00-000Z", "src": "direct", "machine": machine,
           "model": model, "pid": 1, "device_id8": "01234567",
           "entrypoint": "claude-vscode", "workload": "cron", "body": body}
    return json.dumps(env)


def write(d, name, text, age_s=30):
    p = os.path.join(d, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    os.utime(p, (time.time() - age_s, time.time() - age_s))
    return p


def test_flags():
    check("flag openai gpt-", lss.model_flags("gpt-6-sol") == ["OPENAI-SHAPED"])
    check("flag openai -sol", lss.model_flags("agent-sol") == ["OPENAI-SHAPED"])
    check("flag openai codex", lss.model_flags("codex-2") == ["OPENAI-SHAPED"])
    check("flag retired sonnet-4-6",
          lss.model_flags("claude-sonnet-4-6") == ["RETIRED-ID"])
    check("flag retired glm-5.2", lss.model_flags("glm-5.2") == ["RETIRED-ID"])
    check("flag retired qwen3.6 alias",
          lss.model_flags("qwen3.6-35b-a3b") == ["RETIRED-ID"])
    check("no flag on nominal", lss.model_flags("glm-5.3") == [])
    # positive control: the classes are not vacuous
    check("openai rx alive", lss.OPENAI_RE.search("gpt-6-sol") is not None)
    check("retired rx alive", lss.RETIRED_RE.search("glm-5.2") is not None)


def test_fast_deep_agree_on_measured_shapes():
    with tempfile.TemporaryDirectory() as d:
        cases = [
            ("req-1-0001-2026-10-06T00-00-00-000Z-direct.json",
             capture(model="gpt-6-sol", tools_schema_metadata=True)),
            ("req-1-0002-2026-10-06T00-00-01-000Z-direct.json",
             capture(model="claude-sonnet-4-6", session_id="aaaabbbb-1111-2222-3333-444444444444")),
            ("req-1-0003-2026-10-06T00-00-02-000Z-direct.json",
             capture(model="glm-5.3", sdk_shape=True, machine="")),
            ("req-1-0004-2026-10-06T00-00-03-000Z-direct.json",
             capture(model="glm-5.2", machine="myia-po-2023")),
        ]
        for name, text in cases:
            p = write(d, name, text)
            f = lss.parse_fast(p)
            deep = lss.parse_deep(p)
            check("fast==deep %s" % name[:16],
                  f["model"] == deep["model"] and f["user_id"] == deep["user_id"]
                  and f["session_id"] == deep["session_id"]
                  and f["machine"] == deep["machine"],
                  "fast=%r deep=%r" % (f, deep))
        # the echo-shaped tool schema must not win over the real metadata
        p = os.path.join(d, cases[0][0])
        f = lss.parse_fast(p)
        check("tool-schema echo does not win",
              f["user_id"] is not None and "abcdef01" in f["user_id"],
              repr(f["user_id"])[:80])
        # sdk shape -> unattributed bucket, not a crash, model still counted
        f = lss.parse_fast(os.path.join(d, cases[2][0]))
        check("sdk shape unattributed",
              f["user_id"] is None and f["session_id"] is None
              and f["model"] == "glm-5.3")


def test_end_to_end_report():
    with tempfile.TemporaryDirectory() as d:
        write(d, "req-1-0001-2026-10-06T00-00-00-000Z-direct.json",
              capture(model="gpt-6-sol", user_id=json.dumps(
                  {"device_id": "0" * 32, "account_uuid": "1" * 8 + "-x",
                   "session_id": "cccc0000-0000-0000-0000-000000000001"})))
        write(d, "req-1-0002-2026-10-06T00-00-01-000Z-direct.json",
              capture(model="gpt-6-sol", user_id=json.dumps(
                  {"device_id": "0" * 32, "account_uuid": "1" * 8 + "-x",
                   "session_id": "cccc0000-0000-0000-0000-000000000001"})))
        write(d, "req-1-0003-2026-10-06T00-00-02-000Z-direct.json",
              capture(model="glm-5.3", machine="myia-po-2023"))
        write(d, "req-1-0005-2026-10-06T00-00-04-000Z-direct.json",
              capture(model="claude-sonnet-4-6", sdk_shape=True, machine=""))
        write(d, "resp-1-r0006-2026-10-06T00-00-05-000Z-openai.sse", "{}")
        import io
        import contextlib
        buf = io.StringIO()
        rc = None
        with contextlib.redirect_stdout(buf):
            rc = lss.main(["--captures", d, "--hours", "1", "--top", "5",
                           "--json"])
        out = json.loads(buf.getvalue())
        check("exit 0", rc == 0)
        check("4 requests scanned", out["files_in_window"] == 4,
              out["files_in_window"])
        check("resp file ignored", out["files_seen"] == 4, out["files_seen"])
        check("openai digest", out["digest"]["openai_shaped"] ==
              {"sessions": 1, "requests": 2}, out["digest"]["openai_shaped"])
        check("retired digest", out["digest"]["retired_id"] ==
              {"sessions": 1, "requests": 1}, out["digest"]["retired_id"])
        top = out["sessions"][0]
        check("openai session sorts first", top["flags"] == ["OPENAI-SHAPED"]
              and top["requests"] == 2, top["flags"])
        check("session id surfaced", top["session_id"].startswith("cccc0000"),
              top["session_id"])
        # --models filter: only matching requests enter the aggregation
        buf2 = io.StringIO()
        with contextlib.redirect_stdout(buf2):
            lss.main(["--captures", d, "--hours", "1", "--models", "sol",
                      "--json"])
        out2 = json.loads(buf2.getvalue())
        check("filter drops non-matching",
              out2["files_in_window"] == 4
              and sum(m["requests"] for m in out2["model_totals"].values()) == 2,
              out2["model_totals"])
        # unparsable counted, not fatal
        write(d, "req-1-0007-2026-10-06T00-00-06-000Z-direct.json", "{not json")
        buf3 = io.StringIO()
        with contextlib.redirect_stdout(buf3):
            rc3 = lss.main(["--captures", d, "--hours", "1", "--json"])
        out3 = json.loads(buf3.getvalue())
        check("unparsable counted not fatal",
              rc3 == 0 and out3["unparsable"]["count"] == 1, out3["unparsable"])


def test_deep_workdir_hint():
    with tempfile.TemporaryDirectory() as d:
        p = write(d, "req-1-0001-2026-10-06T00-00-00-000Z-direct.json",
                  capture(workdir="d:\\Dev\\CoursIA-2"))
        deep = lss.parse_deep(p)
        fast = lss.parse_fast(p)
        check("deep workdir hint", deep["workdir_hint"] == "d:\\Dev\\CoursIA-2",
              deep["workdir_hint"])
        check("fast head hint absent is expected",
              fast["workdir_hint"] == "",
              "fast=%r (marker sits past the 6 KiB head — documented)" %
              fast["workdir_hint"])


if __name__ == "__main__":
    test_flags()
    test_fast_deep_agree_on_measured_shapes()
    test_end_to_end_report()
    test_deep_workdir_hint()
    print()
    if FAILS:
        print("FAILED: %d" % len(FAILS))
        sys.exit(1)
    print("all checks passed")
