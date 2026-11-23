#!/usr/bin/env python3
"""Pins: a capture corpus split across several directories (#1180).

The hub started moving captures older than 60 min to a second root on
2026-11-23 (po-2025, D: pressure). Both readers took ONE directory, so half a
day could read as nothing while the reader said nothing about it.

Pinned here:
  1. a req/resp pair SPLIT between two directories pairs exactly as if both
     files lived in one (native-consumption + traffic-consumption);
  2. a file present in BOTH directories is counted once — the union is
     deduplicated by filename, first directory wins;
  3. the reader DECLARES how many directories it actually covered
     (`COVERAGE dirs=N`), so a missing directory is never silent;
  4. the leak-policy verdict on ONE directory is IDENTICAL before and after
     the change — adding an empty second directory changes the coverage line
     and nothing else in the verdict.

Run: python scripts/tests/test_multi_dir_readers.py
"""

import os
import re
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


def _req(d, pid, n, machine, stamp=STAMP, model="claude-opus-5-5"):
    env = {"ts": stamp, "src": "direct", "machine": machine, "model": model,
           "body": {"model": model,
                    "messages": [{"role": "user", "content": "hi"}]}}
    import json
    with open(os.path.join(d, f"req-{pid}-{n}-{stamp}-direct.json"),
              "w", encoding="utf-8") as f:
        json.dump(env, f)


def _resp(d, pid, rank, model, reqN, stamp=RESP_STAMP):
    name = f"resp-{pid}-r{rank}-{stamp}-native-{model}.sse"
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        f.write(f"# parser=anthropic-sse model={model} reqN={reqN} pid={pid}\n")
        f.write('event: message_start\ndata: {"type":"message_start",'
                '"message":{"usage":{"input_tokens":10,"output_tokens":5}}}\n\n')


def _run_native(*dirs, leak=False):
    empty = tempfile.mkdtemp(prefix="md-rdir-")
    argv = [sys.executable, _NATIVE, "--reconcile-dir", empty]
    if leak:
        argv.append("--leak-policy")
    for d in dirs:
        argv += ["--captures-dir", d]
    p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8")
    return p.returncode, p.stdout + p.stderr


def _run_traffic(*dirs):
    empty = tempfile.mkdtemp(prefix="md-trdir-")
    argv = [sys.executable, _TRAFFIC, "--hours", "720",
            "--reconcile-dir", empty]
    for d in dirs:
        argv += ["--dir", d]
    p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8")
    return p.returncode, p.stdout + p.stderr


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
    a = tempfile.mkdtemp(prefix="md-a-")
    b = tempfile.mkdtemp(prefix="md-b-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(b, 1, 900, "claude-opus-5-5", 7)   # request in A, response in B
    code, out = _run_native(a, b)
    assert code == 0, out
    assert _pair_count(out) == (1, 0), out


def test_traffic_split_pair_across_two_dirs_pairs():
    a = tempfile.mkdtemp(prefix="md-tr-a-")
    b = tempfile.mkdtemp(prefix="md-tr-b-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(b, 1, 900, "claude-opus-5-5", 7)
    code, out = _run_traffic(a, b)
    assert code == 0, out
    assert _traffic_counts(out) == (1, 1, 0), out


# ------------------------------------------------------------ 2. dedup by name

def test_native_a_duplicated_file_is_counted_once():
    a = tempfile.mkdtemp(prefix="md-dup-a-")
    b = tempfile.mkdtemp(prefix="md-dup-b-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(a, 1, 900, "claude-opus-5-5", 7)
    # same basename in the second directory (a partial copy, an rsync overlap)
    _resp(b, 1, 900, "claude-opus-5-5", 7)
    code, out = _run_native(a, b)
    assert code == 0, out
    assert _pair_count(out) == (1, 0), out


def test_traffic_a_duplicated_file_is_counted_once():
    a = tempfile.mkdtemp(prefix="md-tr-dup-a-")
    b = tempfile.mkdtemp(prefix="md-tr-dup-b-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(a, 1, 900, "claude-opus-5-5", 7)
    _resp(b, 1, 900, "claude-opus-5-5", 7)
    code, out = _run_traffic(a, b)
    assert code == 0, out
    assert _traffic_counts(out) == (1, 1, 0), out


# ---------------------------------------------------------------- 3. coverage

def test_native_declares_how_many_dirs_it_covered():
    a = tempfile.mkdtemp(prefix="md-cov-a-")
    b = tempfile.mkdtemp(prefix="md-cov-b-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(a, 1, 900, "claude-opus-5-5", 7)
    _, one = _run_native(a)
    _, two = _run_native(a, b)
    assert "COVERAGE dirs=1" in one, one
    assert "COVERAGE dirs=2" in two, two


def test_traffic_declares_how_many_dirs_it_covered():
    a = tempfile.mkdtemp(prefix="md-tr-cov-a-")
    b = tempfile.mkdtemp(prefix="md-tr-cov-b-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(a, 1, 900, "claude-opus-5-5", 7)
    _, one = _run_traffic(a)
    _, two = _run_traffic(a, b)
    assert "COVERAGE dirs=1" in one, one
    assert "COVERAGE dirs=2" in two, two


# ----------------------------------------------------- 4. no verdict regression

def _verdict(out):
    """The whole leak-policy output minus the coverage line — the verdict it
    carries must not move when a second (empty) directory is added."""
    return [ln for ln in out.splitlines() if not ln.startswith("COVERAGE ")]


def test_leak_policy_verdict_is_identical_with_an_empty_second_dir():
    a = tempfile.mkdtemp(prefix="md-lp-a-")
    empty = tempfile.mkdtemp(prefix="md-lp-empty-")
    _req(a, 1, 7, "myia-ai-01")
    _resp(a, 1, 900, "claude-opus-5-5", 7)
    c1, one = _run_native(a, leak=True)
    c2, two = _run_native(a, empty, leak=True)
    assert c1 == c2, (c1, c2, one, two)
    assert _verdict(one) == _verdict(two), (one, two)


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
    sys.exit(1 if fails else 0)
