#!/usr/bin/env python3
r"""Tests for the credential shapes settings-matrix.py reports.

Two shapes are visible from a masked snapshot, and only one of them used to be
reported:

  shape B  a credential that is PRESENT and VALUABLE -- the client would send it
           instead of its Anthropic login (#296, measured 30/09-01/10 on the WAN seat)
  shape C  a credential that is PRESENT but VALUELESS (an empty string)

Shape C is what myia-po-2023 has carried since at least 29/10:
`ANTHROPIC_AUTH_TOKEN = ""` in the seat's settings.json. The matrix printed it as
"empty" and flagged NOTHING. Measured consequences, same cycle, 30/10:

  - the proxy never sees it: the request is authenticated by the cluster key
    (`x-proxy-key`), and the hub answered 200 to an empty `Bearer ` header and to
    a request with no authorization header at all (709 ms / 765 ms);
  - the Claude Code client is unaffected (the seat's own session runs through it);
  - every SDK-based probe inherits the seat's environment and dies on it:
    httpx refuses to send an invalid header value ("Illegal header value
    b'Bearer '"), which fails the call before any byte reaches the proxy.

So the shape is invisible to the matrix, harmless to the client, and fatal to the
tooling that reads the environment. It gets its own flag.

Run standalone:  python scripts/tests/test_settings_matrix_credentials.py
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "settings-matrix.py")

_spec = importlib.util.spec_from_file_location("smx_cred", _TARGET)
smx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smx)


def _joined(flags):
    return "\n".join(flags)


# --------------------------------------------------------------------------
# The live po-2023 shape, measured 30/10 (positive control of the mandate)
# --------------------------------------------------------------------------

def test_empty_credential_is_flagged():
    """po-2023's live shape: ANTHROPIC_AUTH_TOKEN declared, value empty.
    Before this change the matrix printed it and flagged nothing."""
    flags = _joined(smx.credential_flags("myia-po-2023", {"ANTHROPIC_AUTH_TOKEN": "<empty>"}))
    assert "myia-po-2023: env.ANTHROPIC_AUTH_TOKEN" in flags, flags
    assert "declared but valueless" in flags, flags
    # It is NOT the #296 shape B: no credential is sent.
    assert "shape B" not in flags, flags


def test_set_credential_still_flagged_as_shape_b():
    """Regression: the shape B flag (client sends its own credential) must survive."""
    flags = _joined(smx.credential_flags("myia-po-2028", {"ANTHROPIC_API_KEY": "<set>"}))
    assert "myia-po-2028: env.ANTHROPIC_API_KEY" in flags, flags
    assert "#296 shape B" in flags, flags
    assert "declared but valueless" not in flags, flags


# --------------------------------------------------------------------------
# What must stay silent
# --------------------------------------------------------------------------

def test_unset_credential_is_not_flagged():
    """An unset credential is the normal case -- no flag."""
    flags = _joined(smx.credential_flags("myia-po-2027", {"ANTHROPIC_AUTH_TOKEN": "<unset>"}))
    assert flags == "", flags


def test_non_credential_key_is_not_flagged():
    """A non-credential env key never produces a credential flag, whatever its class."""
    for marker in ("<set>", "<empty>", "<unset>"):
        flags = _joined(smx.credential_flags("myia-po-2023", {"ANTHROPIC_BASE_URL": marker}))
        assert flags == "", (marker, flags)


def test_both_credential_keys_are_watched():
    """Both credential keys carry the same rule -- ANTHROPIC_API_KEY too."""
    flags = _joined(smx.credential_flags(
        "myia-po-2023", {"ANTHROPIC_API_KEY": "<empty>", "ANTHROPIC_AUTH_TOKEN": "<empty>"}))
    assert "env.ANTHROPIC_API_KEY" in flags, flags
    assert "env.ANTHROPIC_AUTH_TOKEN" in flags, flags


def test_missing_masked_map_is_silent():
    """A snapshot without maskedEnvKeys must not crash the reader."""
    assert smx.credential_flags("myia-po-2023", None) == []
    assert smx.credential_flags("myia-po-2023", {}) == []


def _write_snapshot(root, machine, masked):
    d = os.path.join(root, "configs", machine, "v1.0.0-2026-10-30T00-00-00-000Z", "claude-settings")
    os.makedirs(d)
    snap = {
        "format": 1,
        "machineId": machine,
        "collectedAt": "2026-10-30T00:00:00.000Z",
        "state": "ok",
        "harmonization": {},
        "maskedEnvKeys": masked,
        "otherTopLevelKeys": [],
    }
    with open(os.path.join(d, "claude-settings.json"), "w", encoding="utf-8") as f:
        json.dump(snap, f)


def test_exit_status_stays_zero_with_a_flag():
    """The reader is a reader: flags are printed, the exit status stays 0.

    Pinned executably (review ai-01, 30/10): the rule used to hold only by
    construction, since no test called main()."""
    with tempfile.TemporaryDirectory() as root:
        _write_snapshot(root, "myia-po-2023", {"ANTHROPIC_AUTH_TOKEN": "<empty>"})
        proc = subprocess.run(
            [sys.executable, _TARGET, "--shared", root, "myia-po-2023"],
            capture_output=True, text=True,
        )
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-400:])
    assert "declared but valueless" in proc.stdout, proc.stdout[-800:]


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
