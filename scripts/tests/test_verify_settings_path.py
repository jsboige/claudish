#!/usr/bin/env python3
r"""Tests for verify-settings-path.py (claudish #291).

The network and the real settings stay out: every case pins the exact
confusion the issue is about — a declared intent read as if it were live, a
prose-first diff entry whose URL sits AFTER the `=`, a blank value passing
for a path, and a missing file rendering as "clean".

Run standalone:  python scripts/tests/test_verify_settings_path.py
"""

import importlib.util
import json
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "verify-settings-path.py")

_spec = importlib.util.spec_from_file_location("vsp", _TARGET)
vsp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vsp)


# --------------------------------------------------------------------------
# declared_url — the two shapes in the wild, plus the prose-only trap
# --------------------------------------------------------------------------

def test_declared_url_url_first_then_prose():
    """The live po-2023 shape: URL, ' = ', explanation."""
    assert vsp.declared_url("http://127.0.0.1:3000 = relais claudish LOCAL de cette machine (.46)") == \
        "http://127.0.0.1:3000"


def test_declared_url_prose_first_url_after():
    """The other observed shape — the URL sits after the '='; it must still be found."""
    assert vsp.declared_url("routage intentionnel — voir http://192.168.0.50:3000 (hub)") == \
        "http://192.168.0.50:3000"


def test_declared_url_prose_only_is_none_never_invented():
    assert vsp.declared_url("relais local, cf. ticket") is None
    assert vsp.declared_url(None) is None
    assert vsp.declared_url("") is None


def test_declared_url_trailing_slash_normalised():
    assert vsp.declared_url("https://models.myia.io/ = hub WAN") == "https://models.myia.io"


# --------------------------------------------------------------------------
# live_url
# --------------------------------------------------------------------------

def test_live_url_blank_and_whitespace_are_not_a_path():
    assert vsp.live_url("") is None
    assert vsp.live_url("   ") is None
    assert vsp.live_url(None) is None


def test_live_url_plain_value_kept():
    assert vsp.live_url("http://192.168.0.50:3000") == "http://192.168.0.50:3000"


# --------------------------------------------------------------------------
# classify — the whole decision
# --------------------------------------------------------------------------

def test_classify_match():
    v, live, declared = vsp.classify("http://127.0.0.1:3000", "http://127.0.0.1:3000 = relais local")
    assert v == "match" and live == declared == "http://127.0.0.1:3000"


def test_classify_contradiction_is_the_po2023_case():
    """THE case: live hub-direct, declared relay — the 2026-10-06 measurement."""
    v, live, declared = vsp.classify("http://192.168.0.50:3000",
                                     "http://127.0.0.1:3000 = relais claudish LOCAL de cette machine (.46)")
    assert v == "CONTRADICTION", (v, live, declared)
    assert live == "http://192.168.0.50:3000" and declared == "http://127.0.0.1:3000"


def test_classify_trailing_slash_does_not_fake_a_contradiction():
    v, _, _ = vsp.classify("http://127.0.0.1:3000/", "http://127.0.0.1:3000 = relais")
    assert v == "match", v


def test_classify_live_only_intent_only_absent():
    assert vsp.classify("http://a:1", None)[0] == "live-only"
    assert vsp.classify(None, "http://a:1 = x")[0] == "intent-only"
    assert vsp.classify(None, None)[0] == "absent"
    assert vsp.classify("", "")[0] == "absent"


# --------------------------------------------------------------------------
# check_file / main — io, exit codes, secret safety
# --------------------------------------------------------------------------

def _write(tmp, payload):
    p = os.path.join(tmp, "settings.json")
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    return p


def test_check_file_reads_both_blocks():
    with tempfile.TemporaryDirectory() as tmp:
        p = _write(tmp, {"env": {"ANTHROPIC_BASE_URL": "http://192.168.0.50:3000"},
                         "_intentional_diffs": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:3000 = relais"}})
        rows = vsp.check_file(p)
    assert rows[0][1] == "CONTRADICTION", rows


def test_main_exit_codes_and_secret_safety():
    secret = "sk-ant-SUPERSECRET-do-not-print"
    with tempfile.TemporaryDirectory() as tmp:
        p = _write(tmp, {"env": {"ANTHROPIC_AUTH_TOKEN": secret,
                                 "ANTHROPIC_BASE_URL": "http://192.168.0.50:3000"},
                         "_intentional_diffs": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:3000 = relais"}})
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = vsp.main(["--settings", p])
        out = buf.getvalue()
    assert rc == 1, rc                                   # contradiction fails the run
    assert "CONTRADICTION" in out
    assert secret not in out, "the checker must never echo a token"  # secret safety


def test_main_match_exits_zero():
    with tempfile.TemporaryDirectory() as tmp:
        p = _write(tmp, {"env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:3000"},
                         "_intentional_diffs": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:3000 = relais"}})
        assert vsp.main(["--settings", p]) == 0


def test_main_missing_file_is_error_never_clean():
    rc = vsp.main(["--settings", os.path.join(tempfile.gettempdir(), "definitely-absent-xyz.json")])
    assert rc == 2, rc


def test_main_json_mode_shape():
    with tempfile.TemporaryDirectory() as tmp:
        p = _write(tmp, {"env": {"ANTHROPIC_BASE_URL": "http://192.168.0.50:3000"}})
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            vsp.main(["--settings", p, "--json"])
        rows = json.loads(buf.getvalue())
    assert rows[0]["verdict"] == "live-only" and rows[0]["declared"] is None, rows


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
