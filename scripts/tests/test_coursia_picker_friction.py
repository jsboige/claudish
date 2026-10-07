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


# ── window class: named / scan / direct (#328 G3 suite) ─────────────────────

def test_window_class_named_scan_direct():
    """Three windows in one file: a numbered view names a target (named), an
    unnumbered inventory search does not (scan), and no picker at all is
    direct. Each class ACCEPT is pinned on its own window so a classifier
    collapsing everything to one class cannot pass."""
    lines = [
        _dash("2026-07-01T10:00:00.000Z", "append", "[DONE] grain A"),
        _bash("2026-07-01T10:20:00.000Z", "gh issue view 42"),
        _dash("2026-07-01T10:30:00.000Z", "append", "[CLAIMED] #42"),
        _dash("2026-07-01T11:00:00.000Z", "append", "[DONE] grain B"),
        _bash("2026-07-01T11:10:00.000Z", "gh issue list --state open"),
        _bash("2026-07-01T11:15:00.000Z", "gh search prs --author me"),
        _dash("2026-07-01T11:30:00.000Z", "append", "[CLAIMED] #7"),
        _dash("2026-07-01T12:00:00.000Z", "append", "[DONE] grain C"),
        _dash("2026-07-01T12:10:00.000Z", "append", "[CLAIMED] #9"),
    ]
    ev = _scan(lines)
    w, _ = cpf.windows(cpf.cluster(ev, 60), ev)
    _check(len(w) == 3, f"expected 3 windows, got {len(w)}: {w}")
    by_class = {x[6]: x for x in w}
    _check(set(by_class) == {"named", "scan", "direct"},
           f"class set wrong: {sorted(by_class)}")
    _check(by_class["named"][3] == 1, f"named window picker count wrong: {by_class}")
    _check(by_class["scan"][3] == 2, f"scan window picker count wrong: {by_class}")
    _check(by_class["direct"][3] == 0, f"direct window has pickers: {by_class}")


def test_numbered_view_refuses_lookalikes():
    """`--web` and slug views carry NO number: the window must stay scan — a
    look-alike that would inflate the named share."""
    lines = [
        _dash("2026-07-01T10:00:00.000Z", "append", "[DONE] grain A"),
        _bash("2026-07-01T10:10:00.000Z", "gh pr view --web"),
        _bash("2026-07-01T10:15:00.000Z", "gh issue view my-team/slug-issue"),
        _dash("2026-07-01T10:30:00.000Z", "append", "[CLAIMED] #5"),
    ]
    ev = _scan(lines)
    w, _ = cpf.windows(cpf.cluster(ev, 60), ev)
    _check(len(w) == 1 and w[0][6] == "scan",
           f"numberless views must keep the window scan: {w}")


def test_numbered_view_inside_heredoc_body_is_not_named():
    """A `gh issue view 42` quoted inside a heredoc body is not a selection
    (trap 1 applied to the class signal) — the window stays scan."""
    lines = [
        _dash("2026-07-01T10:00:00.000Z", "append", "[DONE] grain A"),
        _bash("2026-07-01T10:10:00.000Z",
              "cat > x.sh <<'EOF'\ngh issue view 42\nEOF\necho done"),
        _bash("2026-07-01T10:15:00.000Z", "gh issue list"),
        _dash("2026-07-01T10:30:00.000Z", "append", "[CLAIMED] #5"),
    ]
    ev = _scan(lines)
    w, _ = cpf.windows(cpf.cluster(ev, 60), ev)
    _check(len(w) == 1 and w[0][6] == "scan",
           f"heredoc-quoted numbered view must not name the window: {w}")


