#!/usr/bin/env python3
"""Pins for native-consumption.py --leak-policy (#445).

The coordinator rendered the leak-policy verdict by hand every cycle, and the
hand-rolled pairing kept falling into trap 3 of native-consumption.py: the
resp filename rank rNNNN is NOT the request counter, and both counters reset
at every container restart. The mode reuses the full mode's pairing (reqN and
pid from the response HEADER, request at most 35 min before, latest wins) and
reads envelope heads only.

Pinned on a synthetic corpus:
  1. pairing goes through the header reqN, never the filename rank;
  2. a counter reused after a restart pairs with the request of the RIGHT
     container (latest within 35 min), not the older one;
  3. an Opus in the no-machine bucket refuses the verdict (exit 3);
  4. an unpaired Opus refuses the verdict (exit 3);
  5. a clean corpus gives exit 0, splits natives from Opus per machine, and
     details off-home Opus (device, sub-agent in both capture forms, hour);
  6. --since excludes earlier responses;
  7. a zero-padded request counter (req-1-0100-..., header reqN=100) pairs.

Run: python scripts/tests/test_native_leak_policy.py
"""

import json
import os
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.join(_HERE, "..", "native-consumption.py")


def _req(d, pid, n, stamp, machine, model="claude-opus-5-5", device=None, body=None):
    env = {"ts": stamp, "src": "direct", "machine": machine, "model": model}
    if device:
        env["device_id8"] = device
    env["body"] = body or {"model": model, "messages": [{"role": "user", "content": "hi"}]}
    name = f"req-{pid}-{n}-{stamp}-direct.json"
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        json.dump(env, f)


def _resp(d, pid, rank, stamp, model, reqN, hdr_pid=None):
    name = f"resp-{pid}-r{rank}-{stamp}-native-{model}.sse"
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        f.write(f"# parser=anthropic-sse model={model} reqN={reqN} pid={hdr_pid or pid}\n")
        f.write('event: message_start\ndata: {"type":"message_start"}\n\n')


def _run(d, *extra):
    empty = tempfile.mkdtemp(prefix="leak-rdir-")
    p = subprocess.run(
        [sys.executable, _SCRIPT, "--leak-policy", "--captures-dir", d,
         "--reconcile-dir", empty, *extra],
        capture_output=True, text=True, encoding="utf-8")
    return p.returncode, p.stdout + p.stderr


def _row(out, machine):
    # only the leak-policy table: the #933 blind-spot section above it also
    # starts lines with machine names
    table = out.split("Leak-policy (#445)", 1)[-1]
    for line in table.splitlines():
        if line.strip().startswith(machine + " "):
            return line
    return ""


