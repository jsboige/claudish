#!/usr/bin/env python3
"""Pins for turn-composition.py (#328).

Each pin defends a reading that a plausible-looking implementation gets WRONG,
and that would silently manufacture a conclusion:

  1. DENOMINATOR -- the per-turn system tax divides by ASSISTANT turns, never by
     requests. Dividing by requests mixes two populations (a request is one API
     call; a turn is one model answer) and reads a flat 0.9 ratio as if the
     harness injected a block per request.
  2. PASSENGER vs OWN TURN -- a trailing role:"system" block that follows a
     user/tool_result message rode a turn that had to happen; one that follows
     an assistant answer with no tool_use is a request emitted for nothing.
     The two call for opposite fixes, so the classification is pinned both ways.
  3. CREDENTIAL SOURCE -- a `${VAR}` template that exists only in the config
     home's `apiKeys` map is OK. A container-env-only probe reported a false
     MISSING for every endpoint on the hub (measured 29/10) and would have
     produced a "the rungs cannot route" claim that is simply false.
  4. ENVELOPE HEAD READ -- attribution must come from the envelope, which is
     serialized before the body: a file whose body exceeds the head must still
     be attributed. If a future change makes it parse the body, the whole-corpus
     census silently becomes a sample.
  5. NUDGE NORMALISATION -- dates, long hex ids and numbers are normalised, so
     two turns of the same nudge cluster together instead of forming one cluster
     per turn.

Run standalone (no pytest needed):
  python scripts/tests/test_turn_composition.py
Or under pytest:
  pytest scripts/tests/test_turn_composition.py
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
from types import SimpleNamespace

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.environ.get(
    "COMPOSITION_TARGET", os.path.join(os.path.dirname(_HERE), "turn-composition.py")
)

_spec = importlib.util.spec_from_file_location("tcomp", _TARGET)
tcomp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tcomp)


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def _quiet(fn, *a, **k):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*a, **k)
    return buf.getvalue()


def _write_capture(directory, name, ts, machine, entrypoint, model, messages, filler=0):
    env = {
        "ts": ts,
        "src": "direct",
        "machine": machine,
        "model": model,
        "pid": 1,
        "instanceId": "test",
        "device_id8": "deadbeef",
        "entrypoint": entrypoint,
        "hops": [],
        "body": {"model": model, "messages": messages,
                 "metadata": {"user_id": json.dumps({"session_id": "s-" + name})},
                 "pad": "x" * filler},
    }
    with open(os.path.join(directory, name), "w", encoding="utf-8") as fh:
        json.dump(env, fh)


# --- pin 1: the denominator is assistant turns ------------------------------

def pin_denominator_is_assistant_turns():
    d = tempfile.mkdtemp()
    try:
        # 1 assistant turn, 2 system blocks -> ratio 2.0 (NOT 2/request, which
        # would be 1.0 and would halve the tax on this shape)
        msgs = [
            {"role": "user", "content": "go"},
            {"role": "system", "content": "nudge a"},
            {"role": "assistant", "content": "done"},
            {"role": "system", "content": "nudge b"},
        ]
        _write_capture(d, "req-1-0001-2026-10-29T10-00-00-000Z.json",
                       "2026-10-29T10:00:00.000Z", "m1", "cli", "glm-5.3", msgs)
        out = os.path.join(d, "o.json")
        _quiet(tcomp.cmd_history, SimpleNamespace(dir=d, label="t", limit=10, out=out))
        r = json.load(open(out, encoding="utf-8"))
        bucket = r["growth_by_assistant_turns"][0]
        _check(bucket["mean_n_system"] == 2.0, "n_system: %r" % bucket)
        _check(bucket["sys_blocks_per_assistant_turn"] == 2.0,
               "ratio must divide by assistant turns: %r" % bucket)
    finally:
        shutil.rmtree(d, ignore_errors=True)


# --- pin 2: passenger vs own turn ------------------------------------------

def pin_passenger_vs_own_turn():
    d = tempfile.mkdtemp()
    try:
        # PASSENGER: user/tool_result then the reminder
        _write_capture(
            d, "req-1-0001-2026-10-29T10-00-00-000Z.json",
            "2026-10-29T10:00:00.000Z", "m1", "cli", "glm-5.3",
            [
                {"role": "user", "content": "go"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]},
                {"role": "system", "content":
                    "Proactive output style is active. Execute autonomously."},
            ])
        # OWN TURN: assistant final answer (no tool_use) then the reminder
        _write_capture(
            d, "req-1-0002-2026-10-29T10-01-00-000Z.json",
            "2026-10-29T10:01:00.000Z", "m1", "cli", "glm-5.3",
            [
                {"role": "user", "content": "go"},
                {"role": "assistant", "content": "all done, nothing to run"},
                {"role": "system", "content":
                    "Proactive output style is active. Execute autonomously."},
            ])
        out = os.path.join(d, "o.json")
        _quiet(tcomp.cmd_nudge, SimpleNamespace(dir=d, label="t", limit=10, top=5, out=out))
        r = json.load(open(out, encoding="utf-8"))
        cls = r["classification"]
        _check(cls.get("prev=user+tool_result") == 1, "passenger not classified: %r" % cls)
        _check(cls.get("prev=assistant+NO_tool_use(OWN-TURN)") == 1,
               "own-turn not classified: %r" % cls)
        _check(r["ended_with_system"] == 2, "trailing count: %r" % r["ended_with_system"])
    finally:
        shutil.rmtree(d, ignore_errors=True)


# --- pin 3: credential source is apiKeys first ------------------------------

def pin_apikeys_map_counts_as_present():
    d = tempfile.mkdtemp()
    try:
        cfg = {
            "apiKeys": {"MISTRAL_API_KEY": "x" * 8},
            "customEndpoints": {
                "mistral": {"baseUrl": "https://api.mistral.ai",
                            "apiKey": "${MISTRAL_API_KEY}"},
                "ghost": {"baseUrl": "https://example.invalid",
                          "apiKey": "${NOT_ANYWHERE_API_KEY}"},
            },
        }
        p = os.path.join(d, "config.json")
        json.dump(cfg, open(p, "w", encoding="utf-8"))
        out = os.path.join(d, "o.json")
        _quiet(tcomp.cmd_routability, SimpleNamespace(config=p, container="", out=out))
        r = json.load(open(out, encoding="utf-8"))
        by = {e["endpoint"]: e for e in r["endpoints"]}
        _check(by["mistral"]["status"] == "OK",
               "apiKeys map must satisfy the template: %r" % by["mistral"])
        _check(by["mistral"]["credential_source"] == "apiKeys:MISTRAL_API_KEY",
               "source: %r" % by["mistral"])
        _check(by["ghost"]["status"] == "MISSING:NOT_ANYWHERE_API_KEY",
               "absent key must still be reported: %r" % by["ghost"])
    finally:
        shutil.rmtree(d, ignore_errors=True)


# --- pin 4: attribution comes from the envelope, not the body --------------

def pin_envelope_survives_a_body_larger_than_the_head():
    d = tempfile.mkdtemp()
    try:
        _write_capture(d, "req-1-0001-2026-10-29T10-00-00-000Z.json",
                       "2026-10-29T10:00:00.000Z", "myia-po-2025", "cron", "glm-5.3",
                       [{"role": "user", "content": "go"}], filler=20000)
        out = os.path.join(d, "o.json")
        _quiet(tcomp.cmd_envelope, SimpleNamespace(dir=d, label="t", head=1024, out=out))
        r = json.load(open(out, encoding="utf-8"))
        _check(r["machine"].get("myia-po-2025") == 1, "machine: %r" % r["machine"])
        _check(r["entrypoint"].get("cron") == 1, "entrypoint: %r" % r["entrypoint"])
        _check(r["per_day"].get("2026-10-29") == 1, "day: %r" % r["per_day"])
    finally:
        shutil.rmtree(d, ignore_errors=True)


# --- pin 5: nudge normalisation clusters --------------------------------

def pin_nudge_normalisation_clusters():
    a = tcomp.norm("The date has changed to 2026-10-29. Run again at 14:32.")
    b = tcomp.norm("The date has changed to 2026-07-05. Run again at 09:07.")
    _check(a == b, "dates/numbers must normalise to one cluster: %r vs %r" % (a, b))
    c = tcomp.norm("file 0123456789abcdef written")
    e = tcomp.norm("file fedcba9876543210 written")
    _check(c == e, "long hex ids must normalise: %r vs %r" % (c, e))


PINS = [
    pin_denominator_is_assistant_turns,
    pin_passenger_vs_own_turn,
    pin_apikeys_map_counts_as_present,
    pin_envelope_survives_a_body_larger_than_the_head,
    pin_nudge_normalisation_clusters,
]


def main():
    failed = 0
    for p in PINS:
        try:
            p()
            print("PASS %s" % p.__name__)
        except AssertionError as exc:
            failed += 1
            print("FAIL %s: %s" % (p.__name__, exc))
    print("%d/%d pins pass" % (len(PINS) - failed, len(PINS)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
