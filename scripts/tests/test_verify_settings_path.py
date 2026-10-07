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


# --------------------------------------------------------------------------
# CR #369 — secrets in the URL slots, malformed files, prose fallback
# --------------------------------------------------------------------------

def _run_main(argv):
    import io
    from contextlib import redirect_stdout
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = vsp.main(argv)
    return rc, buf.getvalue()


def test_live_userinfo_masked_in_text_output():
    """Basic-auth userinfo rides real fleet URLs; the witness output is meant
    to be pasted into dashboards — the password must never survive."""
    password = "s3cret-hunter2"
    with tempfile.TemporaryDirectory() as tmp:
        p = _write(tmp, {"env": {"ANTHROPIC_BASE_URL":
                                 "https://alice:%s@proxy.example:3000" % password}})
        rc, out = _run_main(["--settings", p])
    assert rc == 0, rc
    assert password not in out, "userinfo password leaked in text output"
    assert "https://***@proxy.example:3000" in out, out


def test_live_userinfo_masked_in_json_output():
    with tempfile.TemporaryDirectory() as tmp:
        p = _write(tmp, {"env": {"ANTHROPIC_BASE_URL": "https://alice:s3cret@proxy.example:3000"}})
        rc, out = _run_main(["--settings", p, "--json"])
    assert rc == 0, rc
    assert "s3cret" not in out, "userinfo password leaked in --json output"
    rows = json.loads(out)
    assert rows[0]["live"] == "https://***@proxy.example:3000", rows


def test_raw_at_userinfo_masked():
    """R0 (#369 review): a userinfo that starts right at `//` — empty userinfo
    (`//@host`) or a second `@` inside it (`//@secret@host`) — masks like any
    other. The old `//[^/@\s]+@` required one non-@ char first and let
    `//@secret@host` reach the output whole."""
    secret = "sk-ant-raw-at-leak"
    for raw, masked in [
        ("https://@proxy.example:3000", "https://***@proxy.example:3000"),
        ("https://@%s@proxy.example:3000" % secret, "https://***@proxy.example:3000"),
    ]:
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, {"env": {"ANTHROPIC_BASE_URL": raw}})
            rc, out = _run_main(["--settings", p, "--json"])
        assert rc == 0, rc
        assert secret not in out, "raw-@ userinfo leaked for %r" % raw
        rows = json.loads(out)
        assert rows[0]["live"] == masked, (raw, rows)


def test_at_in_path_alone_does_not_mask():
    """The mask's class stops at the path: an `@` after the first `/` is part of
    the path, not userinfo — the URL must pass through untouched (a mask here
    would garble a clean URL's path in the matrix)."""
    url = "http://proxy.example:3000/team@review/export"
    assert vsp.mask_url(url) == url


def test_at_in_query_alone_does_not_mask():
    """#380 R1: the RFC 3986 authority ends at `?` too. A pathless URL whose `@`
    lives in the query was over-masked to `http://***@b.c` (garbled, unreadable
    in the matrix — measured); it must pass through untouched."""
    url = "http://host:3000?mail=a@b.c"
    assert vsp.mask_url(url) == url


def test_at_in_fragment_alone_does_not_mask():
    """#380 R1: same discipline for `#` — an `@` in the fragment is not
    userinfo."""
    url = "http://host:3000#team@review"
    assert vsp.mask_url(url) == url


def test_real_userinfo_still_masks_query_survives():
    """#380 R1: tightening the class must not weaken the mask — a real
    `//user:pass@` is still fully replaced (nothing after the authority,
    query included, is touched)."""
    masked = vsp.mask_url("http://user:secret@host:3000?mail=a@b.c")
    assert masked == "http://***@host:3000?mail=a@b.c", masked


def test_token_pasted_in_base_url_is_no_url_never_the_token():
    """A credential pasted into the wrong slot has no URL shape: report the
    sentinel, never echo the value."""
    token = "sk-ant-api03-TOKENBODY-never-print"
    with tempfile.TemporaryDirectory() as tmp:
        p = _write(tmp, {"env": {"ANTHROPIC_BASE_URL": token},
                         "_intentional_diffs": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:3000 = relais"}})
        rc, out = _run_main(["--settings", p])
    assert rc == 1, rc                       # no-URL live vs a declared URL = contradiction
    assert token not in out, "the whole token was echoed"
    assert "no-url" in out, out


def test_no_url_live_without_declaration_is_live_only():
    with tempfile.TemporaryDirectory() as tmp:
        p = _write(tmp, {"env": {"ANTHROPIC_BASE_URL": "garbage-not-a-url"}})
        rc, out = _run_main(["--settings", p])
    assert rc == 0, rc
    assert "live-only" in out and "no-url" in out, out
    assert "garbage-not-a-url" not in out, out


def test_declared_prose_userinfo_masked():
    with tempfile.TemporaryDirectory() as tmp:
        p = _write(tmp, {"env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:3000"},
                         "_intentional_diffs": {"ANTHROPIC_BASE_URL":
                                                "routage — voir http://bob:hunter2@relay.local:3000 (ancien)"}})
        rc, out = _run_main(["--settings", p])
    assert rc == 1, rc
    assert "hunter2" not in out, "declared userinfo leaked"
    assert "http://***@relay.local:3000" in out, out


def test_malformed_root_array_is_exit_2_not_contradiction():
    """A top-level JSON array is UNREADABLE (exit 2) — a cron caller reading
    the exit code must not take it for a contradiction (exit 1)."""
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "settings.json")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("[1, 2, 3]")
        rc, _ = _run_main(["--settings", p])
    assert rc == 2, rc


def test_env_not_an_object_is_exit_2_not_contradiction():
    with tempfile.TemporaryDirectory() as tmp:
        p = _write(tmp, {"env": "oops", "_intentional_diffs": {}})
        rc, _ = _run_main(["--settings", p])
    assert rc == 2, rc


def test_prose_fallback_takes_last_url():
    """An annotation naming the old path then its replacement declares the
    replacement — taking the FIRST URL would mask a silent revert (the exact
    defect #291 tracks)."""
    assert vsp.declared_url(
        "ancien chemin http://192.168.0.50:3000 remplace par http://127.0.0.1:3000 (relais)"
    ) == "http://127.0.0.1:3000"


def test_schemeless_live_matches_schemed_declared():
    """`127.0.0.1:3000` is the curl form of `http://127.0.0.1:3000` — the
    pair is one path, not a contradiction."""
    v, live, declared = vsp.classify("127.0.0.1:3000", "http://127.0.0.1:3000 = relais local")
    assert v == "match", (v, live, declared)


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
