#!/usr/bin/env python3
r"""Tests for verify-machine-header.py (claudish issue #1).

Every case carries a positive control: a check that silently matched NOTHING
(a missing file "passing", an empty corpus "clean") would lie exactly where
the rollout is broken, so each refusal is pinned alongside a count that must
be non-zero.

Fixtures are REAL-SHAPED: attributed envelopes carry device_id8 + entrypoint,
residual ones are BARE (a client that lost the machine header generally lost
its metadata too), timestamps use the capture dash format
(2026-10-05T06-02-54-878Z), probes carry the full strong shape (one message,
no system, tools exactly [Bash, Read], max_tokens 100).

Run standalone (no pytest needed):  python scripts/tests/test_verify_machine_header.py
Or under pytest:                    pytest scripts/tests/test_verify_machine_header.py
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "verify-machine-header.py")

_spec = importlib.util.spec_from_file_location("vmh", _TARGET)
vmh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vmh)

_passed = 0


@contextlib.contextmanager
def _tmpdir(prefix="vmh-t-"):
    """mkdtemp that ALWAYS cleans up — the review measured ~176 vmh-* dirs
    left behind in %TEMP% by the previous suite."""
    d = tempfile.mkdtemp(prefix=prefix)
    try:
        yield d
    finally:
        shutil.rmtree(d, ignore_errors=True)


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


def _probe_body(model="glm-5.2", content=None):
    """The exact strong shape both probes send (watchdog ps1:92-123,
    relay.ts:819-844): one user message, no system, [Bash, Read], 100 tokens."""
    return {"model": model, "max_tokens": 100, "stream": True,
            "tools": [{"name": "Bash", "description": "Run a bash command",
                       "input_schema": {"type": "object"}},
                      {"name": "Read", "description": "Read a file",
                       "input_schema": {"type": "object"}}],
            "messages": [{"role": "user",
                          "content": content if content is not None else vmh.PROBE_USER_TEXT}]}


# --------------------------------------------------------------------------
# control 1 — local settings
# --------------------------------------------------------------------------

def test_settings_ok_with_other_headers():
    """The append form of issue #1 (other headers + \n + ours) must pass."""
    with _tmpdir() as d:
        p = _write_settings(d, env={"ANTHROPIC_CUSTOM_HEADERS":
                                    "X-Existing: value\nX-Claudish-Machine: myia-po-2023"})
        ok, detail = vmh.read_settings_machine(p, "myia-po-2023")
        assert ok, detail


def test_settings_header_names_another_machine():
    with _tmpdir() as d:
        p = _write_settings(d, env={"ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: myia-ai-01"})
        ok, detail = vmh.read_settings_machine(p, "myia-po-2023")
        assert not ok and "myia-ai-01" in detail, detail


def test_settings_missing_file_degrades_not_raises():
    with _tmpdir() as d:
        ok, detail = vmh.read_settings_machine(os.path.join(d, "nope.json"), "x")
        assert not ok and "not found" in detail, detail


def test_settings_bad_json_degrades_not_raises():
    with _tmpdir() as d:
        p = os.path.join(d, "settings.json")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        ok, detail = vmh.read_settings_machine(p, "x")
        assert not ok and "unreadable" in detail, detail


def test_settings_env_var_without_our_header():
    """ANTHROPIC_CUSTOM_HEADERS set but WITHOUT our header = FAIL (masked)."""
    with _tmpdir() as d:
        p = _write_settings(d, env={"ANTHROPIC_CUSTOM_HEADERS": "X-Other: 1"})
        ok, detail = vmh.read_settings_machine(p, "x")
        assert not ok and "not among" in detail, detail


def test_settings_no_env_block():
    with _tmpdir() as d:
        p = _write_settings(d, env=None)
        ok, detail = vmh.read_settings_machine(p, "x")
        assert not ok and "env block" in detail, detail


# --------------------------------------------------------------------------
# controls 2+3 — corpus + roster
# --------------------------------------------------------------------------

