#!/usr/bin/env python3
r"""Tests for how settings-matrix.py finds (and fails to find) a snapshot.

`latest_snapshot()` is the only thing standing between the fleet's settings
posture and a wrong answer. Everything the coordinator reads per machine -- the
harmonized values, the credential shapes, the canon flags -- is downstream of
"which file did you open". Two failures are silent by construction:

  - a machine resolved to a STALE package when a fresher one exists (the reader
    then reports yesterday's settings as if they were today's);
  - a machine reported NOT COVERED when a snapshot is right there (it drops off
    the fleet reading entirely -- this is the class that put myia-po-2024 on the
    NOT COVERED list for a week, 01/11).

Neither throws. Neither prints anything unusual. Both are pinned here.

The documented lookup order (mirrors RSM's findLatestClaudeSettingsSnapshot):
standalone `claude-settings/claude-settings.json` -> `latest.json` pointer ->
versioned packages, best by `collectedAt`.

Run standalone:  python scripts/tests/test_settings_matrix_coverage.py
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "settings-matrix.py")

_spec = importlib.util.spec_from_file_location("smx_cov", _TARGET)
smx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smx)

MACHINE = "myia-po-2024"


# --------------------------------------------------------------------------
# Fixtures -- a shared tree shaped like the real one
# --------------------------------------------------------------------------

def _snapshot(collected_at, state="ok", harmonization=None):
    return {
        "format": 1,
        "machineId": MACHINE,
        "collectedAt": collected_at,
        "state": state,
        "harmonization": harmonization if harmonization is not None else {},
        "maskedEnvKeys": {},
        "otherTopLevelKeys": [],
    }


def _write(path, snap):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(snap, f)


def _versioned(root, name, snap):
    d = os.path.join(root, "configs", MACHINE, name, "claude-settings")
    _write(os.path.join(d, "claude-settings.json"), snap)
    return os.path.dirname(d)


def _standalone(root, snap):
    _write(os.path.join(root, "configs", MACHINE, "claude-settings", "claude-settings.json"), snap)


def _pointer(root, target):
    cdir = os.path.join(root, "configs", MACHINE)
    os.makedirs(cdir, exist_ok=True)
    with open(os.path.join(cdir, "latest.json"), "w", encoding="utf-8") as f:
        json.dump({"version": "x", "timestamp": "x", "path": target}, f)


def _raw(root, rel, text):
    path = os.path.join(root, "configs", MACHINE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


# --------------------------------------------------------------------------
# NOT COVERED -- the silent drop-off
# --------------------------------------------------------------------------

def test_absent_machine_dir_is_not_covered():
    """No directory at all resolves to None -- the NOT COVERED branch, not a crash."""
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, "configs"))
        assert smx.latest_snapshot(root, MACHINE) is None


def test_empty_machine_dir_is_not_covered():
    """A directory holding no snapshot (the live po-2024 shape before 31/10)."""
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, "configs", MACHINE))
        assert smx.latest_snapshot(root, MACHINE) is None


def test_not_covered_is_printed_as_absence_not_silence():
    """The reading must SAY it is uncovered: silence would read as compliance."""
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, "configs", MACHINE))
        proc = subprocess.run(
            [sys.executable, _TARGET, "--shared", root, MACHINE],
            capture_output=True, text=True,
        )
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-400:])
    assert "NOT COVERED: no claude-settings snapshot published" in proc.stdout, proc.stdout[-800:]
    assert "%s: NOT COVERED" % MACHINE in proc.stdout, proc.stdout[-800:]


# --------------------------------------------------------------------------
# The documented lookup order
# --------------------------------------------------------------------------

def test_standalone_snapshot_wins_over_versioned():
    """Order rule 1: `claude-settings/claude-settings.json` is consulted first.

    It wins even when a versioned package is FRESHER -- the standalone file is the
    seat's live publish, and reordering this silently reverts a machine to an
    older package."""
    with tempfile.TemporaryDirectory() as root:
        _standalone(root, _snapshot("2026-10-20T00:00:00.000Z"))
        _versioned(root, "v1-2026-10-31T00-00-00-000Z", _snapshot("2026-10-31T00:00:00.000Z"))
        snap = smx.latest_snapshot(root, MACHINE)
    assert snap is not None
    assert snap["collectedAt"] == "2026-10-20T00:00:00.000Z", snap["collectedAt"]


def test_latest_pointer_resolves():
    """Order rule 2: the `latest.json` pointer outranks the versioned scan.

    A pointer exists precisely to name the winner; ignoring it while a newer
    package sits nearby would make publish order irrelevant."""
    with tempfile.TemporaryDirectory() as root:
        pointed = _versioned(root, "v1-2026-10-20T00-00-00-000Z", _snapshot("2026-10-20T00:00:00.000Z"))
        _versioned(root, "v1-2026-10-31T00-00-00-000Z", _snapshot("2026-10-31T00:00:00.000Z"))
        _pointer(root, pointed)
        snap = smx.latest_snapshot(root, MACHINE)
    assert snap is not None
    assert snap["collectedAt"] == "2026-10-20T00:00:00.000Z", snap["collectedAt"]


def test_dead_pointer_falls_through_to_the_versioned_scan():
    """A pointer at a directory that no longer exists must not report NOT COVERED
    while a readable package is right there."""
    with tempfile.TemporaryDirectory() as root:
        _versioned(root, "v1-2026-10-31T00-00-00-000Z", _snapshot("2026-10-31T00:00:00.000Z"))
        _pointer(root, os.path.join(root, "configs", MACHINE, "v1-gone-2026-01-01T00-00-00-000Z"))
        snap = smx.latest_snapshot(root, MACHINE)
    assert snap is not None
    assert snap["collectedAt"] == "2026-10-31T00:00:00.000Z", snap["collectedAt"]


def test_versioned_fallback_picks_by_collected_at_not_by_directory_name():
    """Order rule 3: the winner is the greatest `collectedAt`, never the name.

    The two orders are deliberately opposed here: the alphabetically LATER
    directory carries the EARLIER collection. A name-sorted fallback would serve
    yesterday's settings and say nothing."""
    with tempfile.TemporaryDirectory() as root:
        _versioned(root, "v9-2026-10-20T00-00-00-000Z", _snapshot("2026-10-20T00:00:00.000Z"))
        _versioned(root, "v1-2026-10-31T00-00-00-000Z", _snapshot("2026-10-31T00:00:00.000Z"))
        snap = smx.latest_snapshot(root, MACHINE)
    assert snap is not None
    assert snap["collectedAt"] == "2026-10-31T00:00:00.000Z", snap["collectedAt"]


