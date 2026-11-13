#!/usr/bin/env python3
r"""Pins for served-model-share.py (PR #1005, CR c.6829068200).

The instrument reads who served each turn (`message.model`) against what the
client asked (`requestedModel`). Four counting traps are pinned here, three
of them found in review:

  1. one API response writes one entry PER CONTENT BLOCK, all sharing the
     same `requestRef` — three blocks are ONE turn;
  2. the window filter reads the ENTRY timestamp, never the file mtime;
  3. `isApiErrorMessage` sits at the TOP level of the entry, not inside
     `message` — the wrong nesting counts error turns as served
     (`<synthetic>`) and leaves the error column at 0 forever;
  4. runs are built PER SESSION — mixing sessions reads as flapping.

Plus one mutation pin on the dedup guard (keyed on requestRef, not uuid).

Run: python scripts/tests/test_served_model_share.py
"""

import datetime as dt
import importlib.util
import json
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "served-model-share.py")

_spec = importlib.util.spec_from_file_location("sms_share", _TARGET)
sms = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sms)


def _entry(ts, model="swift-1.5-27b", request_ref="r1", uuid="u1",
           session="sess-1", api_error=False, requested="claude-haiku-5-5"):
    d = {
        "type": "assistant",
        "uuid": uuid,
        "sessionId": session,
        "timestamp": ts,
        "requestRef": request_ref,
        "requestedModel": requested,
        "message": {"role": "assistant", "model": model},
    }
    if api_error:
        # CR #1005: the flag lives HERE, next to requestRef — not in message.
        d["isApiErrorMessage"] = True
        d["message"]["model"] = model
    return json.dumps(d, separators=(",", ":")) + "\n"


def _write(root, name, lines):
    # compact separators: real transcripts are compact, and the collect()
    # prefilter matches the compact form of "model".
    with open(os.path.join(root, name), "w", encoding="utf-8") as f:
        f.writelines(lines)


def _since(day="2026-11-01"):
    return dt.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)


def _total_served(served):
    return sum(sum(m.values()) for m in served.values())


# ---------------------------------------------------------------------------
# Trap 1 — requestRef dedup
# ---------------------------------------------------------------------------

def test_three_blocks_one_request_ref_count_one_turn():
    """Three entries of one response (apiBlockIndex 0,1,2 share a requestRef)
    must count as ONE turn, not three."""
    with tempfile.TemporaryDirectory() as root:
        _write(root, "a.jsonl", [
            _entry("2026-11-10T10:00:00.000Z", request_ref="r1", uuid="u1"),
            _entry("2026-11-10T10:00:00.500Z", request_ref="r1", uuid="u2"),
            _entry("2026-11-10T10:00:01.000Z", request_ref="r1", uuid="u3"),
        ])
        served, requested, apierr, events = sms.collect([root], _since())
    assert _total_served(served) == 1, "3 blocks of one response must count once"
    assert len(events) == 1
    assert apierr == {}


def test_dedup_guard_keys_on_requestRef_not_uuid():
    """Mutation pin for the dedup guard: one response, two block entries,
    SAME requestRef, DIFFERENT uuids. Keying the dedup on uuid (or on
    file+timestamp) counts two turns and this goes red."""
    with tempfile.TemporaryDirectory() as root:
        _write(root, "a.jsonl", [
            _entry("2026-11-10T10:00:00.000Z", request_ref="same-ref", uuid="uA"),
            _entry("2026-11-10T10:00:00.400Z", request_ref="same-ref", uuid="uB"),
        ])
        served, _, _, events = sms.collect([root], _since())
    assert _total_served(served) == 1, "the dedup key is requestRef, not uuid"


# ---------------------------------------------------------------------------
# Trap 2 — the window filter reads the entry, not the file
# ---------------------------------------------------------------------------

