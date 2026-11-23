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
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


class Raw:
    """A gh payload returned verbatim (--jq output is text, not JSON)."""

    def __init__(self, text):
        self.text = text


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
                return payload.text if isinstance(payload, Raw) else json.dumps(payload)
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

    def test_blank_line_in_grains_jsonl_is_skipped(self):
        """Review (not blocking): a blank line raised a bare JSONDecodeError
        traceback instead of a clean run — the in-flight queue stays readable."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            q = root / "lane-q"
            q.mkdir()
            (q / "grains.jsonl").write_text(
                '{"notebook": "Series/T-01-Python.ipynb"}\n\n', encoding="utf-8")
            identity = FakeIdentity([("pulls?state=open", []), ("issues?state=open", [])])
            result = ns.run_selection(repo, identity, ["lane-q"], root, pin="HEAD")
            self.assertEqual(result["counts"]["inflight"], 1,
                             "the real line still counts; the blank line is ignored")
            self.assertNotIn("Series/T-01-Python.ipynb", result["avail"])

    def test_ls_tree_failure_is_not_an_empty_tree(self):
        """M3 (review at 3bf48f1f): the SECOND Git read carries this PR's claim.

        The not-a-git-repo test above only reaches the rev-parse branch; a
        monkeypatched subprocess.run that passes the first call and fails the
        second pins the ls-tree branch itself.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            real_run = subprocess.run
            sha = git(repo, "rev-parse", "HEAD").strip()
            calls = []

            class Done:
                def __init__(self, rc, out="", err=""):
                    self.returncode, self.stdout, self.stderr = rc, out, err

            def fake_run(cmd, **kwargs):
                calls.append(list(cmd))
                if len(calls) == 1:
                    return Done(0, sha + "\n")
                return Done(128, "", "fatal: simulated ls-tree failure")

            ns.subprocess.run = fake_run
            try:
                with self.assertRaises(ns.InstrumentError) as cm:
                    ns.read_pinned_tree(repo, "HEAD")
            finally:
                ns.subprocess.run = real_run
            self.assertEqual(len(calls), 2, "the failure must land on the ls-tree call")
            self.assertIn("ls-tree", str(cm.exception),
                          "the refusal names the read that failed")

    def test_accented_csharp_twin_is_member_of_the_pinned_tree(self):
        """Non-ASCII paths: git quotes them by default, so endswith('.ipynb') drops
        them. An accented -CSharp twin would vanish from cs and its Python source
        would become a false orphan — the exact class this selector closes."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            accented = "Series/Créateur-01-CSharp.ipynb"
            (repo / "Series" / "Créateur-01-CSharp.ipynb").write_text("{}", encoding="utf-8")
            (repo / "Series" / "Créateur-01-Python.ipynb").write_text("{}", encoding="utf-8")
            git(repo, "add", "-A")
            git(repo, "commit", "-q", "-m", "accented pair")
            # premise: the default rendering really does quote the path
            quoted = git(repo, "ls-tree", "-r", "--name-only", "HEAD")
            self.assertIn('"Series/Cr', quoted, "premise: default ls-tree quotes non-ASCII")
            files = ns.read_pinned_tree(repo, "HEAD")
            self.assertIn(accented, files, "the accented twin must be a member")
            identity = FakeIdentity([("pulls?state=open", []), ("issues?state=open", [])])
            result = ns.run_selection(repo, identity, [], root, pin="HEAD")
            self.assertEqual(result["counts"]["cs"], 1)
            self.assertNotIn("Series/Créateur-01-Python.ipynb", result["avail"],
                             "a false orphan here would ship a duplicate twin")


def add_claim_script(repo: Path, rc: int = 0) -> None:
    """A stand-in for check_lane_claim.py: run_preflight runs it from the repo root."""
    d = repo / "scripts"
    d.mkdir(exist_ok=True)
    (d / "check_lane_claim.py").write_text(f"import sys\nsys.exit({rc})\n", encoding="utf-8")


TARGET = "Series/T-01-CSharp.ipynb"
BODY = Raw("- Cible C# : `" + TARGET + "`\n")


RUST_TARGET = "MyIA.AI.Notebooks/Search/Part2-CSP/CSP-10-Optimisation-Z3-Rust.ipynb"
RUST_BODY = Raw(
    "- Source : `MyIA.AI.Notebooks/Search/Part2-CSP/CSP-10-Optimisation-Z3.ipynb`"
    " (26 cellules, 9 code)\n"
    "- Cible : `" + RUST_TARGET + "` (à créer) — suffixe `-Rust`,"
    " kernelspec canonique `rust`\n")


class IssueTargetTests(unittest.TestCase):
    """21/11: the coordinator's Rust portage spec (`Cible :`, no language
    suffix, #27718) must resolve its target — the C#-only matcher refused it
    (`no-target-in-body`), and the Rust tir had to pass the bar by hand."""

    def test_csharp_bullet_still_resolves(self):
        self.assertEqual(ns.issue_target(BODY.text), TARGET)

    def test_rust_portage_bullet_resolves(self):
        self.assertEqual(ns.issue_target(RUST_BODY.text), RUST_TARGET)

    def test_source_line_is_never_the_target(self):
        """A Source-only body (no Cible line) resolves nothing — the portage
        SOURCE notebook must not be read as a delivery target."""
        src_only = RUST_BODY.text.splitlines()[0] + "\n"
        self.assertIsNone(ns.issue_target(src_only))

    def test_heading_marker_resolves(self):
        """The documented `## Cible C#` heading shape stays accepted."""
        self.assertEqual(ns.issue_target("## Cible C# : `" + TARGET + "`\n"),
                         TARGET)

    def test_plain_prose_mention_is_not_a_marker(self):
        """`Cible` mid-sentence (e.g. 'la cible C# est …') does not match —
        only a line LED by the word does."""
        self.assertIsNone(ns.issue_target(
            "Le notebook cible C# `" + TARGET + "` sera cree par le grain.\n"))


class PreflightTests(unittest.TestCase):
    """#1130 review at 1da0421a: the bar must be pinned by what it claims.

    Every test is offline: gh is faked at the Identity boundary, the pinned tree
    is a throwaway repo, the claim organ is a throwaway script.
    """

    def routes(self, comments=None, pulls=None, files=None, body=BODY):
        r = [("issues/1/comments", comments if comments is not None else []),
             ("pulls?state=open", pulls if pulls is not None else []),
             ("issues/1", body)]
        if files is not None:
            r.insert(0, ("pulls/7/files", files))
        return r

    def test_free_when_no_measurement_speaks(self):
        """The base case: a real orphan, no marker, no PR, claim clear -> FREE."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 0)
            report = ns.run_preflight(repo, FakeIdentity(self.routes()), [1],
                                      "myia-po-2028:claudish", [], root, pin="HEAD")
            self.assertEqual(report[1]["verdict"], "FREE", report[1])
            self.assertEqual(report[1]["reasons"], [])
            self.assertEqual(report[1]["target"], TARGET)

    def test_reporting_path_survives_an_absent_tmp_root(self):
        """23/11: the default tmp-root under %TEMP% had been swept; the plain
        reporting path crashed writing its PR-file cache. It now creates it."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 0)
            absent = root / "swept" / "nbcoder-select"
            report = ns.run_preflight(repo, FakeIdentity(self.routes()), [1],
                                      "myia-po-2028:claudish", [], absent, pin="HEAD")
            self.assertEqual(report[1]["verdict"], "FREE", report[1])
            self.assertTrue((absent / "pr-files-cache.json").is_file())

    def test_rust_portage_body_passes_the_bar(self):
        """21/11 (#27718): the coordinator's Rust spec shape resolves its target
        through the FULL bar — the hand-passed 4-way check becomes reproducible."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 0)
            report = ns.run_preflight(repo, FakeIdentity(self.routes(body=RUST_BODY)), [1],
                                      "myia-po-2028:claudish", [], root, pin="HEAD")
            self.assertEqual(report[1]["verdict"], "FREE", report[1])
            self.assertEqual(report[1]["target"], RUST_TARGET)

    def test_blocks_on_target_in_the_pinned_main_tree(self):
        """Measurement (a): a twin already committed is taken, on the PINNED tree."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 0)
            (repo / "Series" / "T-01-CSharp.ipynb").write_text("{}", encoding="utf-8")
            git(repo, "add", "-A")
            git(repo, "commit", "-q", "-m", "twin")
            report = ns.run_preflight(repo, FakeIdentity(self.routes()), [1],
                                      "myia-po-2028:claudish", [], root, pin="HEAD")
            self.assertEqual(report[1]["verdict"], "BLOCKED")
            self.assertIn("target-in-main", report[1]["reasons"])

    def test_blocks_on_a_delivered_marker_from_my_own_lane(self):
        """Founding case (20/11, #27508/#27509): the marker is MY lane's, and the
        claim registry said CLEAR. The bar must still block."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 0)
            comments = [{"body": "[DELIVERED] PR #27562 carries this grain.",
                         "created_at": "2026-11-20T14:00:00Z"}]
            report = ns.run_preflight(repo, FakeIdentity(self.routes(comments=comments)), [1],
                                      "myia-po-2028:claudish", [], root, pin="HEAD")
            self.assertEqual(report[1]["verdict"], "BLOCKED")
            self.assertIn("delivered-marker", report[1]["reasons"])
            self.assertEqual(report[1]["last_delivered"], "2026-11-20T14:00:00Z")

    def test_blocks_on_a_target_on_a_later_pr_files_page(self):
        """Measurement (c) reads ALL pages: a full page 1 must not hide page 2."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 0)
            page1 = [{"filename": f"Series/filler-{i}.ipynb"} for i in range(100)]
            page2 = [{"filename": TARGET}]

            class PagedIdentity(FakeIdentity):
                def gh(self, args):
                    path = args[1]
                    self.calls += 1
                    # endswith, NOT 'in': "page=1" is a substring of "page=196965"
                    # and the substring form once sent api_all into an unbounded
                    # page walk (the very defect API_MAX_PAGES now bounds).
                    if "pulls/7/files" in path and path.endswith("page=1"):
                        return json.dumps(page1)
                    if "pulls/7/files" in path and path.endswith("page=2"):
                        return json.dumps(page2)
                    for key, payload in self.routes:
                        if key in path:
                            return payload.text if isinstance(payload, Raw) else json.dumps(payload)
                    raise AssertionError(f"unexpected gh call: {path}")

            report = ns.run_preflight(repo, PagedIdentity(self.routes(pulls=[{"number": 7}])), [1],
                                      "myia-po-2028:claudish", [], root, pin="HEAD")
            self.assertEqual(report[1]["verdict"], "BLOCKED")
            self.assertIn("target-in-open-pr#7", report[1]["reasons"])

    def test_blocks_on_the_claim_registry(self):
        """Measurement (d): a non-zero claim verdict blocks and names its rc."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 1)
            report = ns.run_preflight(repo, FakeIdentity(self.routes()), [1],
                                      "myia-po-2028:claudish", [], root, pin="HEAD")
            self.assertEqual(report[1]["verdict"], "BLOCKED")
            self.assertIn("claim-blocked(rc=1)", report[1]["reasons"])

    def test_a_failed_git_read_refuses_instead_of_free(self):
        """An unresolvable pin raises: it NEVER degrades to 'absent from main'."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 0)
            with self.assertRaises(ns.InstrumentError):
                ns.run_preflight(repo, FakeIdentity(self.routes()), [1],
                                 "myia-po-2028:claudish", [], root, pin="origin/absent")

    def test_a_failed_gh_call_refuses_instead_of_free(self):
        class DeadIdentity:
            calls = 0

            def gh(self, args):
                raise ns.InstrumentError("gh failed (app) rc=4 endpoint=issues/1")

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 0)
            with self.assertRaises(ns.InstrumentError):
                ns.run_preflight(repo, DeadIdentity(), [1], "myia-po-2028:claudish", [],
                                 root, pin="HEAD")

    def test_the_gate_never_serves_the_pr_files_cache(self):
        """The 15-min cache re-opens the race the bar exists for: under
        require_free it is IGNORED; the reporting path serves it WITH its age."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 0)
            (root / "pr-files-cache.json").write_text(json.dumps({TARGET: 999}), encoding="utf-8")
            identity = FakeIdentity(self.routes())
            gate = ns.run_preflight(repo, identity, [1], "myia-po-2028:claudish", [], root,
                                    pin="HEAD", require_free=True)
            self.assertEqual(gate[1]["verdict"], "FREE",
                             "the gate must re-read the PR list, never the cache")
            report = ns.run_preflight(repo, FakeIdentity(self.routes()), [1],
                                      "myia-po-2028:claudish", [], root, pin="HEAD")
            self.assertEqual(report[1]["verdict"], "BLOCKED")
            self.assertIn("target-in-open-pr#999", report[1]["reasons"])
            self.assertIn("pr_files_cache_age_s", report[1],
                          "a cached verdict must carry its age")

    def test_an_endpoint_that_never_shortens_its_pages_refuses(self):
        """api_all is BOUNDED: an endpoint answering exactly 100 items forever
        (measured 20/11 via a page-substring matching bug) must raise, not hang."""
        full = [{"filename": f"f-{i}.ipynb"} for i in range(100)]

        class NeverShort(FakeIdentity):
            def gh(self, args):
                self.calls += 1
                return json.dumps(full)

        ident = NeverShort([("pulls?state=open", [])])
        with self.assertRaises(ns.InstrumentError) as cm:
            ns.api_all(ident, "repos/jsboige/CoursIA/pulls/7/files")
        self.assertIn("pagination refused", str(cm.exception))
        self.assertLessEqual(ident.calls, ns.API_MAX_PAGES + 1)

    def test_preflight_requires_a_lane(self):
        """No machine-specific default in a fleet organ: --lane or $NBCODER_LANE.

        CR Q7 (re-review at 99b22965): the old fixture passed by accident — the
        pinned-tree read failed first (no origin/main) and returned the same
        EXIT_DEFECT. Here the pinned read SUCCEEDS (--pin HEAD), $NBCODER_LANE
        is scrubbed, and a fake gh that records + fails loudly sits behind the
        guard: if the guard is bypassed, the marker appears and the stderr says
        something else — both turn this test red.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            bindir = root / "bin"
            bindir.mkdir()
            marker = root / "gh-was-called"
            ghbat = bindir / "gh.bat"
            ghbat.write_bytes(b'@echo off\r\ntype nul > "' + str(marker).encode("ascii")
                              + b'"\r\nexit 1\r\n')
            orig = (ns.forge_token, ns.resolve_gh)
            ns.forge_token = lambda *a, **k: "tok"
            ns.resolve_gh = lambda: str(ghbat)
            env = {k: v for k, v in os.environ.items() if k != "NBCODER_LANE"}
            out, err = io.StringIO(), io.StringIO()
            try:
                with mock.patch.dict(os.environ, env, clear=True):
                    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        rc = ns.main(["--repo", str(repo), "--preflight", "1",
                                      "--tmp-root", str(root), "--pin", "HEAD"])
            finally:
                ns.forge_token, ns.resolve_gh = orig
            self.assertEqual(rc, ns.EXIT_DEFECT)
            self.assertIn("needs a lane", err.getvalue(),
                          "the refusal must be the guard's own words")
            self.assertFalse(marker.exists(),
                             "the guard must stop the run before any gh call")

    def test_main_turns_an_instrument_error_into_exit_defect(self):
        """CR Q4: a caller sees only main(). run_preflight raising must land as
        EXIT_DEFECT with NO report on stdout — a refused run never prints a
        verdict a caller could parse as a measurement."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            orig = (ns.forge_token, ns.resolve_gh)
            ns.forge_token = lambda *a, **k: "tok"
            ns.resolve_gh = lambda: "gh"
            out, err = io.StringIO(), io.StringIO()
            try:
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    rc = ns.main(["--repo", str(repo), "--preflight", "1",
                                  "--lane", "myia-po-2028:claudish",
                                  "--tmp-root", str(root), "--pin", "origin/absent"])
            finally:
                ns.forge_token, ns.resolve_gh = orig
            self.assertEqual(rc, ns.EXIT_DEFECT)
            self.assertIn("pinned ref unresolvable", err.getvalue())
            self.assertNotIn("verdict", out.getvalue(),
                             "a refused run must not print a report")

    def test_blocks_on_a_grain_in_an_inflight_queue(self):
        """CR Q5: target-inflight is one of the bars. A target sitting in a
        sibling state-dir's grains.jsonl must BLOCK, not read as free."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 0)
            qdir = root / "w9a"
            qdir.mkdir()
            (qdir / "grains.jsonl").write_text(
                json.dumps({"issue": 7, "notebook": TARGET,
                            "source_nb": "Series/T-01-Python.ipynb"}) + "\n",
                encoding="utf-8")
            report = ns.run_preflight(repo, FakeIdentity(self.routes()), [1],
                                      "myia-po-2028:claudish", ["w9a"], root, pin="HEAD")
            self.assertEqual(report[1]["verdict"], "BLOCKED", report[1])
            self.assertIn("target-inflight", report[1]["reasons"])

    def test_an_absent_inflight_queue_refuses(self):
        """CR Q5: a NAMED queue with no grains.jsonl is a read failure (typo in
        --inflight), never 'nothing in flight' — the #1120 failed-read class.
        A finished queue is retired with its whole state-dir name, not by
        deleting the file alone."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = make_repo(root)
            add_claim_script(repo, 0)
            with self.assertRaises(ns.InstrumentError) as cm:
                ns.run_preflight(repo, FakeIdentity(self.routes()), [1],
                                 "myia-po-2028:claudish", ["typo-name"], root, pin="HEAD")
            self.assertIn("in-flight queue absent", str(cm.exception))
            with self.assertRaises(ns.InstrumentError):
                ns.run_selection(repo, FakeIdentity([("pulls?state=open", []),
                                                     ("issues?state=open", [])]),
                                 ["typo-name"], root, pin="HEAD")


class ProofTests(unittest.TestCase):
    def test_identity_gh_failure_is_sanitized(self):
        """M6 (review at 3bf48f1f): Identity.gh() is the process that CARRIES GH_TOKEN.

        Only forge_token() had a pin. A fake gh that prints a marker on stderr and
        exits non-zero pins the second sanitization: status + endpoint, never the
        child's stderr.
        """
        import os
        import sys
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            if sys.platform == "win32":
                fake = root / "gh-fake.bat"
                fake.write_text("@echo off\r\necho SUPERSECRET-GH-xyz 1>&2\r\nexit /b 4\r\n",
                                encoding="utf-8")
            else:
                fake = root / "gh-fake"
                fake.write_text("#!/bin/sh\necho SUPERSECRET-GH-xyz >&2\nexit 4\n",
                                encoding="utf-8")
                os.chmod(fake, 0o755)
            identity = ns.Identity(str(fake), "tok-never-printed", "app")
            with self.assertRaises(ns.InstrumentError) as cm:
                identity.gh(["api", "repos/o/r/pulls?state=open"])
            text = str(cm.exception)
            self.assertNotIn("SUPERSECRET", text, "gh stderr must never reach the error")
            self.assertNotIn("tok-never-printed", text, "the token must never be echoed")
            self.assertIn("rc=4", text, "the status is the operator's signal")
            self.assertIn("repos/o/r/pulls", text, "the endpoint names where it failed")

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