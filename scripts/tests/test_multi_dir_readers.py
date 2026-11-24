#!/usr/bin/env python3
"""Pins: a capture corpus split across several directories (#1180).

The hub is to move captures older than 60 min to a second root (#1180, ACK
2026-11-23 — the overflow directory was still absent from the hub on 23/11
20:09Z, so the move is planned). Both readers took ONE directory, so half a
day could read as nothing while the reader said nothing about it.

Pinned here:
  1. a req/resp pair SPLIT between two directories pairs exactly as if both
     files lived in one (native-consumption + traffic-consumption);
  2. a file present in BOTH directories is counted once — the union is
     deduplicated by filename, first directory wins;
  3. the reader DECLARES how many directories it actually READ
     (`COVERAGE dirs=<read>/<asked> uncovered=<path>`), on stdout — a
     directory that could not be read is never silent, in the text run nor
     in `traffic-consumption.py --json` (`coverage` key), and a run that
     read NO directory exits 2. Several unreadable directories are
     COMMA-separated (the producer's shape, file 24a);
  4. the leak-policy verdict on ONE directory is IDENTICAL before and after
     the change — adding an empty second directory changes the coverage line
     and nothing else in the verdict.

Run: python scripts/tests/test_multi_dir_readers.py
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_NATIVE = os.path.join(_HERE, "..", "native-consumption.py")
_TRAFFIC = os.path.join(_HERE, "..", "traffic-consumption.py")

STAMP = "2026-11-23T10-00-00-000Z"
# the response is written AFTER its request: traffic-consumption compares the
# raw filename stamps as strings, and "-direct" sorts after "" at equal
# seconds — a same-second pair is a corpus that cannot exist, not a case to pin
RESP_STAMP = "2026-11-23T10-00-05-000Z"


_TMP = []   # roots created by the running test, removed when it returns


def _tmp(prefix):
    d = tempfile.mkdtemp(prefix=prefix)
    _TMP.append(d)
    return d


def _req(d, pid, n, machine, stamp=STAMP, model="claude-opus-5-5"):
    env = {"ts": stamp, "src": "direct", "machine": machine, "model": model,
           "body": {"model": model,
                    "messages": [{"role": "user", "content": "hi"}]}}
    with open(os.path.join(d, f"req-{pid}-{n}-{stamp}-direct.json"),
              "w", encoding="utf-8") as f:
        json.dump(env, f)


def _resp(d, pid, rank, model, reqN, stamp=RESP_STAMP):
    name = f"resp-{pid}-r{rank}-{stamp}-native-{model}.sse"
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        f.write(f"# parser=anthropic-sse model={model} reqN={reqN} pid={pid}\n")
        f.write('event: message_start\ndata: {"type":"message_start",'
                '"message":{"usage":{"input_tokens":10,"output_tokens":5}}}\n\n')


def _native_argv(*dirs, leak=False):
    empty = _tmp(prefix="md-rdir-")
    argv = [sys.executable, _NATIVE, "--reconcile-dir", empty]
    if leak:
        argv.append("--leak-policy")
    for d in dirs:
        argv += ["--captures-dir", d]
    return argv


def _traffic_argv(*dirs):
    empty = _tmp(prefix="md-trdir-")
    argv = [sys.executable, _TRAFFIC, "--hours", "720",
            "--reconcile-dir", empty]
    for d in dirs:
        argv += ["--dir", d]
    return argv


def _sh(argv):
    # errors="replace" is the #1176 contract: the child keeps its console
    # encoding (no env can pin it under -I), so the strict utf-8 decoder
    # used to raise inside the reader thread and hand back stdout=None
    # (#1186). Assertions only match ASCII; decorative bytes replace cleanly.
    p = subprocess.run(argv, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return p.returncode, p.stdout or "", p.stderr or ""


def _run_native(*dirs, leak=False):
    """(rc, stdout, stderr) — the streams stay apart: a pin on what a reader
    of STDOUT sees must not be satisfied by a line that only stderr carries."""
    return _sh(_native_argv(*dirs, leak=leak))


def _run_traffic(*dirs, json_out=False):
    argv = _traffic_argv(*dirs)
    if json_out:
        argv.append("--json")
    return _sh(argv)


def _coverage_line(stdout):
    """The COVERAGE line as a reader of STDOUT sees it ('' = absent)."""
    for line in stdout.splitlines():
        if line.startswith("COVERAGE "):
            return line
    return ""


def _pair_count(out):
    """(natives, unpaired) du mode complet de native-consumption."""
    m = re.search(r"Reponses natives:\s*(\d+)\s*\(non appariees:\s*(\d+)\)", out)
    assert m, out
    return int(m.group(1)), int(m.group(2))


def _traffic_counts(out):
    m = re.search(r"resp:\s*(\d+)\s*\|\s*appariees:\s*(\d+)\s*\|\s*"
                  r"non appariees:\s*(\d+)", out)
    assert m, out
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


# --------------------------------------------------------------- 1. split pair

def test_native_split_pair_across_two_dirs_pairs():
    a = _tmp(prefix="md-a-")
    b = _tmp(prefix="md-b-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(b, 1, 900, "claude-opus-5-5", 7)   # request in A, response in B
    code, out, err = _run_native(a, b)
    assert code == 0, out + err
    assert _pair_count(out) == (1, 0), out + err


def test_traffic_split_pair_across_two_dirs_pairs():
    a = _tmp(prefix="md-tr-a-")
    b = _tmp(prefix="md-tr-b-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(b, 1, 900, "claude-opus-5-5", 7)
    code, out, err = _run_traffic(a, b)
    assert code == 0, out + err
    assert _traffic_counts(out) == (1, 1, 0), out + err


# ------------------------------------------------------------ 2. dedup by name

def test_native_a_duplicated_file_is_counted_once():
    a = _tmp(prefix="md-dup-a-")
    b = _tmp(prefix="md-dup-b-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(a, 1, 900, "claude-opus-5-5", 7)
    # same basename in the second directory (a partial copy, an rsync overlap)
    _resp(b, 1, 900, "claude-opus-5-5", 7)
    code, out, err = _run_native(a, b)
    assert code == 0, out + err
    assert _pair_count(out) == (1, 0), out + err


def test_traffic_a_duplicated_file_is_counted_once():
    a = _tmp(prefix="md-tr-dup-a-")
    b = _tmp(prefix="md-tr-dup-b-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(a, 1, 900, "claude-opus-5-5", 7)
    _resp(b, 1, 900, "claude-opus-5-5", 7)
    code, out, err = _run_traffic(a, b)
    assert code == 0, out + err
    assert _traffic_counts(out) == (1, 1, 0), out + err


# ---------------------------------------------------------------- 3. coverage
#
# `COVERAGE dirs=<read>/<asked>` names what the reader actually READ. The
# number asked for is not a coverage: a second root that does not exist yet
# must not read as a corpus that was read and happened to be empty.

def _populated():
    """One root carrying a pair, plus a sibling path that does not exist —
    the shape of a second root before anything has moved into it."""
    a = _tmp(prefix="md-cov-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(a, 1, 900, "claude-opus-5-5", 7)
    return a, a + "-missing"


def test_native_declares_how_many_dirs_it_covered():
    a, _ = _populated()
    b = _tmp(prefix="md-cov-b-")
    _req(b, 2, 7, "myia-po-2024")
    _, one, _ = _run_native(a)
    _, two, _ = _run_native(a, b)
    assert _coverage_line(one) == "COVERAGE dirs=1/1", one
    assert _coverage_line(two) == "COVERAGE dirs=2/2", two


def test_traffic_declares_how_many_dirs_it_covered():
    a, _ = _populated()
    b = _tmp(prefix="md-tr-cov-b-")
    _req(b, 2, 7, "myia-po-2024")
    _, one, _ = _run_traffic(a)
    _, two, _ = _run_traffic(a, b)
    assert _coverage_line(one) == "COVERAGE dirs=1/1", one
    assert _coverage_line(two) == "COVERAGE dirs=2/2", two


def test_native_an_unreadable_root_is_uncovered_on_stdout():
    """CR #1181 finding 1 — the count is what was read, and the root that
    could not be is named on the SAME stdout line. A pipe reading stdout
    only must see it: the stderr warning carries the errno, not the verdict."""
    a, missing = _populated()
    code, out, err = _run_native(a, missing)
    assert code == 0, out + err
    want = f"COVERAGE dirs=1/2 uncovered={missing}"
    assert _coverage_line(out) == want, (_coverage_line(out), err[-400:])
    assert "warning: capture dir unreadable" in err, err
    # the root that WAS read still yields its pair
    assert _pair_count(out) == (1, 0), out + err


def test_traffic_an_unreadable_root_is_uncovered_on_stdout():
    a, missing = _populated()
    code, out, err = _run_traffic(a, missing)
    assert code == 0, out + err
    want = f"COVERAGE dirs=1/2 uncovered={missing}"
    assert _coverage_line(out) == want, (_coverage_line(out), err[-400:])
    assert "warning: capture dir unreadable" in err, err
    # listed ONCE: one warning for the request heads and the responses both
    assert err.count("warning: capture dir unreadable") == 1, err
    assert _traffic_counts(out) == (1, 1, 0), out + err


def test_a_file_given_as_a_root_is_uncovered():
    """`listdir`/`scandir` raise on a file: the slip of passing one capture
    instead of its directory is a root that was not read, not a crash."""
    a, _ = _populated()
    a_file = os.path.join(a, "req-1-7-" + STAMP + "-direct.json")
    code, out, err = _run_native(a, a_file)
    want = f"COVERAGE dirs=1/2 uncovered={a_file}"
    assert _coverage_line(out) == want, (_coverage_line(out), err[-400:])
    code, out, err = _run_traffic(a, a_file)
    assert _coverage_line(out) == want, (_coverage_line(out), err[-400:])


def test_a_readable_second_root_is_read_when_the_first_is_not():
    """The first root is the corpus of reference (archive/, reconcile/). With
    it unreadable those mean nothing — but the captures of the roots that CAN
    be read are still counted, and the line still names the one that could not."""
    a, missing = _populated()
    want = f"COVERAGE dirs=1/2 uncovered={missing}"
    code, out, err = _run_native(missing, a)
    assert (code, _coverage_line(out)) == (0, want), (code, out, err)
    assert _pair_count(out) == (1, 0), out + err
    code, out, err = _run_traffic(missing, a)
    assert (code, _coverage_line(out)) == (0, want), (code, out, err)
    assert _traffic_counts(out) == (1, 1, 0), out + err


def test_two_unreadable_roots_are_comma_separated():
    """File 24a item 1: `uncovered=a,b` — the shape po-2023's producer already
    carries, so the two readers agree line for line. A path holds spaces, not
    commas, so the list is splittable on ','."""
    a, missing = _populated()
    other = a + "-missing-too"
    want = f"COVERAGE dirs=1/3 uncovered={missing},{other}"
    code, out, err = _run_native(a, missing, other)
    assert _coverage_line(out) == want, (_coverage_line(out), err[-400:])
    code, out, err = _run_traffic(a, missing, other)
    assert _coverage_line(out) == want, (_coverage_line(out), err[-400:])


def test_traffic_json_carries_the_coverage():
    """CR #1181 finding 2 — the machine-readable run declares the same
    coverage as the text run. stdout stays pure JSON (the warning is stderr)."""
    a, missing = _populated()
    code, out, err = _run_traffic(a, missing, json_out=True)
    assert code == 0, (code, out, err)
    doc = json.loads(out)
    assert doc.get("coverage") == {"requested": [a, missing], "covered": [a],
                                   "uncovered": [missing]}, out
    doc = json.loads(_run_traffic(a, json_out=True)[1])
    assert doc.get("coverage") == {"requested": [a], "covered": [a],
                                   "uncovered": []}, out


def test_no_readable_root_is_not_an_exit_0():
    """The limit of the count: 0 roots read. On main an unreadable only root
    was a traceback (rc 1) — a run that read nothing must not exit 0 and
    look like a corpus without traffic."""
    a, missing = _populated()
    code, out, err = _run_native(missing)
    assert code == 2, (code, out, err)
    want = f"COVERAGE dirs=0/1 uncovered={missing}"
    assert _coverage_line(out) == want, (_coverage_line(out), err[-400:])
    code, out, err = _run_traffic(missing)
    assert code == 2, (code, out, err)
    assert _coverage_line(out) == want, (_coverage_line(out), err[-400:])
    code, out, err = _run_traffic(missing, json_out=True)
    assert code == 2, (code, out, err)
    assert json.loads(out).get("coverage") == {
        "requested": [missing], "covered": [], "uncovered": [missing]}, out


# ----------------------------------------------------- 4. no verdict regression

def _verdict(out):
    """The whole leak-policy output minus the coverage line — the verdict it
    carries must not move when a second (empty) directory is added."""
    return [ln for ln in out.splitlines() if not ln.startswith("COVERAGE ")]


def test_leak_policy_verdict_is_identical_with_an_empty_second_dir():
    a = _tmp(prefix="md-lp-a-")
    empty = _tmp(prefix="md-lp-empty-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(a, 1, 900, "claude-opus-5-5", 7)
    c1, one, e1 = _run_native(a, leak=True)
    c2, two, e2 = _run_native(a, empty, leak=True)
    assert c1 == c2, (c1, c2, one, two)
    assert _verdict(one) == _verdict(two), (one, two)
    assert e1 == e2, (e1, e2)


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"ok   {name}")
        except AssertionError as exc:
            fails += 1
            print(f"FAIL {name}: {exc}")
        finally:
            while _TMP:
                shutil.rmtree(_TMP.pop(), ignore_errors=True)
    sys.exit(1 if fails else 0)