def test_clean_corpus_header_pairing_and_restart():
    d = tempfile.mkdtemp(prefix="leak-ok-")
    # ai-01 Opus: filename rank r900 != header reqN 7 (trap 3)
    _req(d, 1, 7, "2026-11-09T06-00-00-000Z", "myia-ai-01")
    _resp(d, 1, 900, "2026-11-09T06-00-05-000Z", "claude-opus-5-5", 7)
    # a decoy whose NUMBER equals the filename rank, from another machine:
    # pairing by rank would attribute the response to it
    _req(d, 1, 900, "2026-11-09T05-59-00-000Z", "myia-po-2027")
    # restart: reqN 3 exists twice, 20 min apart (two restarts 30 min apart is
    # what 09/11 00:16Z/00:46Z did) -- both inside the 35 min window, the
    # response belongs to the late one
    _req(d, 1, 3, "2026-11-09T05-50-00-000Z", "myia-po-2028")
    _req(d, 1, 3, "2026-11-09T06-10-00-000Z", "myia-po-2024", device="0b9b0d8c",
         body={"system": [{"type": "text", "text": "x-anthropic-billing-header: cc_is_subagent=true"}],
               "messages": []})
    _resp(d, 1, 12, "2026-11-09T06-10-04-000Z", "claude-opus-5-5", 3)
    # second po-2024 Opus, sub-agent in the JSON-key form
    _req(d, 1, 4, "2026-11-09T07-01-00-000Z", "myia-po-2024", device="0b9b0d8c",
         body={"metadata": {"cc_is_subagent": True}, "messages": []})
    _resp(d, 1, 13, "2026-11-09T07-01-03-000Z", "claude-opus-5-5", 4)
    # a native sonnet counts as native, not Opus
    _req(d, 1, 5, "2026-11-09T07-02-00-000Z", "myia-po-2024", model="claude-sonnet-5-5")
    _resp(d, 1, 14, "2026-11-09T07-02-02-000Z", "claude-sonnet-5-5", 5)
    code, out = _run(d, "--since", "2026-11-09T00")
    assert code == 0, f"expected exit 0, got {code}\n{out}"
    assert "verdict valide" in out, out
    ai = _row(out, "myia-ai-01").split()
    assert ai[1:3] == ["1", "1"], f"ai-01 row wrong (header pairing?): {ai}\n{out}"
    assert not _row(out, "myia-po-2027"), f"rank-paired decoy attributed:\n{out}"
    assert not _row(out, "myia-po-2028"), f"pre-restart request won the pairing:\n{out}"
    po = _row(out, "myia-po-2024")
    assert po.split()[1:3] == ["3", "2"], f"po-2024 natives/opus wrong: {po}\n{out}"
    assert "sub=2/2" in po, f"sub-agent forms not both detected: {po}"
    assert "dev=0b9b0d8c:2" in po and "09 06h:1" in po and "09 07h:1" in po, po
    assert "Non appariees : natives=0 opus=0" in out, out


def test_opus_without_machine_refuses():
    d = tempfile.mkdtemp(prefix="leak-empty-")
    _req(d, 1, 1, "2026-11-09T06-00-00-000Z", "")
    _resp(d, 1, 1, "2026-11-09T06-00-02-000Z", "claude-opus-5-5", 1)
    code, out = _run(d, "--since", "2026-11-09T00")
    assert code == 3, f"expected exit 3, got {code}\n{out}"
    assert "VERDICT REFUSE : 1 Opus sans machine" in out, out


def test_unpaired_opus_refuses():
    d = tempfile.mkdtemp(prefix="leak-unp-")
    _req(d, 1, 1, "2026-11-09T05-00-00-000Z", "myia-ai-01")  # 60 min before: out of window
    _resp(d, 1, 1, "2026-11-09T06-00-00-000Z", "claude-opus-5-5", 1)
    code, out = _run(d, "--since", "2026-11-09T00")
    assert code == 3, f"expected exit 3, got {code}\n{out}"
    assert "1 Opus non apparie" in out, out


def test_padded_request_counter_pairs():
    # live corpus 09/11: req-1-0100-... on disk, reqN=100 in the resp header
    d = tempfile.mkdtemp(prefix="leak-pad-")
    _req(d, 1, "0007", "2026-11-09T06-00-00-000Z", "myia-ai-01")
    _resp(d, 1, "0007", "2026-11-09T06-00-02-000Z", "claude-opus-5-5", 7)
    code, out = _run(d, "--since", "2026-11-09T00")
    assert code == 0, f"padded counter left unpaired: {code}\n{out}"
    assert "Non appariees : natives=0 opus=0" in out, out


def test_since_excludes_earlier():
    d = tempfile.mkdtemp(prefix="leak-since-")
    _req(d, 1, 1, "2026-11-08T22-00-00-000Z", "")
    _resp(d, 1, 1, "2026-11-08T22-00-02-000Z", "claude-opus-5-5", 1)  # would refuse
    _req(d, 1, 2, "2026-11-09T06-00-00-000Z", "myia-ai-01")
    _resp(d, 1, 2, "2026-11-09T06-00-02-000Z", "claude-opus-5-5", 2)
    code, out = _run(d, "--since", "2026-11-09T00")
    assert code == 0, f"pre-window Opus leaked into the verdict: {code}\n{out}"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} passed")