def _fill_corpus(d, n_with=2, n_without=1, machine="myia-po-2023"):
    for i in range(n_with):
        _write_req(d, "req-1-%04d.json" % i,
                   {"ts": "2026-10-04T1%d-00-00-000Z" % i, "src": "10.0.0.5",
                    "machine": machine, "model": "glm-5.3", "pid": 1,
                    "entrypoint": "d:/Dev/claudish", "workload": "interactive",
                    "device_id8": "a1b2c3d4",
                    "body": {"model": "glm-5.3", "messages": [
                        {"role": "user", "content": "real work"}]}})
    for i in range(n_without):
        # residual records are BARE: no entrypoint, no workload, no device_id8
        _write_req(d, "req-2-%04d.json" % i,
                   {"ts": "2026-10-04T0%d-00-00-000Z" % i, "src": "direct",
                    "machine": "", "model": "claude-sonnet-4-6", "pid": 2,
                    "body": {"model": "claude-sonnet-4-6", "messages": [
                        {"role": "user", "content": "do work"}]}})
    return d


def test_distribution_counts_both_sides():
    with _tmpdir() as d:
        _fill_corpus(d, n_with=3, n_without=2)
        records, unreadable, span = vmh.scan_corpus(d, 100)
        dist = vmh.machine_distribution(records)
        assert unreadable == 0
        assert dist == {"myia-po-2023": 3, "": 2}, dist
        assert span == ("2026-10-04T00-00-00-000Z", "2026-10-04T12-00-00-000Z"), span


def test_limit_takes_the_newest_by_mtime():
    """--limit must keep the NEWEST file by mtime, whatever the filename says.

    The old envelope carries the lexicographically LARGER name, so a sort on
    filename (instead of mtime) would keep the wrong one — this is the
    positive control for the sort key.
    """
    with _tmpdir() as d:
        _write_req(d, "req-9-0009.json", {"ts": "2020-01-01T00-00-00-000Z"})  # old, big name
        _write_req(d, "req-9-0001.json", {"ts": "2026-10-04T00-00-00-000Z"})  # new, small name
        # distinct mtimes regardless of filesystem timestamp resolution
        os.utime(os.path.join(d, "req-9-0009.json"), (1_000_000_000, 1_000_000_000))
        records, unreadable, _ = vmh.scan_corpus(d, 1)
        assert unreadable == 0 and len(records) == 1
        assert records[0].get("ts") == "2026-10-04T00-00-00-000Z", records[0]


def test_corrupt_file_is_counted_not_fatal():
    with _tmpdir() as d:
        _fill_corpus(d, n_with=1, n_without=0)
        with open(os.path.join(d, "req-3-0000.json"), "w", encoding="utf-8") as fh:
            fh.write("{truncated")
        records, unreadable, _ = vmh.scan_corpus(d, 100)
        assert unreadable == 1 and len(records) == 1, (unreadable, len(records))


def test_missing_corpus_dir_is_empty_not_raise():
    with _tmpdir() as d:
        records, unreadable, span = vmh.scan_corpus(os.path.join(d, "nope"), 10)
        assert records == [] and unreadable == 0 and span is None


def test_roster_flags_nickname_as_unknown():
    """THE canonical-name trap: `po-203` must be flagged, not silently counted."""
    with _tmpdir() as d:
        _fill_corpus(d, n_with=2, machine="po-203")
        records, _, _ = vmh.scan_corpus(d, 100)
        dist = vmh.machine_distribution(records)
        unknown = sorted(k for k in dist if k and k not in vmh.ROSTER)
        assert unknown == ["po-203"], unknown
        assert "myia-po-2023" in vmh.ROSTER


# --------------------------------------------------------------------------
# residual attribution
# --------------------------------------------------------------------------

def test_residual_groups_the_bare_lane():
    with _tmpdir() as d:
        _fill_corpus(d, n_with=1, n_without=3)
        records, _, _ = vmh.scan_corpus(d, 100)
        residual = vmh.residual_attribution(records)
        assert list(residual) == [("direct", "claude-sonnet-4-6", "-", "-")], residual
        g = residual[("direct", "claude-sonnet-4-6", "-", "-")]
        assert g["count"] == 3
        assert g["devices"] == []  # bare residual: nothing to name
        assert g["first"] == "2026-10-04T00-00-00-000Z" and g["last"] == "2026-10-04T02-00-00-000Z"


def test_residual_empty_when_all_attributed():
    with _tmpdir() as d:
        _fill_corpus(d, n_with=3, n_without=0)
        records, _, _ = vmh.scan_corpus(d, 100)
        assert vmh.residual_attribution(records) == {}


# --------------------------------------------------------------------------
# envelope discipline + our own probes (PR #336 review blockers)
# --------------------------------------------------------------------------

