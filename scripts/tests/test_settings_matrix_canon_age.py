#!/usr/bin/env python3
r"""Pins for the snapshot-age qualification of settings-matrix.py CANON flags (#291).

An off-canon flag used to be a bare claim: `X = 250000 off canon (expected
230000)`. On 11-12/11 the coordinator published 330000 (ai-01, po-2023) and
250000 (po-2028) as off-canon while every seat was actually AT canon -- the
values came from RooSync snapshots older than the live settings.json files.

A snapshot can only testify about a seat at `collectedAt`. The rule pinned here:

  1. every off-canon flag prints the AGE of its snapshot;
  2. past a threshold (parameter, default 24 h) -- or when `collectedAt` cannot
     be dated -- the flag reports an expired reading and sends the reader to
     the live file, and it NEVER reads as a measured off-canon;
  3. the threshold is a parameter, honored end-to-end through main().

Run: python scripts/tests/test_settings_matrix_canon_age.py
"""

import datetime as dt
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "settings-matrix.py")

_spec = importlib.util.spec_from_file_location("smx_canon_age", _TARGET)
smx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smx)

KEY = "env.CLAUDE_CODE_AUTO_COMPACT_WINDOW"
# Read the canonical expectation from the script itself, and pick a value that
# cannot collide with it: a future canon change must not rot this pin.
EXPECTED = smx.CANON[KEY]["*"]
ACTUAL = "199999"
assert ACTUAL != EXPECTED, "fixture value collides with the live canon"


# --------------------------------------------------------------------------
# The guard, unit-level
# --------------------------------------------------------------------------

def test_fresh_off_canon_flag_prints_its_age():
    """Within the threshold the flag is a measured divergence -- and still dated."""
    flag = smx.canon_flag("myia-po-2028", KEY, ACTUAL, EXPECTED, 2.5, 24.0)
    assert "off canon" in flag, flag
    assert "snapshot age 2.5h" in flag, flag
    assert "STALE" not in flag, flag


def test_stale_snapshot_never_reads_as_off_canon():
    """Past the threshold: expired reading, re-read live, NOT a measured gap.

    This is the 11-12/11 failure itself: a 30 h snapshot must not testify.
    """
    flag = smx.canon_flag("myia-po-2028", KEY, ACTUAL, EXPECTED, 30.5, 24.0)
    assert "STALE" in flag, flag
    assert "re-read live" in flag, flag
    assert "off canon" not in flag, flag
    # the operator must still see WHAT to verify, and with what canon
    assert ACTUAL in flag and EXPECTED in flag, flag
    assert "30.5h" in flag, flag


def test_undatable_snapshot_is_stale():
    """`collectedAt` missing or unparsable: the snapshot cannot be dated, so it
    can never back a measured off-canon claim."""
    flag = smx.canon_flag("myia-po-2028", KEY, ACTUAL, EXPECTED, None, 24.0)
    assert "STALE" in flag and "age unknown" in flag, flag
    assert "off canon" not in flag, flag


def test_threshold_boundary_is_strict():
    """Exactly at the threshold is still fresh; anything above it is stale.

    Pins the comparison's direction: inverting `>` to `<` (or `>=`) turns one
    side of this pin red.
    """
    at = smx.canon_flag("myia-po-2028", KEY, ACTUAL, EXPECTED, 24.0, 24.0)
    above = smx.canon_flag("myia-po-2028", KEY, ACTUAL, EXPECTED, 24.01, 24.0)
    assert "STALE" not in at, at
    assert "STALE" in above, above


def test_threshold_is_read_from_the_caller():
    """The boundary moves with the parameter, not with a hardcoded 24."""
    lenient = smx.canon_flag("myia-po-2028", KEY, ACTUAL, EXPECTED, 30.0, 48.0)
    strict = smx.canon_flag("myia-po-2028", KEY, ACTUAL, EXPECTED, 30.0, 12.0)
    assert "STALE" not in lenient, lenient
    assert "STALE" in strict, strict


# --------------------------------------------------------------------------
# End-to-end: the flag that main() prints carries the qualification
# --------------------------------------------------------------------------

def _write_snapshot(root, machine, hours_old, value):
    d = os.path.join(root, "configs", machine, "v1.0.0-fixture", "claude-settings")
    os.makedirs(d)
    collected = (
        dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours_old)
    ).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    snap = {
        "format": 1,
        "machineId": machine,
        "collectedAt": collected,
        "state": "ok",
        "harmonization": {KEY: value},
        "maskedEnvKeys": {},
        "otherTopLevelKeys": [],
    }
    with open(os.path.join(d, "claude-settings.json"), "w", encoding="utf-8") as f:
        json.dump(snap, f)


def _main(*argv):
    return subprocess.run(
        [sys.executable, _TARGET, *argv],
        capture_output=True, text=True, encoding="utf-8",
    )


def test_main_default_threshold_marks_a_30h_snapshot_stale():
    """No flag passed: the default (24 h) governs. A 30 h snapshot is expired."""
    with tempfile.TemporaryDirectory() as root:
        _write_snapshot(root, "myia-po-2028", 30, ACTUAL)
        proc = _main("--shared", root, "myia-po-2028")
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-400:])
    assert "STALE" in proc.stdout, proc.stdout[-800:]
    assert "re-read live" in proc.stdout, proc.stdout[-800:]
    assert "off canon" not in proc.stdout, proc.stdout[-800:]


def test_main_canon_stale_hours_is_honored():
    """Same 30 h fixture, threshold raised to 48 h: a measured off-canon again."""
    with tempfile.TemporaryDirectory() as root:
        _write_snapshot(root, "myia-po-2028", 30, ACTUAL)
        proc = _main("--shared", root, "--canon-stale-hours", "48", "myia-po-2028")
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-400:])
    assert "off canon" in proc.stdout, proc.stdout[-800:]
    assert "STALE" not in proc.stdout, proc.stdout[-800:]
    assert "snapshot age" in proc.stdout, proc.stdout[-800:]


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