def test_list_cap_is_announced_and_configurable():
    # --list truncated to --list-cap (default 400) WITHOUT saying so made a
    # truncated dump read as complete (06/10 review). Now: announced on
    # stderr when the cap bites, 0 = no cap.
    lines = []
    # 25 grains: end -> start, 30 min apart => 50 boundaries.
    for i in range(25):
        lines.append(_dash(f"2026-07-01T10:{i % 60:02d}:00.000Z" if False else
                           f"2026-07-01T{i//2:02d}:{(i*2) % 60:02d}:00.000Z",
                           "append", "[DONE] g"))
        lines.append(_dash(f"2026-07-01T{i//2:02d}:{(i*2) % 60:02d}:30.000Z",
                           "append", "[CLAIMED] #n"))
    d = _write_dir({"c--dev-CoursIA/s.jsonl": lines})
    try:
        import io as _io, contextlib as _ctx
        out, err = _io.StringIO(), _io.StringIO()
        with _ctx.redirect_stdout(out), _ctx.redirect_stderr(err):
            code = None
            try:
                cpf.main(["2026-07", "--projects-dir", d, "--list", "--list-cap", "3"])
            except SystemExit as e:
                code = e.code
        _check(code is None, f"--list exited nonzero: {code}")
        listing = out.getvalue()
        _check(len([l for l in listing.splitlines() if l.startswith("  ")]) == 3,
               f"--list-cap 3 must print 3 boundaries:\n{listing}")
        _check("truncated at 3/50" in err.getvalue(),
               f"truncation must be announced on stderr: {err.getvalue()!r}")
        # no cap: all boundaries print, no announcement
        err2 = _io.StringIO()
        with _ctx.redirect_stdout(out), _ctx.redirect_stderr(err2):
            cpf.main(["2026-07", "--projects-dir", d, "--list", "--list-cap", "0"])
        _check("truncated" not in err2.getvalue(),
               f"no cap must not announce truncation: {err2.getvalue()!r}")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_active_only_p50_differs_from_all_windows_p50():
    """CR pin (M3): the 'active only' p50 must be held by a test where it
    DIFFERS from the all-windows p50 — a mixed corpus of 3 zero-picker
    windows and 2 four-call windows. Under the M3 mutation (counts_with =
    counts) both lines print the same p50 and this goes red; a corpus of
    only-active windows would stay green and pin nothing."""
    lines = [
        # W1 active: 4 picker calls, first at +2 min, START at +15 -> span 13
        _dash("2026-07-01T10:00:00.000Z", "append", "[DONE] A"),
        _bash("2026-07-01T10:02:00.000Z", "gh issue list"),
        _bash("2026-07-01T10:04:00.000Z", "gh issue list"),
        _bash("2026-07-01T10:06:00.000Z", "gh issue list"),
        _bash("2026-07-01T10:08:00.000Z", "gh issue list"),
        _dash("2026-07-01T10:15:00.000Z", "append", "[CLAIMED] #1"),
        # W2 zero-picker
        _dash("2026-07-01T10:30:00.000Z", "append", "[DONE] B"),
        _dash("2026-07-01T10:35:00.000Z", "append", "[CLAIMED] #2"),
        # W3 active: same shape as W1
        _dash("2026-07-01T11:00:00.000Z", "append", "[DONE] C"),
        _bash("2026-07-01T11:02:00.000Z", "gh issue list"),
        _bash("2026-07-01T11:04:00.000Z", "gh issue list"),
        _bash("2026-07-01T11:06:00.000Z", "gh issue list"),
        _bash("2026-07-01T11:08:00.000Z", "gh issue list"),
        _dash("2026-07-01T11:15:00.000Z", "append", "[CLAIMED] #3"),
        # W4, W5 zero-picker
        _dash("2026-07-01T11:30:00.000Z", "append", "[DONE] D"),
        _dash("2026-07-01T11:35:00.000Z", "append", "[CLAIMED] #4"),
        _dash("2026-07-01T12:00:00.000Z", "append", "[DONE] E"),
        _dash("2026-07-01T12:05:00.000Z", "append", "[CLAIMED] #5"),
    ]
    d = _write_dir({"c--dev-CoursIA/s.jsonl": lines})
    try:
        out, code = _run_main(["2026-07", "--projects-dir", d])
        _check(code is None, f"clean corpus exited nonzero: {code}")
        # counts = [4,0,4,0,0]: all-windows p50 = 0, active-only p50 = 4 (n=2)
        _check("picker calls / window : mean=1.6 p50=0 p90=4" in out,
               f"all-windows p50 line wrong (expected p50=0 on mixed corpus):\n{out}")
        _check("picker calls / window (active only, n=2) : mean=4.0 p50=4 p90=4" in out,
               f"active-only line wrong (expected mean=4.0 p50=4, differs from all):\n{out}")
        # acts = [13,0,13,0,0]: all p50 = 0, active-only p50 = 13 (n=2)
        _check("active span first-picker->START min : p50=0 p90=13" in out,
               f"all-windows active-span line wrong:\n{out}")
        _check("active span (windows with a picker, n=2) : p50=13 p90=13" in out,
               f"active-only span line wrong (expected p50=13, differs from all):\n{out}")
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ── self-check bias: numbered views of the lane's OWN fresh PR (#328 G3) ────

