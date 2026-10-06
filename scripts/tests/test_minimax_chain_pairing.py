#!/usr/bin/env python3
"""Pins for the resp/req pairing of minimax-chain-measure.py (claudish #295).

The coordinator's review of the 06/10 measurement file found the pairing
loop giving each REQUEST (in os.listdir order) its closest FOLLOWING resp:
a FAR request sorting first stole the response of a NEAR one, and the loser
left the denominator as `ambiguous`. The docstring promised the inverse
rule -- each RESPONSE goes to the request of minimal dt -- which is what
the 07/10 window measurement must run on.

Pinned here:

  1. THE COORDINATOR PIN -- one resp, two same-reqN continuations: FAR
     (dt 600 s, prev-assistant carries a sig64 thinking block) and NEAR
     (dt 10 s, plain). The resp belongs to NEAR, and the result must be
     IDENTICAL under a reversed os.listdir enumeration (the pre-fix bug
     was enumeration-order-dependent -- that invariance IS the pin).
  2. A continuation whose resp never landed in any window stays `unpaired`
     -- never in the denominator, never silent.
  3. A resp with NO continuation candidate pairs nothing (resp-side (a)
     still counts it).

Mutation proofs (run before pushing; each must turn pin 1 red):
  A. winner = idxs[lo] (earliest window entry = the FARTHEST dt) -> the
     FAR req wins -> sig64=1: red.
  B. restore the pre-fix one-pass loop (each req claims its closest
     following resp, first-in-listdir wins) -> run under natural order:
     FAR wins: red. Under reversed order NEAR wins -- which is why pin 1
     asserts the two orders AGREE rather than one fixed winner count.

Run standalone (no pytest needed):
  python scripts/tests/test_minimax_chain_pairing.py
Or under pytest:
  pytest scripts/tests/test_minimax_chain_pairing.py

Point MCM_TARGET at another copy of the script (e.g. the pre-fix main) to
red-proof the pins against it.
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.environ.get(
    "MCM_TARGET", os.path.join(os.path.dirname(_HERE), "minimax-chain-measure.py")
)

_spec = importlib.util.spec_from_file_location("mcm", _TARGET)
mcm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mcm)


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


# ── fixture builders ─────────────────────────────────────────────────────────

# M3's implicit signature is the SHA-256 of the empty string (e3b0c442...) --
# the only 64-hex shape MiniMax itself produces.
SIG64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def _req_file(msgs):
    """A req-* ENVELOPE (trap 6: the request lives under `body`)."""
    return json.dumps({"ts": "2026-10-04T00:00:00Z", "src": "test", "pid": 1,
                       "body": {"model": "m", "messages": msgs}})


def _continuation(prev_blocks):
    msgs = [{"role": "assistant", "content": prev_blocks},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1",
                                          "content": "ok"}]}]
    return _req_file(msgs)


def _resp_body():
    return ("# parser=anthropic-sse model=MiniMax-M3 reqN=7 pid=1\n"
            'data: {"type":"message_start"}\n\n'
            "data: [DONE]\n\n")


def _scan_files(files, reverse=False):
    """Write the fixture to a temp dir, scan it, tear it down. `reverse`
    serves the enumeration-order invariance: os.listdir is monkeypatched to
    return the names in the opposite order for the scan dir only."""
    d = tempfile.mkdtemp(prefix="mcp-test-")
    for name, content in files.items():
        with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
            fh.write(content)
    real_listdir = os.listdir
    names = sorted(files)
    if reverse:
        names = list(reversed(names))

    def fake_listdir(p):
        out = real_listdir(p)
        return out if os.path.abspath(p) != os.path.abspath(d) else list(names)

    os.listdir = fake_listdir
    try:
        return mcm.scan([d], None, None, "MiniMax")
    finally:
        os.listdir = real_listdir
        shutil.rmtree(d, ignore_errors=True)


# ── pins ─────────────────────────────────────────────────────────────────────

def _pin_two_reqs_one_resp():
    """Pin 1 -- the coordinator's shape: the resp goes to the NEAR request,
    whatever os.listdir returns."""
    far_name = "req-1-0007-2026-10-04T00-00-00-000Z-direct.json"   # dt 600 s
    near_name = "req-1-0007-2026-10-04T00-09-50-000Z-direct.json"  # dt 10 s
    files = {
        far_name: _continuation([
            {"type": "thinking", "thinking": "…", "signature": SIG64},
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}},
        ]),
        near_name: _continuation([
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}},
        ]),
        "resp-1-r7-2026-10-04T00-10-00-000Z-anthropic-MiniMax-M3.sse": _resp_body(),
    }
    r_nat = _scan_files(files)          # natural (name-sorted) enumeration
    r_rev = _scan_files(files, reverse=True)
    for tag, r in (("natural", r_nat), ("reversed", r_rev)):
        _check(r["resp_total"] == 1, "pin1/%s: resp_total=%r" % (tag, r["resp_total"]))
        _check(r["req_tool_continuation_paired"] == 1,
               "pin1/%s: exactly ONE continuation must pair (the NEAR one), got %r"
               % (tag, r["req_tool_continuation_paired"]))
        _check(r["req_continuation_prev_asst_thinking"] == 0,
               "pin1/%s: the winner is the NEAR req (no thinking) -- the FAR req's "
               "thinking must not leak into (b) via a stolen resp, got %r"
               % (tag, r["req_continuation_prev_asst_thinking"]))
        _check(r["req_continuation_prev_asst_thinking_sig64_minimax"] == 0,
               "pin1/%s: sig64=%r -- the FAR req (sig64 carrier) won the resp"
               % (tag, r["req_continuation_prev_asst_thinking_sig64_minimax"]))
        _check(r["req_continuation_ambiguous_pair"] == 1,
               "pin1/%s: the FAR req had a candidate window and lost it -- it must "
               "count as lost-to-closer, got %r" % (tag, r["req_continuation_ambiguous_pair"]))
        _check(r["req_continuation_unpaired"] == 0,
               "pin1/%s: no continuation may be 'unpaired' here, got %r"
               % (tag, r["req_continuation_unpaired"]))
    _check(r_nat == r_rev,
           "pin1: the pairing result must not depend on os.listdir order "
           "(pre-fix signature: the two enumerations disagree)")


def _pin_unpaired():
    """Pin 2 -- a continuation with no resp in its window is `unpaired`,
    never in the denominator, never silent."""
    files = {
        "req-1-0007-2026-10-04T00-00-00-000Z-direct.json": _continuation(
            [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]),
        # one hour later: outside the 11-min window -> no candidate
        "resp-1-r7-2026-10-04T01-00-00-000Z-anthropic-MiniMax-M3.sse": _resp_body(),
    }
    r = _scan_files(files)
    _check(r["req_tool_continuation_paired"] == 0, "pin2: paired=%r" % r["req_tool_continuation_paired"])
    _check(r["req_continuation_unpaired"] == 1, "pin2: unpaired=%r" % r["req_continuation_unpaired"])
    _check(r["resp_total"] == 1, "pin2: (a) still counts the resp, got %r" % r["resp_total"])


def _pin_resp_without_candidate():
    """Pin 3 -- a resp with no continuation in its window pairs nothing but
    still enters (a)."""
    files = {
        # a NON-continuation request (plain user turn) inside the window:
        # parsed, gated as no_toolresult, never a candidate
        "req-1-0007-2026-10-04T00-09-50-000Z-direct.json": _req_file(
            [{"role": "user", "content": "say hi"}]),
        "resp-1-r7-2026-10-04T00-10-00-000Z-anthropic-MiniMax-M3.sse": _resp_body(),
    }
    r = _scan_files(files)
    _check(r["resp_total"] == 1, "pin3: resp_total=%r" % r["resp_total"])
    _check(r["req_tool_continuation_paired"] == 0, "pin3: paired=%r" % r["req_tool_continuation_paired"])
    _check(r["req_no_toolresult"] == 1, "pin3: the plain req must land in the no_toolresult gate, got %r"
           % r["req_no_toolresult"])


def main():
    _pin_two_reqs_one_resp()
    _pin_unpaired()
    _pin_resp_without_candidate()
    print("test_minimax_chain_pairing: 3 pins OK (target: %s)" % _TARGET)


if __name__ == "__main__":
    main()
