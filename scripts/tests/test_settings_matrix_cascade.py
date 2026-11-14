#!/usr/bin/env python3
r"""Pins for the container-cascade section of settings-matrix.py (#711 grain 2).

The coordinator's tenue asked for a recurrent control of the container's
`CLAUDISH_FAILOVER_*` env: one FINGERPRINT per variable, a deviation from the
canon flagged, and -- the pin this file exists for -- a test that BREAKS on a
value change while the variable count stays equal. A count-based comparison
passes that exact failure; a name -> sha8(value) comparison cannot.

Run: python scripts/tests/test_settings_matrix_cascade.py
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "settings-matrix.py")

_spec = importlib.util.spec_from_file_location("smx_cascade", _TARGET)
smx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smx)

SECRET_KEY = "super-secret-cluster-key"
SECRET_API = "sk-ant-not-for-a-matrix"
ENV_DUMP = "\n".join([
    "PATH=/usr/local/bin:/usr/bin",
    "CLAUDISH_PROXY_KEY=%s" % SECRET_KEY,
    "ANTHROPIC_API_KEY=%s" % SECRET_API,
    "CLAUDISH_FAILOVER_ACTIVE=",
    "CLAUDISH_FAILOVER_AUTO=1",
    "CLAUDISH_FAILOVER_FABLE=role:opus",
    "CLAUDISH_FAILOVER_HAIKU=",
    "CLAUDISH_FAILOVER_OPUS=role:sonnet",
    "CLAUDISH_FAILOVER_ROLE_MODELS=glm-5.3:sonnet",
    "CLAUDISH_FAILOVER_SONNET=ds@deepseek-flash",
    "CLAUDISH_FAILOVER_STEP_EXCLUDE=",
    "CLAUDISH_FAILOVER_SONNET_LABEL=DeepSeek Flash PAYG",
    "CLAUDISH_FAILOVER_SONNET_DIRECTION=lateral",
    # Switch families with non-cascade shapes -- the live container carries
    # these, and the first real render showed an exclusion-based classifier
    # reading SESSION_DWELL_MS=600000 as a one-step cascade.
    "CLAUDISH_FAILOVER_SESSION_DWELL_MS=600000",
    "CLAUDISH_FAILOVER_ARM_AFTER=2",
    "CLAUDISH_FAILOVER_WALK_BUDGET_MS=300000",
]) + "\n"


def _env():
    return smx.parse_env_dump(ENV_DUMP)


def _canon(env):
    return {name: smx.fingerprint(value) for name, value in env.items()}


# --------------------------------------------------------------------------
# Reading: failover names only, secrets dropped before anything formats them
# --------------------------------------------------------------------------

def test_parse_env_dump_keeps_only_failover_names():
    env = _env()
    assert set(env) == {
        "ACTIVE", "AUTO", "FABLE", "HAIKU", "OPUS", "ROLE_MODELS",
        "SONNET", "STEP_EXCLUDE", "SONNET_LABEL", "SONNET_DIRECTION",
        "SESSION_DWELL_MS", "ARM_AFTER", "WALK_BUDGET_MS",
    }, sorted(env)


def test_a_secret_never_reaches_a_rendered_line():
    """The container's env carries the cluster key and a provider key; neither
    may survive into any line this section prints -- values shown or not."""
    env = _env()
    rendered = "\n".join(
        smx.cascade_lines(env, True) + smx.structural_flags(env)
        + smx.canon_deviations(env, {})
    )
    assert SECRET_KEY not in rendered, rendered
    assert SECRET_API not in rendered, rendered
    assert "PROXY_KEY" not in rendered and "API_KEY" not in rendered, rendered


# --------------------------------------------------------------------------
# The grain's own test: equal count, one value changed -> it must break
# --------------------------------------------------------------------------

def test_fingerprint_is_stable_and_discriminating():
    one = smx.fingerprint("ds@deepseek-flash")
    assert one == smx.fingerprint("ds@deepseek-flash")
    assert one != smx.fingerprint("ds@deepseek-flash-payg")
    assert len(one) == 8


def test_equal_count_value_change_is_caught():
    """The pin the tenue asked for, stated as such: same variable count, one
    value edited -- a count-based check reports nothing, this one must report
    exactly the edited variable."""
    env = _env()
    canon = _canon(env)
    edited = dict(env)
    edited["SONNET"] = "mistral@zai-glm-5-3>ds@deepseek-flash"
    assert len(edited) == len(canon), "fixture must keep the count equal"
    deviations = smx.canon_deviations(edited, canon)
    assert len(deviations) == 1, deviations
    assert "SONNET" in deviations[0] and "off canon" in deviations[0], deviations


def test_identical_values_produce_no_deviation():
    env = _env()
    assert smx.canon_deviations(env, _canon(env)) == []


def test_absent_and_undeclared_variables_are_flagged():
    env = _env()
    canon = _canon(env)
    env_missing = {k: v for k, v in env.items() if k != "HAIKU"}
    extra_env = dict(env)
    extra_env["NINTH"] = "role:sonnet"
    flags = smx.canon_deviations(env_missing, canon) + smx.canon_deviations(extra_env, canon)
    assert any("HAIKU" in f and "absent from the container" in f for f in flags), flags
    assert any("NINTH" in f and "undeclared in the canon" in f for f in flags), flags


# --------------------------------------------------------------------------
# Structural checks (canon-free): a cascade that cannot be what it claims
# --------------------------------------------------------------------------

def test_role_typo_is_flagged():
    env = dict(_env())
    env["SONNET"] = "role:sonet"
    flags = smx.structural_flags(env)
    assert any("unknown role" in f and "sonet" in f for f in flags), flags


def test_step_without_at_or_role_is_flagged():
    env = dict(_env())
    env["SONNET"] = "deepseek-flash"
    flags = smx.structural_flags(env)
    assert any("neither provider@model nor role:<r>" in f for f in flags), flags


def test_label_segment_count_mismatch_is_flagged():
    """Two cascades sharing one label is a real edit mistake; the hub's 05/11
    row checked exactly this parity. Decorators are role-SUFFIXED in the live
    container (`SONNET_LABEL`), never prefixed."""
    env = dict(_env())
    env["SONNET"] = "mistral@zai-glm-5-3>ds@deepseek-flash"
    flags = smx.structural_flags(env)  # both decorators carry 1 segment
    assert any("SONNET_LABEL" in f for f in flags), flags
    assert any("SONNET_DIRECTION" in f for f in flags), flags


def test_a_switch_value_is_never_parsed_as_a_cascade():
    """The regression the first real render exposed: an exclusion-based
    classifier read `SESSION_DWELL_MS=600000` as a one-step cascade and would
    have flagged it. Switches are not steps."""
    env = dict(_env())
    assert env["SESSION_DWELL_MS"] == "600000"
    assert env["ARM_AFTER"] == "2"
    assert smx.structural_flags(env) == [], smx.structural_flags(env)


def test_auto_outside_zero_one_is_flagged():
    env = dict(_env())
    env["AUTO"] = "on"
    flags = smx.structural_flags(env)
    assert any("AUTO" in f and "0 nor 1" in f for f in flags), flags


def test_a_sane_seat_has_no_structural_flag():
    assert smx.structural_flags(_env()) == []


# --------------------------------------------------------------------------
# End-to-end: the CLI surface and what it prints
# --------------------------------------------------------------------------

def _run(*argv):
    return subprocess.run(
        [sys.executable, _TARGET, *argv],
        capture_output=True, text=True, encoding="utf-8",
    )


def _write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def test_main_prints_fingerprints_and_hides_the_secret():
    with tempfile.TemporaryDirectory() as root:
        env_file = os.path.join(root, "printenv.txt")
        _write(env_file, ENV_DUMP)
        proc = _run("--shared", root, "--cascade-env-file", env_file, "myia-po-2028")
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-400:])
    out = proc.stdout
    assert "=== cascade (env file" in out, out[-800:]
    assert "SONNET sha8=" in out and "len=" in out, out[-800:]
    assert "ds@deepseek-flash" not in out, "values must be opt-in"
    assert SECRET_KEY not in out and SECRET_API not in out, out[-800:]


def test_main_shows_values_only_on_request():
    with tempfile.TemporaryDirectory() as root:
        env_file = os.path.join(root, "printenv.txt")
        _write(env_file, ENV_DUMP)
        proc = _run("--shared", root, "--cascade-env-file", env_file,
                    "--show-cascade-values", "myia-po-2028")
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-400:])
    assert "= ds@deepseek-flash" in proc.stdout, proc.stdout[-800:]


def test_main_canon_loop_breaks_on_a_count_equal_edit():
    """Write the canon from one dump, edit one value, compare: the flag names
    the variable. Both dumps carry the same names -- the count is not the test."""
    with tempfile.TemporaryDirectory() as root:
        first = os.path.join(root, "printenv-a.txt")
        second = os.path.join(root, "printenv-b.txt")
        canon = os.path.join(root, "canon.json")
        _write(first, ENV_DUMP)
        _write(second, ENV_DUMP.replace(
            "CLAUDISH_FAILOVER_SONNET=ds@deepseek-flash",
            "CLAUDISH_FAILOVER_SONNET=mistral@zai-glm-5-3>ds@deepseek-flash"))
        written = _run("--shared", root, "--cascade-env-file", first,
                       "--write-cascade-canon", canon, "myia-po-2028")
        assert written.returncode == 0, (written.returncode, written.stderr[-400:])
        with open(canon, encoding="utf-8") as f:
            fingerprints = json.load(f)
        assert set(fingerprints) == set(_env()), sorted(fingerprints)
        compared = _run("--shared", root, "--cascade-env-file", second,
                        "--cascade-canon", canon, "myia-po-2028")
        clean = _run("--shared", root, "--cascade-env-file", first,
                     "--cascade-canon", canon, "myia-po-2028")
    assert compared.returncode == 0, (compared.returncode, compared.stderr[-400:])
    assert "off canon" in compared.stdout and "SONNET" in compared.stdout, compared.stdout[-800:]
    assert "off canon" not in clean.stdout, clean.stdout[-800:]


def test_main_reports_an_unreadable_source():
    with tempfile.TemporaryDirectory() as root:
        proc = _run("--shared", root, "--cascade-env-file",
                    os.path.join(root, "absent.txt"), "myia-po-2028")
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-400:])
    assert "UNREADABLE" in proc.stdout and "unreadable" in proc.stdout, proc.stdout[-800:]


def test_cascade_sources_are_mutually_exclusive():
    with tempfile.TemporaryDirectory() as root:
        proc = _run("--shared", root, "--cascade-container", "claudish-proxy",
                    "--cascade-env-file", "x", "myia-po-2028")
    assert proc.returncode == 2, (proc.returncode, proc.stdout[-400:])


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