def test_scan_keeps_envelope_only_body_dropped():
    """Records must NOT retain the body — at --limit 2000 a retained body is
    a memory bomb. Fails on the pre-review code (body was kept whole)."""
    with _tmpdir() as d:
        _fill_corpus(d, n_with=1, n_without=0)
        records, _, _ = vmh.scan_corpus(d, 10)
        assert len(records) == 1
        assert "body" not in records[0], sorted(records[0])


def test_probe_strong_shape_recognized_tagged_and_excluded():
    """The exact probe shape is tagged `probe` and excluded from the CLIENT
    residual. Fails on the pre-review code (probe counted as a client lane)."""
    with _tmpdir() as d:
        _write_req(d, "req-5-0001.json",
                   {"ts": "2026-10-04T01-00-00-000Z", "src": "direct", "machine": "",
                    "model": "glm-5.2", "pid": 1, "body": _probe_body()})
        _write_req(d, "req-5-0002.json",
                   {"ts": "2026-10-04T02-00-00-000Z", "src": "direct", "machine": "",
                    "model": "claude-sonnet-4-6", "pid": 1,
                    "body": {"model": "claude-sonnet-4-6", "messages": [
                        {"role": "user", "content": "do real work"}]}})
        records, _, _ = vmh.scan_corpus(d, 10)
        probes = [r for r in records if r.get("probe")]
        assert len(probes) == 1, [r.get("probe") for r in records]
        assert "body" not in probes[0]
        residual = vmh.residual_attribution(records)
        assert list(residual) == [("direct", "claude-sonnet-4-6", "-", "-")], residual


def test_probe_content_block_form_recognized():
    """Same probe arriving as a content-BLOCK list (the Claude Code wire
    shape) must match too — the classifier must not depend on string form."""
    with _tmpdir() as d:
        _write_req(d, "req-5-0001.json",
                   {"ts": "2026-10-04T01-00-00-000Z", "src": "direct", "machine": "",
                    "model": "glm-5.3", "pid": 1,
                    "body": _probe_body(model="glm-5.3", content=[
                        {"type": "text", "text": vmh.PROBE_USER_TEXT}])})
        records, _, _ = vmh.scan_corpus(d, 10)
        assert len(records) == 1 and records[0].get("probe") is True, records[0]


def test_probe_text_quoted_in_a_real_history_is_not_a_probe():
    """Text alone is NOT enough (review): a real header-less session whose
    HISTORY contains the exact phrase must stay a client residual — hence
    the shape anchors (2 messages here, so not a probe)."""
    with _tmpdir() as d:
        _write_req(d, "req-5-0001.json",
                   {"ts": "2026-10-04T01-00-00-000Z", "src": "direct", "machine": "",
                    "model": "glm-5.3", "pid": 1,
                    "body": {"model": "glm-5.3", "max_tokens": 4096,
                             "system": "You are a coding agent.",
                             "tools": [{"name": "Bash"}, {"name": "Read"}, {"name": "Edit"}],
                             "messages": [
                                 {"role": "user", "content": vmh.PROBE_USER_TEXT},
                                 {"role": "assistant", "content": "done"},
                                 {"role": "user", "content": "now explain"}]}})
        records, _, _ = vmh.scan_corpus(d, 10)
        assert not records[0].get("probe"), records[0]
        assert vmh.residual_attribution(records)  # stays a real residual lane


def test_probe_text_wrong_max_tokens_or_tools_is_not_a_probe():
    """Single-message + exact text but a DIFFERENT budget or toolset = a
    client that happens to send the same words — not our probe."""
    with _tmpdir() as d:
        _write_req(d, "req-a-0001.json",
                   {"ts": "2026-10-04T01-00-00-000Z", "machine": "", "model": "glm-5.2", "pid": 1,
                    "body": _probe_body()})
        body = _probe_body()
        body["max_tokens"] = 8192  # not the probe budget
        _write_req(d, "req-a-0002.json",
                   {"ts": "2026-10-04T02-00-00-000Z", "machine": "", "model": "glm-5.2", "pid": 1,
                    "body": body})
        records, _, _ = vmh.scan_corpus(d, 10)
        # scan_corpus returns newest-mtime first; two files written back to back
        # share an mtime only on a coarse-resolution filesystem. Order by the
        # envelope ts, never by return order (red 5/5 on ai-01 NTFS otherwise).
        flags = [bool(r.get("probe")) for r in sorted(records, key=lambda r: r["ts"])]
        assert flags == [True, False], flags


# --------------------------------------------------------------------------
# client coverage — same population on both sides (review blocker 1)
# --------------------------------------------------------------------------

