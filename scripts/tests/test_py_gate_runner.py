#!/usr/bin/env python3
r"""The local python gate runs every test file CI runs, and refuses to run none.

package.json's `test:scripts:py` was a hand-kept `&&` chain of
`python scripts/tests/<file>.py`. Measured 27/11 on main 772f9274: 56 files in
scripts/tests, 40 in the chain, 16 missing -- and the 16's first-commit dates
span 10-07 to 11-22 in four bursts, so it was not one forgotten batch but a
list nobody could keep. A missing file was red in CI only; the local gate said
green.

Four facts, each against a way the gate dies quietly:

  1. discovery == the directory: `--list` names every scripts/tests/test_*.py,
     checked against an independent listing, and the set may not be empty.
  2. package.json delegates to the runner and names no test file: the hand
     list cannot come back through an edit that looks harmless.
  3. the runner's pattern is CI's own: the "every file by its own runner" step
     walks `scripts/tests/test_*.py`, and the pin compares the two spellings,
     so changing one side alone is red.
  4. the verdict: a red child makes the run exit 1 and names it; an all-green
     run exits 0; a directory with no test file exits non-zero instead of
     passing as a green gate over nothing.

Run: python scripts/tests/test_py_gate_runner.py
"""

import fnmatch
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
_RUNNER = os.path.join(_HERE, "run-py-tests.py")
_WORKFLOW = os.path.join(_ROOT, ".github", "workflows", "test.yml")

_spec = importlib.util.spec_from_file_location("run_py_tests", _RUNNER)
_runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_runner)


def ci_globs(text):
    """Every `for f in <glob>; do` glob in the workflow that walks scripts/tests.

    Returned as spelled, so a pin can compare it against the runner's own
    pattern. Zero matches is not a pass: it means the step was rewritten and
    this pin no longer knows what CI walks.
    """
    found = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("for ") or " in " not in line:
            continue
        glob = line.split(" in ", 1)[1].split(";", 1)[0].strip()
        if "scripts/tests/" in glob:
            found.append(glob)
    return found


_CHILD_ENV = dict(os.environ, PYTHONIOENCODING="utf-8")


def run_runner(*args, cwd=None):
    # #1186 / #1203 point 4 -- the two halves of the contract.
    # `errors="replace"`: without it the reader is strict and a byte it cannot
    # map raises inside subprocess' _readerthread, which hands back
    # `stdout=None` with `returncode == 0` (the #1175 signature, read as a
    # silent empty output). The child pin makes the runner emit UTF-8 whatever
    # the seat's console code page is, exactly as the chain's own helpers do.
    proc = subprocess.run(
        [sys.executable or "python", _RUNNER, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_CHILD_ENV,
        timeout=300,
        cwd=cwd or _ROOT,
    )
    return proc.returncode, proc.stdout or "", proc.stderr or ""


class DiscoveryTests(unittest.TestCase):
    def test_list_names_every_test_file_on_disk(self):
        rc, out, err = run_runner("--list")
        self.assertEqual(rc, 0, err)
        listed = {n.strip() for n in out.splitlines() if n.strip()}
        expected = {
            name
            for name in os.listdir(_HERE)
            if fnmatch.fnmatch(name, "test_*.py")
            and os.path.isfile(os.path.join(_HERE, name))
        }
        # Positive control: an empty set here would make the comparison below
        # pass over two empty lists -- the vacuous-scanner failure.
        self.assertGreater(len(expected), 40, "the pin found almost no test file")
        self.assertEqual(listed, expected)

    def test_ci_walks_the_same_files(self):
        with open(_WORKFLOW, encoding="utf-8") as f:
            globs = ci_globs(f.read())
        # Positive control: with no walk found, the loop below would pass vacuously.
        self.assertGreater(len(globs), 0, "no scripts/tests walk found in the workflow")
        # #1199 runs the walk twice (default stdio, then cp1252). The count is not
        # the contract; every pass walking the runner's files is.
        for glob in globs:
            self.assertEqual(
                glob,
                "scripts/tests/" + _runner.PATTERN,
                "a scripts/tests walk in the workflow is narrowed: %r" % (globs,),
            )

    def test_ci_glob_parser_reads_a_spelling_it_must_reject(self):
        # The helper is pinned against its own failure mode: a narrowed glob in
        # the workflow must not come back equal to the runner's pattern.
        other = ci_globs("          for f in scripts/tests/test_a*.py; do\n")
        self.assertEqual(other, ["scripts/tests/test_a*.py"])
        self.assertNotEqual(other[0], "scripts/tests/" + _runner.PATTERN)
        self.assertEqual(ci_globs("          run: echo hi\n"), [])


class DelegationTests(unittest.TestCase):
    def test_package_json_delegates_instead_of_listing_files(self):
        with open(os.path.join(_ROOT, "package.json"), encoding="utf-8") as f:
            scripts = json.load(f)["scripts"]
        self.assertIn("test:scripts:py", scripts)
        command = scripts["test:scripts:py"]
        self.assertIn("scripts/tests/run-py-tests.py", command)
        self.assertNotIn(
            "scripts/tests/test_",
            command,
            "a hand-kept file list is back in test:scripts:py -- the gate must discover its files",
        )


class VerdictTests(unittest.TestCase):
    def _write(self, directory, name, body):
        with open(os.path.join(directory, name), "w", encoding="utf-8") as f:
            f.write(body)

    def test_a_red_child_fails_the_run_names_it_and_does_not_stop_the_walk(self):
        with tempfile.TemporaryDirectory() as td:
            self._write(td, "test_a_red.py", "print('RED-MARKER-A')\nraise SystemExit(3)\n")
            self._write(td, "test_b_ok.py", "print('OK-MARKER-B')\nraise SystemExit(0)\n")
            rc, out, err = run_runner("--dir", td)
            self.assertEqual(rc, 1, out + err)
            self.assertIn("FAILED test_a_red.py (exit 3)", out)
            # The walk went on after the red file: a local pass names every red
            # file at once instead of replaying the gate to discover the next.
            self.assertIn("OK-MARKER-B", out)

    def test_a_green_directory_exits_zero(self):
        with tempfile.TemporaryDirectory() as td:
            self._write(td, "test_ok.py", "print('OK')\nraise SystemExit(0)\n")
            rc, out, err = run_runner("--dir", td)
            self.assertEqual(rc, 0, out + err)
            self.assertIn("1 file(s): 1 ok, 0 failed", out)

    def test_a_directory_with_no_test_file_refuses(self):
        with tempfile.TemporaryDirectory() as td:
            rc, out, err = run_runner("--dir", td)
            self.assertNotEqual(rc, 0, "a gate over nothing reported success")
            self.assertIn("no test_*.py file", err)


if __name__ == "__main__":
    unittest.main(verbosity=1)
