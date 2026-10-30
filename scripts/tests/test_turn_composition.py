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
  6. CROSS-TAB PARTITION -- the per-machine x per-model slice must partition
     the corpus. A sibling lane is handed that slice; a dropped or double
     counted row would land on another lane's dashboard as an attribution.
  7. ARCHIVE BOUNDARY -- the archive stream is the members back to back, with
     no separator. A body may embed a JSON object carrying a `ts` key, so the
     boundary marker is the envelope's opening (timestamp AND the key that
     follows it); a loose marker would split a stream mid-body.
  8. INDEX CROSS-CHECK -- the archive index says how many members are in
     there. A marker whose head count disagrees with it yields a corpus that
     still LOOKS like a census and is wrong: the only honest outcome is a
     refusal.
  9. PARTIAL DAY -- an archive is not necessarily a whole day: 27/10 holds
     5 136 request captures against 57 849 response captures. The request
     share is in the output, so a reader sees the coverage before quoting it.

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


# --- pin 6: the per-machine cross-tab partitions the corpus -----------------

def pin_machine_cross_tab_partitions_the_corpus():
    """A sibling lane is handed ITS OWN slice; the slice must be a partition.

    If the cross-tab dropped a row or counted a request under two machines, the
    per-machine numbers would still LOOK plausible -- they would just be wrong,
    and the error would land on another lane's dashboard as an attribution.
    """
    d = tempfile.mkdtemp()
    try:
        _write_capture(d, "req-1-0001-2026-10-29T10-00-00-000Z.json",
                       "2026-10-29T10:00:00.000Z", "myia-po-2027", "cli", "glm-5.3",
                       [{"role": "user", "content": "go"}])
        _write_capture(d, "req-1-0002-2026-10-29T10-01-00-000Z.json",
                       "2026-10-29T10:01:00.000Z", "myia-po-2027", "cli", "glm-5.3",
                       [{"role": "user", "content": "go"}])
        _write_capture(d, "req-1-0003-2026-10-29T10-02-00-000Z.json",
                       "2026-10-29T10:02:00.000Z", "myia-po-2027", "cron", "glm-5.3",
                       [{"role": "user", "content": "go"}])
        _write_capture(d, "req-1-0004-2026-10-30T10-00-00-000Z.json",
                       "2026-10-30T10:00:00.000Z", "myia-po-2025", "cron", "mmc@M3.1",
                       [{"role": "user", "content": "go"}])
        out = os.path.join(d, "o.json")
        _quiet(tcomp.cmd_envelope,
               SimpleNamespace(dir=d, label="t", head=2048, top=8, out=out))
        r = json.load(open(out, encoding="utf-8"))
        mm = r["machine_model"]
        _check(r["requests_total"] == 4, "total: %r" % r["requests_total"])
        # every request is attributed to exactly one (machine, model) cell
        total_cells = sum(c["n"] for cells in mm.values() for c in cells)
        _check(total_cells == r["requests_total"],
               "cross-tab must partition the corpus: %d cells vs %d"
               % (total_cells, r["requests_total"]))
        # and each machine's slice sums to its own total
        for mach, cells in mm.items():
            s = sum(c["n"] for c in cells)
            _check(s == r["machine"][mach],
                   "slice of %s sums to %d, machine total is %d"
                   % (mach, s, r["machine"][mach]))
        _check(mm["myia-po-2027"][0]["model"] == "glm-5.3", "model: %r" % mm["myia-po-2027"])
        _check(mm["myia-po-2027"][0]["n"] == 3, "count: %r" % mm["myia-po-2027"])
        # the day split is per machine too
        days = {x["day"]: x["n"] for x in r["machine_per_day"]["myia-po-2027"]}
        _check(days.get("2026-10-29") == 3 and days.get("2026-10-30") is None,
               "days: %r" % days)
    finally:
        shutil.rmtree(d, ignore_errors=True)


# --- pin 7: the archive boundary marker splits members, and nothing else ----

def _member_bytes(ts, machine, model="glm-5.3", body_extra=b""):
    env = ('{"ts":"%s","src":"direct","machine":"%s","model":"%s",'
           '"entrypoint":"cli","body":{' % (ts, machine, model)).encode()
    return env + body_extra + b'{"messages":[]}}'


