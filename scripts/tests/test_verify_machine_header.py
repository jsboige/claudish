#!/usr/bin/env python3
r"""Tests for verify-machine-header.py (claudish issue #1).

Every case carries a positive control: a check that silently matched NOTHING
(a missing file "passing", an empty corpus "clean") would lie exactly where
the rollout is broken, so each refusal is pinned alongside a count that must
be non-zero.

Run standalone (no pytest needed):  python scripts/tests/test_verify_machine_header.py
Or under pytest:                    pytest scripts/tests/test_verify_machine_header.py
"""

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "verify-machine-header.py")

_spec = importlib.util.spec_from_file_location("vmh", _TARGET)
vmh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vmh)

_passed = 0


def _write_settings(d, env=None, root=None):
    """env=None writes NO env block at all (distinct from an empty one)."""
    path = os.path.join(d, "settings.json")
    if root is not None:
        data = root
    elif env is None:
        data = {}
    else:
        data = {"env": env}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    return path


def _write_req(d, name, envelope):
    with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
        json.dump(envelope, fh)


# --------------------------------------------------------------------------
# control 1 — local settings
# --------------------------------------------------------------------------

def test_settings_ok_with_other_headers():
    """The append form of issue #1 (other headers + \n + ours) must pass."""
    d = tempfile.mkdtemp(prefix="vmh-")
    p = _write_settings(d, env={"ANTHROPIC_CUSTOM_HEADERS":
                                "X-Existing: value\nX-Claudish-Machine: myia-po-2023"})
    ok, detail = vmh.read_settings_machine(p, "myia-po-2023")
    assert ok, detail


def test_settings_header_names_another_machine():
    d = tempfile.mkdtemp(prefix="vmh-")
    p = _write_settings(d, env={"ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: myia-ai-01"})
    ok, detail = vmh.read_settings_machine(p, "myia-po-2023")
    assert not ok and "myia-ai-01" in detail, detail


def test_settings_missing_file_degrades_not_raises():
    ok, detail = vmh.read_settings_machine(os.path.join(tempfile.mkdtemp(), "nope.json"), "x")
    assert not ok and "not found" in detail, detail


def test_settings_bad_json_degrades_not_raises():
    d = tempfile.mkdtemp(prefix="vmh-")
    p = os.path.join(d, "settings.json")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write("{not json")
    ok, detail = vmh.read_settings_machine(p, "x")
    assert not ok and "unreadable" in detail, detail


def test_settings_env_var_without_our_header():
    """ANTHROPIC_CUSTOM_HEADERS set but WITHOUT our header = FAIL (masked)."""
    d = tempfile.mkdtemp(prefix="vmh-")
    p = _write_settings(d, env={"ANTHROPIC_CUSTOM_HEADERS": "X-Other: 1"})
    ok, detail = vmh.read_settings_machine(p, "x")
    assert not ok and "not among" in detail, detail


def test_settings_no_env_block():
    d = tempfile.mkdtemp(prefix="vmh-")
    p = _write_settings(d, env=None)
    ok, detail = vmh.read_settings_machine(p, "x")
    assert not ok and "env block" in detail, detail


# --------------------------------------------------------------------------
# controls 2+3 — corpus + roster
# --------------------------------------------------------------------------

def _corpus(n_with=2, n_without=1, machine="myia-po-2023"):
    d = tempfile.mkdtemp(prefix="vmh-corpus-")
    for i in range(n_with):
        _write_req(d, "req-1-%04d.json" % i,
                   {"ts": "2026-10-04T1%d:00:00Z" % i, "src": "10.0.0.5",
                    "machine": machine, "model": "glm-5.3", "pid": 1})
    for i in range(n_without):
        _write_req(d, "req-2-%04d.json" % i,
                   {"ts": "2026-10-04T0%d:00:00Z" % i, "src": "direct",
                    "machine": "", "model": "claude-sonnet-4-6", "pid": 2,
                    "entrypoint": "workload/cron", "workload": "cron",
                    "device_id8": "abcd1234"})
    return d


def test_distribution_counts_both_sides():
    d = _corpus(n_with=3, n_without=2)
    records, unreadable, span = vmh.scan_corpus(d, 100)
    dist = vmh.machine_distribution(records)
    assert unreadable == 0
    assert dist == {"myia-po-2023": 3, "": 2}, dist
    assert span == ("2026-10-04T00:00:00Z", "2026-10-04T12:00:00Z"), span


