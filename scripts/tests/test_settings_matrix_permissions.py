#!/usr/bin/env python3
r"""Tests for the permissions blind spot of settings-matrix.py.

The RooSync `claude-settings` snapshot carries `permissions` as a bare NAME in
`otherTopLevelKeys`, never its content. On 05/11 a fleet ASK read "no Artifact
/ Workflow deny on any machine" off this matrix, while three seats measured
directly (ai-01, po-2024, po-2028) each carried all four deny entries. The
matrix printed nothing about permissions, so silence read as absence.

Pinned here: the run SAYS the deny list is invisible, per machine and once for
the fleet, and stops saying it the day a snapshot publishes the content.

Run standalone:  python scripts/tests/test_settings_matrix_permissions.py
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "settings-matrix.py")

_spec = importlib.util.spec_from_file_location("smx_perm", _TARGET)
smx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smx)

MACHINE = "myia-po-2024"
BLIND_FLEET = "permissions content published by no snapshot (collector blind spot)"
BLIND_SEAT = "permissions: present on the seat, content not published (collector blind spot)"


def _snapshot(other_top=None, harmonization=None):
    return {
        "format": 1,
        "machineId": MACHINE,
        "collectedAt": "2026-11-05T08:00:00.000Z",
        "state": "ok",
        "harmonization": harmonization if harmonization is not None else {},
        "maskedEnvKeys": {},
        "otherTopLevelKeys": other_top if other_top is not None else [],
    }


def _run(snap):
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "configs", MACHINE, "claude-settings", "claude-settings.json")
        os.makedirs(os.path.dirname(path))
        with open(path, "w", encoding="utf-8") as f:
            json.dump(snap, f)
        proc = subprocess.run(
            [sys.executable, _TARGET, "--shared", root, "--stale-hours", "100000", MACHINE],
            capture_output=True, text=True,
        )
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-400:])
    return proc.stdout


def test_live_shape_says_the_deny_list_is_invisible():
    """The live 05/11 shape: `permissions` named, content absent. Both the seat
    line and the fleet flag must appear, or the next reader takes silence for
    "no deny entry"."""
    out = _run(_snapshot(other_top=["effortLevel", "hooks", "permissions"]))
    assert BLIND_SEAT in out, out[-800:]
    assert BLIND_FLEET in out, out[-800:]


def test_published_content_lifts_the_blind_spot():
    """The day the collector publishes the content, both lines go away: the
    matrix can then answer the question itself."""
    out = _run(_snapshot(
        other_top=["permissions"],
        harmonization={"permissions.deny": ["Artifact", "Workflow"]},
    ))
    assert BLIND_SEAT not in out, out[-800:]
    assert BLIND_FLEET not in out, out[-800:]


def test_seat_without_permissions_key_is_not_called_blind():
    """A settings.json with no permissions block at all is a different reading:
    absent, not invisible, and no fleet blind-spot flag."""
    out = _run(_snapshot(other_top=["effortLevel"]))
    assert "permissions: absent from the snapshot" in out, out[-800:]
    assert BLIND_FLEET not in out, out[-800:]


def test_permissions_published_matches_dotted_and_bare_keys():
    """Both flattening shapes a collector could choose count as published."""
    assert smx.permissions_published({"permissions": {"deny": []}})
    assert smx.permissions_published({"permissions.deny": []})
    assert not smx.permissions_published({"permissionsX": 1, "model": "opus"})


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