def test_selfcheck_bias_isolated():
    """The bias is measured, not assumed to cancel: a numbered view right
    after the window's `gh pr create` END is a self-check of the lane's own
    PR and is excluded from the `pure` class; a numbered view LATE in a
    pr-create window, or after a dashboard END (the built-in control —
    nothing was created there), stays a named pick."""
    lines = [
        # window A: pr-create END, numbered view +2min → SELF-CHECK
        _bash("2026-07-01T10:00:00.000Z", "gh pr create -f"),
        _bash("2026-07-01T10:02:00.000Z", "gh pr view 5 --json state"),
        _dash("2026-07-01T10:30:00.000Z", "append", "[CLAIMED] #5"),
        # window B: pr-create END, numbered view +25min (near START) → PICK
        _bash("2026-07-01T11:00:00.000Z", "gh pr create -f"),
        _bash("2026-07-01T11:25:00.000Z", "gh issue view 7"),
        _dash("2026-07-01T11:30:00.000Z", "append", "[CLAIMED] #7"),
        # window C (control): dashboard END, numbered view +10min → PICK
        _dash("2026-07-01T12:00:00.000Z", "append", "[DONE] grain C"),
        _bash("2026-07-01T12:10:00.000Z", "gh pr view 9"),
        _dash("2026-07-01T12:30:00.000Z", "append", "[CLAIMED] #9"),
    ]
    ev = _scan(lines)
    w, _ = cpf.windows(cpf.cluster(ev, 60), ev)
    _check(len(w) == 3, f"expected 3 windows, got {len(w)}: {w}")
    a, b, c = w
    _check(a[6] == "named" and a[8] == "scan",
           f"A raw named → pure scan (selfcheck excluded): {a[6]}/{a[8]}")
    _check(a[9] == (1, 1), f"A: 1 numbered view, 1 selfcheck: {a[9]}")
    _check(b[6] == "named" and b[8] == "named",
           f"B: late view stays a pick: {b[6]}/{b[8]}")
    _check(b[9] == (1, 0), f"B: 1 numbered, 0 selfcheck: {b[9]}")
    _check(c[6] == "named" and c[8] == "named",
           f"C control: dashboard-END numbered is a pick: {c[6]}/{c[8]}")
    _check(c[9] == (1, 0), f"C: never selfcheck after a dashboard END: {c[9]}")


def test_selfcheck_only_window_is_pure_scan():
    """A window whose ONLY picker call is a self-check keeps total>0 (the call
    happened — not `direct`) but no named target: pure class is scan."""
    lines = [
        _bash("2026-07-01T10:00:00.000Z", "gh pr create -f"),
        _bash("2026-07-01T10:01:00.000Z", "gh pr view 12"),
        _dash("2026-07-01T10:20:00.000Z", "append", "[CLAIMED] #12"),
    ]
    ev = _scan(lines)
    w, _ = cpf.windows(cpf.cluster(ev, 60), ev)
    _check(len(w) == 1 and w[0][6] == "named" and w[0][8] == "scan",
           f"selfcheck-only window: raw named, pure scan: {w}")


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