def test_limit_takes_the_newest_by_mtime():
    """--limit must keep the NEWEST file by mtime, whatever the filename says.

    The old envelope carries the lexicographically LARGER name, so a sort on
    filename (instead of mtime) would keep the wrong one — this is the
    positive control for the sort key.
    """
    d = tempfile.mkdtemp(prefix="vmh-limit-")
    _write_req(d, "req-9-0009.json", {"ts": "2020-01-01T00:00:00Z"})  # old, big name
    _write_req(d, "req-9-0001.json", {"ts": "2026-10-04T00:00:00Z"})  # new, small name
    # distinct mtimes regardless of filesystem timestamp resolution
    os.utime(os.path.join(d, "req-9-0009.json"), (1_000_000_000, 1_000_000_000))
    records, unreadable, _ = vmh.scan_corpus(d, 1)
    assert unreadable == 0 and len(records) == 1
    assert records[0].get("ts") == "2026-10-04T00:00:00Z", records[0]


def _touch_later(path):
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(" ")  # bump mtime


def test_corrupt_file_is_counted_not_fatal():
    d = _corpus(n_with=1, n_without=0)
    with open(os.path.join(d, "req-3-0000.json"), "w", encoding="utf-8") as fh:
        fh.write("{truncated")
    records, unreadable, _ = vmh.scan_corpus(d, 100)
    assert unreadable == 1 and len(records) == 1, (unreadable, len(records))


def test_missing_corpus_dir_is_empty_not_raise():
    records, unreadable, span = vmh.scan_corpus(os.path.join(tempfile.mkdtemp(), "nope"), 10)
    assert records == [] and unreadable == 0 and span is None


def test_roster_flags_nickname_as_unknown():
    """THE canonical-name trap: `po-203` must be flagged, not silently counted."""
    d = _corpus(n_with=2, machine="po-203")
    records, _, _ = vmh.scan_corpus(d, 100)
    dist = vmh.machine_distribution(records)
    unknown = sorted(k for k in dist if k and k not in vmh.ROSTER)
    assert unknown == ["po-203"], unknown
    assert "myia-po-2023" in vmh.ROSTER


# --------------------------------------------------------------------------
# residual attribution
# --------------------------------------------------------------------------

def test_residual_groups_the_lane_and_names_devices():
    d = _corpus(n_with=1, n_without=3)
    records, _, _ = vmh.scan_corpus(d, 100)
    residual = vmh.residual_attribution(records)
    assert list(residual) == [("direct", "claude-sonnet-4-6", "workload/cron", "cron")], residual
    g = residual[("direct", "claude-sonnet-4-6", "workload/cron", "cron")]
    assert g["count"] == 3
    assert g["devices"] == ["abcd1234"]
    assert g["first"] == "2026-10-04T00:00:00Z" and g["last"] == "2026-10-04T02:00:00Z"


def test_residual_empty_when_all_attributed():
    d = _corpus(n_with=3, n_without=0)
    records, _, _ = vmh.scan_corpus(d, 100)
    assert vmh.residual_attribution(records) == {}


# --------------------------------------------------------------------------
# end-to-end exit codes
# --------------------------------------------------------------------------

def _run_main(cwd_args):
    """Run main() with stdout/stderr swallowed — we assert on exit codes."""
    buf_o, buf_e = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(buf_o), contextlib.redirect_stderr(buf_e):
        return vmh.main(cwd_args)


def test_main_exit_0_on_clean_corpus_with_settings(tmp_home=None):
    d = _corpus(n_with=3, n_without=0)
    sd = tempfile.mkdtemp(prefix="vmh-set-")
    p = _write_settings(sd, env={"ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: myia-po-2023"})
    rc = _run_main(["--corpus", d, "--settings", p, "--machine", "myia-po-2023"])
    assert rc == 0, rc


def test_main_exit_1_on_unknown_machine_name():
    d = _corpus(n_with=2, machine="po-203")
    sd = tempfile.mkdtemp(prefix="vmh-set-")
    p = _write_settings(sd, env={"ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: po-203"})
    rc = _run_main(["--corpus", d, "--settings", p, "--machine", "po-203"])
    assert rc == 1, rc


def test_main_exit_1_when_local_header_missing():
    d = _corpus(n_with=3, n_without=0)
    sd = tempfile.mkdtemp(prefix="vmh-set-")
    p = _write_settings(sd, env={})
    rc = _run_main(["--corpus", d, "--settings", p, "--machine", "myia-po-2023"])
    assert rc == 1, rc


def test_main_exit_2_when_corpus_unusable():
    empty = tempfile.mkdtemp(prefix="vmh-empty-")
    sd = tempfile.mkdtemp(prefix="vmh-set-")
    p = _write_settings(sd, env={"ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: myia-po-2023"})
    rc = _run_main(["--corpus", empty, "--settings", p, "--machine", "myia-po-2023"])
    assert rc == 2, rc


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                _passed += 1
                print("PASS %s" % name)
            except AssertionError as e:
                failures += 1
                print("FAIL %s: %s" % (name, e))
            except Exception as e:  # a crash is a failure, never a skip
                failures += 1
                print("ERROR %s: %r" % (name, e))
    print("--- %d passed, %d failed" % (_passed, failures))
    sys.exit(1 if failures else 0)