# --------------------------------------------------------------------------
# What does NOT count as a snapshot
# --------------------------------------------------------------------------

def test_foreign_or_broken_payload_is_skipped():
    """`format != 1`, a missing `harmonization`, invalid JSON and a non-object
    payload are all "no snapshot" -- never a half-read one."""
    cases = {
        "wrong-format": json.dumps(_snapshot("2026-10-31T00:00:00.000Z") | {"format": 2}),
        "no-harmonization": json.dumps({k: v for k, v in _snapshot("2026-10-31T00:00:00.000Z").items()
                                        if k != "harmonization"}),
        "invalid-json": "{not json",
        "array-payload": "[]",
    }
    for label, text in cases.items():
        with tempfile.TemporaryDirectory() as root:
            _raw(root, os.path.join("claude-settings", "claude-settings.json"), text)
            assert smx.latest_snapshot(root, MACHINE) is None, label


def test_a_broken_standalone_falls_through_to_a_good_versioned_package():
    """The skip is a fall-through, not a dead end: an unreadable standalone must
    not hide the versioned package behind it."""
    with tempfile.TemporaryDirectory() as root:
        _raw(root, os.path.join("claude-settings", "claude-settings.json"), "{truncated")
        _versioned(root, "v1-2026-10-31T00-00-00-000Z", _snapshot("2026-10-31T00:00:00.000Z"))
        snap = smx.latest_snapshot(root, MACHINE)
    assert snap is not None
    assert snap["collectedAt"] == "2026-10-31T00:00:00.000Z", snap["collectedAt"]


def test_non_versioned_sibling_directories_are_not_scanned():
    """The fallback only walks entries starting with `v` -- `archived-*`, `latest`
    and friends are not candidates (they hold no publish of their own)."""
    with tempfile.TemporaryDirectory() as root:
        _versioned(root, "archived-vv1.0.1-old", _snapshot("2026-10-31T00:00:00.000Z"))
        assert smx.latest_snapshot(root, MACHINE) is None


# --------------------------------------------------------------------------
# Freshness -- the other half of the reading
# --------------------------------------------------------------------------

def test_fresh_snapshot_is_not_flagged_stale():
    """Inside the window: no staleness flag (the reading is usable as today's)."""
    with tempfile.TemporaryDirectory() as root:
        _versioned(root, "v1-fresh", _snapshot("2026-10-31T23:50:25.255Z"))
        proc = subprocess.run(
            [sys.executable, _TARGET, "--shared", root, "--stale-hours", "48", MACHINE],
            capture_output=True, text=True,
        )
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-400:])
    assert "snapshot stale" not in proc.stdout, proc.stdout[-800:]


def test_old_snapshot_is_flagged_stale():
    """Outside the window: flagged, and named by its collectedAt so the reader
    knows HOW old -- a bare "stale" would not say whether it is one hour or one week."""
    with tempfile.TemporaryDirectory() as root:
        _versioned(root, "v1-old", _snapshot("2020-01-01T00:00:00.000Z"))
        proc = subprocess.run(
            [sys.executable, _TARGET, "--shared", root, "--stale-hours", "1", MACHINE],
            capture_output=True, text=True,
        )
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-400:])
    assert "snapshot stale (2020-01-01T00:00:00.000Z)" in proc.stdout, proc.stdout[-800:]


def test_missing_collected_at_reads_as_stale_not_as_fresh():
    """An unparseable or absent collectedAt is "no age signal" -- the reader must
    not assume fresh. (Same rule as a null count in the drain: absence of a signal
    is not a signal.)"""
    with tempfile.TemporaryDirectory() as root:
        snap = _snapshot("")
        _versioned(root, "v1-undated", snap)
        assert smx.age_hours(snap.get("collectedAt"), smx.dt.datetime.now(smx.dt.timezone.utc)) is None
        proc = subprocess.run(
            [sys.executable, _TARGET, "--shared", root, MACHINE],
            capture_output=True, text=True,
        )
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-400:])
    assert "snapshot stale" in proc.stdout, proc.stdout[-800:]


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