def pin_archive_marker_splits_only_on_member_boundaries():
    """The archive stream is the members back to back, with no separator.

    A body may embed a JSON object carrying a `ts` key -- a tool result
    quoting a log line. A loose `{"ts":` marker would split the stream there,
    in the middle of a body, and the head that follows would be read as a
    capture: the corpus would look complete and be WRONG. The marker is the
    envelope's opening (timestamp AND the key that follows it), and the
    member count is cross-checked against the archive index.
    """
    stream = (_member_bytes("2026-07-05T12-33-44-123Z", "myia-po-2023")
              + _member_bytes("2026-07-05T12-34-00-000Z", "myia-po-2027",
                              body_extra=b'"tool":"{\\"ts\\":\\"whatever\\"}",')
              + _member_bytes("2026-07-05T12-35-00-000Z", "myia-po-2025"))
    heads = list(tcomp.iter_heads(io.BytesIO(stream), head=2048))
    _check(len(heads) == 3, "three members must give three heads: %d" % len(heads))
    machines = [tcomp.parse_head(h.decode("utf-8", "replace")).get("machine")
                for h in heads]
    _check(machines == ["myia-po-2023", "myia-po-2027", "myia-po-2025"],
           "a body-embedded ts must not split the stream: %r" % machines)


# --- pin 8: the marker that does not agree with the index is a refusal ------

def pin_archive_boundary_mismatch_is_refused():
    """The archive index says how many members are in there. A marker whose
    head count disagrees with it did NOT split that archive cleanly.

    The corpus it yields would still LOOK like a census -- plausible totals,
    plausible per-machine slices -- and every one of them would be wrong. The
    only honest outcome is a refusal that names the mismatch.
    """
    strict = [{"machine": "m"} for _ in range(10)]
    loose = [{"machine": "m"} for _ in range(12)]
    fields, marker = tcomp.pick_fields(strict, loose, index_n=10)
    _check(marker == "strict", "the marker that agrees wins: %r" % marker)
    fields, marker = tcomp.pick_fields(strict, loose, index_n=12)
    _check(marker == "loose", "the loose marker may hold on another era: %r" % marker)
    fields, marker = tcomp.pick_fields(strict, loose, index_n=11)
    _check(marker == "none", "no marker agrees -> refuse: %r" % marker)


# --- pin 9: a partial day's archive must be visible in the output ----------

def pin_partial_day_archive_is_flagged():
    """The archives are not all complete days.

    Measured 30/10: 28/10 holds 49 099 request captures against 47 194
    response captures (a full day), but 27/10 holds only 5 136 requests
    against 57 849 responses. A census of the request captures of 27/10 would
    look complete -- it would print per-machine totals, per-day totals -- and
    it would cover a FRACTION of that day. The share is in the output, so a
    reader can see it before quoting a number.
    """
    full = tcomp.day_completeness(49099, 47194)
    _check(full["day_looks_complete"], "a full day must look complete: %r" % full)
    _check(full["requests_share_of_members"] > 0.5,
           "share: %r" % full["requests_share_of_members"])
    part = tcomp.day_completeness(5136, 57849)
    _check(not part["day_looks_complete"],
           "a partial day must be flagged: %r" % part)
    _check(part["requests_share_of_members"] < 0.5,
           "share: %r" % part["requests_share_of_members"])
    empty = tcomp.day_completeness(0, 0)
    _check(empty["requests_share_of_members"] == 0.0,
           "an empty archive must not divide by zero: %r" % empty)


PINS = [
    pin_denominator_is_assistant_turns,
    pin_passenger_vs_own_turn,
    pin_apikeys_map_counts_as_present,
    pin_envelope_survives_a_body_larger_than_the_head,
    pin_nudge_normalisation_clusters,
    pin_machine_cross_tab_partitions_the_corpus,
    pin_archive_marker_splits_only_on_member_boundaries,
    pin_archive_boundary_mismatch_is_refused,
    pin_partial_day_archive_is_flagged,
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
