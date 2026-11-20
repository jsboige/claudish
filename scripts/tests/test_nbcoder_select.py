#!/usr/bin/env python3
"""Offline regression tests for scripts/nbcoder-select.py (CR on PR #1120).

Every test runs with NO network: gh is faked at the Identity boundary, the
Git reads run against throwaway local repositories, and the forge organ is a
throwaway script. The two named CR scenarios are pinned first:

  1. a target that only appears on a LATER page of a PR's changed files
     (the first-page-only scan used to miss it);
  2. a staged tree that differs from the pinned ref (the working index used
     to be the membership oracle, so a staged twin hid a real orphan).

Run: python -m unittest discover -s scripts/tests -p "test_nbcoder_select.py"
"""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "nbcoder-select.py"

_spec = importlib.util.spec_from_file_location("nbcoder_select", SCRIPT)
ns = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ns)


def git(repo: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {r.stderr}")
    return r.stdout


def make_repo(root: Path) -> Path:
    repo = root / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "test@example.invalid")
    git(repo, "config", "user.name", "test")
    (repo / "Series").mkdir()
    (repo / "Series" / "T-01-Python.ipynb").write_text("{}", encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "seed")
    return repo


class FakeIdentity:
    """Stands in for a real gh identity. Routes are matched in order."""

    def __init__(self, routes):
        self.routes = routes  # list of (substring, payload)
        self.calls = 0

    def gh(self, args):
        path = args[1]
        self.calls += 1
        for key, payload in self.routes:
            if key in path:
                return json.dumps(payload)
        raise AssertionError(f"unexpected gh call: {path}")


class SelectionTests(unittest.TestCase):
    def test_target_on_later_files_page_is_blocked(self):
        """CR scenario 1: a target on page 2 of a PR's files is taken."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            page1 = [{"filename": f"Series/filler-{i}.ipynb"} for i in range(100)]  # a full page of notebooks
            page2 = [{"filename": "Series/T-01-Python.ipynb"}]
            identity = FakeIdentity([
                ("pulls/7/files?per_page=100&page=1", page1),
                ("pulls/7/files?per_page=100&page=2", page2),
                ("pulls?state=open", [{"number": 7}]),
                ("issues?state=open", []),
            ])
            result = ns.run_selection(repo, identity, [], root, pin="HEAD")
            self.assertEqual(result["counts"]["taken_pr"], 101,
                             "the page-2 file must count as taken")
            self.assertNotIn("Series/T-01-Python.ipynb", result["avail"],
                             "a target on a later files page must not be offered")

    def test_membership_reads_pinned_tree_not_index(self):
        """CR scenario 2: a staged twin in the index does not hide the orphan."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            staged = repo / "Series" / "T-01-CSharp.ipynb"
            staged.write_text("{}", encoding="utf-8")
            git(repo, "add", "Series/T-01-CSharp.ipynb")  # staged, NOT committed
            identity = FakeIdentity([("pulls?state=open", []), ("issues?state=open", [])])
            result = ns.run_selection(repo, identity, [], root, pin="HEAD")
            # premise of the defect: the index DOES see the staged twin ...
            self.assertIn("Series/T-01-CSharp.ipynb", git(repo, "ls-files"))
            # ... and the pinned tree is the oracle: the twin is absent there,
            # so the Python notebook is a real orphan and stays available.
            self.assertIn("Series/T-01-Python.ipynb", result["avail"])

    def test_git_read_failure_is_not_an_empty_tree(self):
        """A failed Git read refuses; it never yields 'every notebook is orphan'."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            identity = FakeIdentity([("pulls?state=open", []), ("issues?state=open", [])])
            with self.assertRaises(ns.InstrumentError):
                ns.run_selection(root / "not-a-git-repo", identity, [], root, pin="HEAD")


class ProofTests(unittest.TestCase):
    def test_forge_failure_is_sanitized(self):
        """A credential-bearing child's output never reaches the error text."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            forge = root / "forge.py"
            forge.write_text(
                "import sys\nsys.stderr.write('SUPERSECRET-TOKEN-xyz\\n')\nsys.exit(5)\n",
                encoding="utf-8")
            pem = root / "k.pem"
            pem.write_text("not-a-real-key", encoding="utf-8")
            with self.assertRaises(RuntimeError) as cm:
                ns.forge_token(forge, pem, "1", "owner/repo")
            self.assertNotIn("SUPERSECRET", str(cm.exception),
                             "forge failure text must be sanitized")

    def test_corpus_mismatch_refuses_even_without_evidence_path(self):
        """The corpus refusal decision does not depend on --evidence."""
        self.assertIsNotNone(ns.proof_refusal({"corpus": {"identical": False}}))
        self.assertIsNone(ns.proof_refusal({"corpus": {"identical": True}}))
        self.assertIsNone(ns.proof_refusal({}))

    def test_main_refuses_corpus_mismatch_without_evidence(self):
        """End-to-end: main() exits 2 on a corpus mismatch with NO --evidence."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)

            def fake_run_selection(repo_, identity, inflight, tmp_root, pin):
                if identity.label == "shared-corpus-check":
                    return {"avail": [], "counts": {}}
                return {"avail": ["Series/T-01-Python.ipynb"], "counts": {}}

            class Done:
                def __init__(self, rc, stdout):
                    self.returncode = rc
                    self.stdout = stdout
                    self.stderr = ""

            def fake_subprocess_run(cmd, **kwargs):
                dump = Path(cmd[cmd.index("--shared-corpus-dump") + 1])
                dump.write_text(json.dumps({"avail": []}), encoding="utf-8")
                return Done(0, json.dumps({"shared_calls": 3}))

            orig = (ns.run_selection, ns.forge_token, ns.subprocess.run)
            ns.run_selection = fake_run_selection
            ns.forge_token = lambda *a, **k: "fake-token"
            ns.subprocess.run = fake_subprocess_run
            try:
                rc = ns.main(["--repo", str(repo), "--corpus-check",
                              "--pin", "HEAD", "--tmp-root", str(root)])
            finally:
                ns.run_selection, ns.forge_token, ns.subprocess.run = orig
            self.assertEqual(rc, ns.EXIT_DEFECT,
                             "a corpus mismatch must refuse even when no evidence file was requested")


if __name__ == "__main__":
    unittest.main()