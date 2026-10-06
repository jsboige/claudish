#!/usr/bin/env python3
"""Pins for coursia-picker-friction.py (claudish #328 G3).

Each trap this instrument exists to avoid would make an ALREADY-PUBLISHED
number wrong rather than crash the run, so every one is pinned, and every pin
that asserts an ACCEPT (a real grain end is found) carries a REFUSAL next to it
(a look-alike that must NOT be counted). A reader that matched nothing at all
would pass an accept-only suite.

  1. HEREDOC BODIES — `cat > x <<'EOF' … gh pr create … EOF` must not register
     an end; `cd X` then `gh pr create` on line 2 must. Pinned against a
     first-line rule (which would drop the real one) and a naive match (which
     would take the fake one).
  2. BOUNDARY CLUSTERS — `gh pr create` then `[DONE]` is ONE end; two `[DONE]`
     an hour apart are TWO.
  3. DASHBOARD READS — a `read` echoing `[DONE]` is not an end; an `append` is.
  Plus the window pairing (`END,END,START` is one window from the last END;
  an END with no following START is dropped, never infinite), sidechain
  exclusion, branch-creation vs `git worktree list`, month attribution on the
  event timestamp (not the file), dir scope, and a golden `main()` corpus.

Run standalone (no pytest needed):
  python scripts/tests/test_coursia_picker_friction.py
Or under pytest:
  pytest scripts/tests/test_coursia_picker_friction.py
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "coursia-picker-friction.py")

_spec = importlib.util.spec_from_file_location("cpf", _TARGET)
cpf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cpf)


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


# ── fixture builders ─────────────────────────────────────────────────────────

def _rec(ts, name, inp, side=False):
    return json.dumps({
        "type": "assistant", "timestamp": ts, "isSidechain": side,
        "message": {"role": "assistant",
                    "content": [{"type": "tool_use", "name": name, "input": inp}]},
    })


def _bash(ts, cmd, side=False):
    return _rec(ts, "Bash", {"command": cmd}, side)


def _dash(ts, action, content):
    return _rec(ts, cpf.DASH, {"action": action, "content": content, "type": "workspace"})


def _write_dir(files):
    """files: {relpath: [jsonl lines]} -> a temp projects dir."""
    d = tempfile.mkdtemp(prefix="cpf-test-")
    for rel, lines in files.items():
        p = os.path.join(d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    return d


def _scan(lines, ws="CoursIA"):
    d = _write_dir({"c--dev-CoursIA/s.jsonl": lines})
    try:
        ev, _ = cpf.scan_file(os.path.join(d, "c--dev-CoursIA", "s.jsonl"), ws)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    return ev


def _kinds(ev, kind):
    return [e for e in ev if e[1] == kind]


# ── trap 1: heredocs ─────────────────────────────────────────────────────────

def test_strip_heredocs_unit():
    cmd = "cd /x\ncat > s.sh <<'EOF'\ngh pr create -f\necho done\nEOF\nls -la"
    out = cpf.strip_heredocs(cmd)
    _check("gh pr create" not in out, f"body not stripped: {out!r}")
    _check("ls -la" in out and "cd /x" in out, f"real lines lost: {out!r}")
    # An unquoted marker and a `-` marker both terminate.
    for marker in ("EOF", "'EOF'", '"EOF"'):
        c = f"cat > f <<{marker}\ngh issue list\n{marker.strip(chr(39)+chr(34))}\nafter"
        _check("gh issue list" not in cpf.strip_heredocs(c), f"marker {marker} leaked")


def test_heredoc_body_pr_create_is_not_an_end():
    lines = [_bash("2026-07-01T10:00:00.000Z",
                   "cat > body.md <<'EOF'\ngh pr create --title x\nEOF")]
    _check(_kinds(_scan(lines), "END") == [], "heredoc body counted as an END")


def test_pr_create_on_second_line_is_still_an_end():
    # The refusal-adjacent ACCEPT: a real multi-line command keeps its end.
    lines = [_bash("2026-07-01T10:00:00.000Z", "cd /c/dev/CoursIA\ngh pr create -f")]
    _check(len(_kinds(_scan(lines), "END")) == 1, "real multi-line pr create missed")


# ── trap 3: dashboard reads vs writes ────────────────────────────────────────

def test_dashboard_read_is_not_a_boundary():
    lines = [_dash("2026-07-01T10:00:00.000Z", "read", "history: [DONE] [CLAIMED]")]
    ev = _scan(lines)
    _check(_kinds(ev, "END") == [] and _kinds(ev, "START") == [],
           "a dashboard READ produced a boundary")


def test_dashboard_append_is_a_boundary():
    lines = [_dash("2026-07-01T10:00:00.000Z", "append", "[DONE] cycle report"),
             _dash("2026-07-01T11:00:00.000Z", "append", "[CLAIMED] #42")]
    ev = _scan(lines)
    _check(len(_kinds(ev, "END")) == 1, "append [DONE] missed")
    _check(len(_kinds(ev, "START")) == 1, "append [CLAIMED] missed")


# ── trap 2: clusters ─────────────────────────────────────────────────────────

def test_cluster_collapses_same_kind_in_one_grain():
    lines = [_bash("2026-07-01T10:00:00.000Z", "gh pr create -f"),
             _dash("2026-07-01T10:01:00.000Z", "append", "[DONE]")]
    ev = _scan(lines)
    b = cpf.cluster(ev, 10 * 60)
    _check(len([x for x in b if x[1] == "END"]) == 1,
           f"pr create + [DONE] not collapsed: {b}")
    lines = [_dash("2026-07-01T11:00:00.000Z", "append", "[CLAIMED] #7"),
             _bash("2026-07-01T11:01:00.000Z", "git worktree add ../w -b fix/7-slug")]
    b = cpf.cluster(_scan(lines), 10 * 60)
    _check(len([x for x in b if x[1] == "START"]) == 1,
           f"claim + worktree add not collapsed: {b}")


def test_cluster_separates_far_apart():
    lines = [_dash("2026-07-01T10:00:00.000Z", "append", "[DONE] a"),
             _dash("2026-07-01T11:30:00.000Z", "append", "[DONE] b")]
    b = cpf.cluster(_scan(lines), 10 * 60)
    _check(len([x for x in b if x[1] == "END"]) == 2,
           f"two far-apart ends collapsed: {b}")


# ── window pairing ───────────────────────────────────────────────────────────

def test_windows_end_end_start_is_one_window_from_last_end():
    lines = [
        _dash("2026-07-01T10:00:00.000Z", "append", "[DONE] grain A"),
        _bash("2026-07-01T10:30:00.000Z", "gh pr create -f"),      # 2nd end
        _bash("2026-07-01T10:40:00.000Z", "gh issue list --state open"),
        _dash("2026-07-01T11:00:00.000Z", "append", "[CLAIMED] #9"),
    ]
    ev = _scan(lines)
    w, dropped = cpf.windows(cpf.cluster(ev, 60), ev)
    _check(len(w) == 1, f"expected ONE window, got {len(w)}")
    _check(w[0][0].strftime("%H:%M") == "10:30",
           f"window should start at the LAST end (10:30), got {w[0][0]}")
    _check(w[0][3] == 1, f"picker call count wrong: {w[0][3]}")
    _check(dropped == 0, f"unexpected drop: {dropped}")


def test_windows_end_without_start_is_dropped():
    lines = [_dash("2026-07-01T10:00:00.000Z", "append", "[DONE] last of session")]
    ev = _scan(lines)
    w, dropped = cpf.windows(cpf.cluster(ev, 600), ev)
    _check(w == [], f"a dangling END made a window: {w}")
    _check(dropped == 1, f"dangling END not reported as dropped: {dropped}")


def test_windows_start_before_any_end_makes_no_window():
    lines = [_dash("2026-07-01T09:00:00.000Z", "append", "[CLAIMED] #1"),
             _dash("2026-07-01T09:10:00.000Z", "append", "[DONE]")]
    ev = _scan(lines)
    w, _ = cpf.windows(cpf.cluster(ev, 600), ev)
    _check(w == [], f"a leading START opened a window: {w}")


# ── branches vs inventory, sidechain, months ─────────────────────────────────

def test_branch_creation_vs_worktree_list():
    for cmd in ("git checkout -b fix/x", "git switch -c fix/x",
                "git worktree add ../w -b fix/x"):
        ev = _scan([_bash("2026-07-01T10:00:00.000Z", cmd)])
        _check(len(_kinds(ev, "START")) == 1, f"{cmd!r} not a START")
    # `git worktree list` is a picker inventory call, NOT a grain start.
    ev = _scan([_bash("2026-07-01T10:00:00.000Z", "git worktree list")])
    _check(_kinds(ev, "START") == [], "git worktree list counted as a START")
    _check(len(_kinds(ev, "PICKER")) == 1, "git worktree list not a PICKER")


def test_sidechain_records_excluded():
    lines = [_bash("2026-07-01T10:00:00.000Z", "gh issue list", side=True),
             _bash("2026-07-01T10:01:00.000Z", "gh pr create -f", side=True)]
    ev = _scan(lines)
    _check(ev == [], f"sidechain events leaked: {ev}")


def test_month_attribution_uses_event_timestamp():
    d = _write_dir({"c--dev-CoursIA/s.jsonl": [
        _dash("2026-07-31T23:00:00.000Z", "append", "[DONE] july"),
        _dash("2026-08-01T00:30:00.000Z", "append", "[CLAIMED] #1"),
        _dash("2026-09-02T10:00:00.000Z", "append", "[DONE] sept"),
    ]})
    try:
        ev, _ = cpf.scan_file(os.path.join(d, "c--dev-CoursIA", "s.jsonl"), "CoursIA")
        w, _ = cpf.windows(cpf.cluster(ev, 600), ev)
        july = [x for x in w if x[0].strftime("%Y-%m") == "2026-07"]
        _check(len(july) == 1, f"one session must feed both months: {w}")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_dir_scope_accepts_and_refuses():
    for name in ("c--dev-CoursIA", "d--Dev-CoursIA-2", "C--dev-CoursIA-3",
                 "C--dev-CoursIA--claude-worktrees-cost-frontmatter-mig-genai"):
        _check(cpf.DIR_RE.match(name), f"should accept {name}")
    for name in ("claudish", "c--dev-CoursIA-issue-debt-ledger", "random"):
        _check(not cpf.DIR_RE.match(name), f"should refuse {name}")


# ── golden main() ────────────────────────────────────────────────────────────

GOLDEN = [
    # one July grain: end (pr create + done) -> 2 picker calls -> start
    _bash("2026-07-01T10:00:00.000Z", "gh pr create -f"),
    _dash("2026-07-01T10:01:00.000Z", "append", "[DONE] grain A"),
    _bash("2026-07-01T10:10:00.000Z", "gh issue list --state open"),
    _bash("2026-07-01T10:12:00.000Z", "gh pr view 5 --json state"),
    _dash("2026-07-01T10:20:00.000Z", "append", "[CLAIMED] #2"),
    # second grain in September, no picker calls
    _bash("2026-09-03T09:00:00.000Z", "gh pr create -f"),
    _bash("2026-09-03T09:30:00.000Z", "git worktree add ../w -b fix/3"),
]


def _run_main(argv):
    buf = io.StringIO()
    code = None
    with contextlib.redirect_stdout(buf):
        try:
            cpf.main(argv)
        except SystemExit as e:
            code = e.code
    return buf.getvalue(), code


def test_golden_main():
    d = _write_dir({"c--dev-CoursIA/s.jsonl": GOLDEN})
    try:
        out, code = _run_main(["2026-07", "2026-09", "--projects-dir", d])
    finally:
        shutil.rmtree(d, ignore_errors=True)
    _check(code is None, f"clean corpus exited nonzero: {code}")
    _check("2026-07 — grains(started) 1 | friction windows 1" in out,
           f"July cell wrong:\n{out}")
    _check("picker calls / window : mean=2.0" in out, f"picker count wrong:\n{out}")
    _check("windows with >=1: 1/1 (100%)" in out, f"share wrong:\n{out}")
    _check("2026-09 — grains(started) 1 | friction windows 1" in out,
           f"September cell wrong:\n{out}")
    _check("picker calls / window : mean=0.0" in out, f"Sept picker count wrong:\n{out}")


def test_main_refuses_empty_corpus():
    d = tempfile.mkdtemp(prefix="cpf-empty-")
    try:
        out, code = _run_main(["2026-07", "--projects-dir", d])
    finally:
        shutil.rmtree(d, ignore_errors=True)
    _check(code == 2, f"empty corpus must exit 2, got {code}: {out}")


def test_main_refuses_malformed_month():
    out, code = _run_main(["2026-7", "--projects-dir", tempfile.gettempdir()])
    _check(code == 2, f"malformed month must exit 2, got {code}")


# ── standalone runner ────────────────────────────────────────────────────────

def main():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failed = []
    for t in tests:
        try:
            t()
            print(f"  PASS {t.__name__}")
        except AssertionError as e:
            print(f"  FAIL {t.__name__}: {e}")
            failed.append(t.__name__)
    print()
    if failed:
        print(f"FAILED {len(failed)}/{len(tests)}: {failed}")
        return 1
    print(f"OK — {len(tests)} test groups passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