def test_client_coverage_never_exceeds_100_even_with_header_probes():
    """Probes that CARRY the header (the #345 end-state) must not inflate the
    client numerator: with_m counts them, clients does not — the old
    with_m/(total-probes) rendered 4/3 = 133%. Same population or nothing."""
    with _tmpdir() as d:
        _fill_corpus(d, n_with=2, n_without=1)  # 2 attributed + 1 bare residual = 3 clients
        for i in range(2):  # two probes WITH the header — the future #345 shape
            _write_req(d, "req-6-%04d.json" % i,
                       {"ts": "2026-10-04T0%d-30-00-000Z" % i, "machine": "myia-po-2023",
                        "model": "glm-5.2", "pid": 1, "body": _probe_body()})
        records, _, _ = vmh.scan_corpus(d, 100)
        client_total, client_with, probes = vmh.client_stats(records)
        assert probes == 2, probes
        assert (client_total, client_with) == (3, 2), (client_total, client_with)
        assert client_with <= client_total


# --------------------------------------------------------------------------
# richness — device_id8/entrypoint on both sides (review demand 2(a))
# --------------------------------------------------------------------------

def test_richness_counts_both_sides():
    with _tmpdir() as d:
        _fill_corpus(d, n_with=2, n_without=3)  # attributed rich, residual bare
        records, _, _ = vmh.scan_corpus(d, 100)
        rich = vmh.richness(records)
        assert rich["attr"] == [2, 2, 2, 2], rich["attr"]
        assert rich["resid"] == [3, 0, 0, 0], rich["resid"]


# --------------------------------------------------------------------------
# end-to-end exit codes
# --------------------------------------------------------------------------

def _run_main(cwd_args):
    """Run main() with stdout/stderr captured — exit codes AND text are
    asserted (a false 'complete' claim is a finding, not just an rc)."""
    buf_o, buf_e = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(buf_o), contextlib.redirect_stderr(buf_e):
        rc = vmh.main(cwd_args)
    return rc, buf_o.getvalue()


def test_main_exit_0_on_clean_corpus_with_settings():
    with _tmpdir() as d, _tmpdir() as sd:
        _fill_corpus(d, n_with=3, n_without=0)
        p = _write_settings(sd, env={"ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: myia-po-2023"})
        rc, _ = _run_main(["--corpus", d, "--settings", p, "--machine", "myia-po-2023"])
        assert rc == 0, rc


def test_main_exit_1_on_unknown_machine_name():
    with _tmpdir() as d, _tmpdir() as sd:
        _fill_corpus(d, n_with=2, machine="po-203")
        p = _write_settings(sd, env={"ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: po-203"})
        rc, _ = _run_main(["--corpus", d, "--settings", p, "--machine", "po-203"])
        assert rc == 1, rc


def test_main_exit_1_when_local_header_missing():
    with _tmpdir() as d, _tmpdir() as sd:
        _fill_corpus(d, n_with=3, n_without=0)
        p = _write_settings(sd, env={})
        rc, _ = _run_main(["--corpus", d, "--settings", p, "--machine", "myia-po-2023"])
        assert rc == 1, rc


def test_main_exit_2_when_corpus_unusable_and_no_false_clean_claim():
    """Empty corpus: rc 2 AND the output must not claim 'every scanned
    request carried the header' — 0 records prove nothing (review)."""
    with _tmpdir() as d, _tmpdir() as sd:
        p = _write_settings(sd, env={"ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: myia-po-2023"})
        rc, out = _run_main(["--corpus", d, "--settings", p, "--machine", "myia-po-2023"])
        assert rc == 2, rc
        assert "every" not in out.lower() or "carried" not in out.lower(), out


def test_main_exit_2_on_all_probe_corpus_no_complete_claim():
    """THE published false green (review blocker 2): a corpus holding only
    our own probes must exit 2 and never say 'complete' — 0 client record
    proves nothing about the rollout."""
    with _tmpdir() as d, _tmpdir() as sd:
        for i in range(2):
            _write_req(d, "req-7-%04d.json" % i,
                       {"ts": "2026-10-04T0%d-00-00-000Z" % i, "src": "direct", "machine": "",
                        "model": "glm-5.2", "pid": 1, "body": _probe_body()})
        p = _write_settings(sd, env={"ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: myia-po-2023"})
        rc, out = _run_main(["--corpus", d, "--settings", p, "--machine", "myia-po-2023"])
        assert rc == 2, rc
        assert "complete" not in out.lower(), out
        assert "0 CLIENT record" in out, out


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