def test_old_entry_in_freshly_touched_file_stays_out():
    """A file written NOW (mtime fresh) holding an entry from before --since
    contributes nothing. The filter is on the entry timestamp; an mtime
    filter would inflate a busy workspace by an order of magnitude."""
    with tempfile.TemporaryDirectory() as root:
        _write(root, "fresh.jsonl", [
            _entry("2026-10-01T10:00:00.000Z"),           # before --since
            _entry("2026-11-10T10:00:00.000Z", request_ref="r2", uuid="u2"),
        ])
        served, _, _, events = sms.collect([root], _since("2026-11-01"))
    assert _total_served(served) == 1, "only the entry inside the window counts"
    assert all(e[0] >= _since("2026-11-01") for e in events)


# ---------------------------------------------------------------------------
# Trap 3 — isApiErrorMessage is at the top level
# ---------------------------------------------------------------------------

def test_top_level_api_error_counts_in_apierr_not_served():
    """The error flag is a sibling of requestRef. With the wrong nesting
    (message.get only) the error column stays 0 forever and the error turn
    lands in `served` as `<synthetic>` — the exact bug of CR #1005."""
    with tempfile.TemporaryDirectory() as root:
        _write(root, "a.jsonl", [
            _entry("2026-11-10T10:00:00.000Z", request_ref="ok-1", uuid="u1"),
            _entry("2026-11-10T10:01:00.000Z", request_ref="err-1", uuid="u2",
                   model="<synthetic>", api_error=True),
        ])
        served, _, apierr, events = sms.collect([root], _since())
    assert _total_served(served) == 1, "an API error turn is never a served turn"
    assert sum(apierr.values()) == 1, "the top-level flag must reach the error column"
    assert len(events) == 1


# ---------------------------------------------------------------------------
# Trap 4 — runs are per session, split at --gap-min
# ---------------------------------------------------------------------------

def test_run_split_at_gap_min():
    """At --gap-min 10, turns 9 min apart join into one run; turns 11 min
    apart split into two. Pins both sides of the boundary in one fixture:
    10:00+10:09 (9 min) -> one run of 2; 12:00+12:11 (11 min) -> two runs
    of 1 each."""
    events = [
        (_dt("2026-11-10T10:00:00Z"), "sess-1", "swift-1.5-27b"),
        (_dt("2026-11-10T10:09:00Z"), "sess-1", "swift-1.5-27b"),
        (_dt("2026-11-10T12:00:00Z"), "sess-1", "swift-1.5-27b"),
        (_dt("2026-11-10T12:11:00Z"), "sess-1", "swift-1.5-27b"),
    ]
    runs = sms.build_runs(events, 10)
    assert len(runs) == 3, [(r[0].isoformat(), r[3]) for r in runs]
    assert sorted(r[3] for r in runs) == [1, 1, 2]
    # the joined pair is the FIRST run; the split pair is the two singletons
    assert runs[0][3] == 2 and runs[0][0] == _dt("2026-11-10T10:00:00Z"), runs


def test_runs_never_span_sessions():
    """Two live sessions alternating on the wire, each steady on its model:
    two runs of two turns, not a stream of n=1 runs that reads as flapping."""
    events = [
        (_dt("2026-11-10T10:00:00Z"), "sess-A", "swift-1.5-27b"),
        (_dt("2026-11-10T10:02:00Z"), "sess-B", "MiniMax-M3.1-Flash"),
        (_dt("2026-11-10T10:04:00Z"), "sess-A", "swift-1.5-27b"),
        (_dt("2026-11-10T10:06:00Z"), "sess-B", "MiniMax-M3.1-Flash"),
    ]
    runs = sms.build_runs(events, 10)
    assert len(runs) == 2, [(r[0].isoformat(), r[2], r[4]) for r in runs]
    assert sorted(r[3] for r in runs) == [2, 2]
    assert {r[4] for r in runs} == {"sess-A", "sess-B"}, "each run carries its session"


def _dt(s):
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


if __name__ == "__main__":
    _passed = failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                _passed += 1
                print("PASS %s" % name)
            except AssertionError as e:
                failures += 1
                print("FAIL %s: %s" % (name, e))
            except Exception as e:
                failures += 1
                print("ERROR %s: %r" % (name, e))
    print("--- %d passed, %d failed" % (_passed, failures))
    sys.exit(1 if failures else 0)