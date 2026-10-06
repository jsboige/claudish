#!/usr/bin/env python3
"""coursia-picker-friction.py — how painfully does a lane pick its next grain?

Measures, for CoursIA WORKER lanes, the delay and the tool calls between the END
of one grain and the START of the next (#328 G3). Read-only, no model probe:
the corpus is the Claude Code transcript JSONL already on disk.

Definitions, because a published number is only as good as its boundary model:

  END   of a grain — a `gh pr create`, or a dashboard WRITE whose content
        carries `[DONE]`.
  START of a grain — a branch creation (`git checkout -b` / `git switch -c` /
        `git worktree add`), or a dashboard WRITE carrying `[CLAIMED]`.
  grain           — a START boundary followed by the next END boundary.
  friction window — an END boundary followed by the next START boundary, both
        in the same session file (a window whose session ends first is DROPPED,
        not counted as infinite).

Three traps that make an already-published number wrong rather than crashing,
each pinned in scripts/tests/test_coursia_picker_friction.py:

  1. HEREDOC BODIES. A lane writes a script with `cat > x <<'EOF'` whose body
     contains `gh pr create`, and a PR body heredoc repeats `gh pr create`. A
     naive match counts those as grain ends. Bodies are stripped before any
     match — but `gh pr create` on line 2+ of a real command is LEGITIMATE, so
     the strip is a heredoc strip, never a first-line rule.
  2. BOUNDARY CLUSTERS. One grain end emits `gh pr create` then `[DONE]`; one
     start emits `[CLAIMED]` then one or more worktree adds. Counting each hit
     collapses the window to zero. Same-kind events within `--cluster-min`
     collapse to ONE boundary.
  3. DASHBOARD READS. `roosync_dashboard` is called 397 times as `read` against
     802 `append` in the July sample. Only writes (`append`/`write`/`update`)
     carry a marker that means anything; a read whose *result text* echoes
     `[DONE]` is not a grain end.

Scope, declared rather than hidden: this reads whatever transcript directory it
is pointed at. On po-2024 that is po-2024's own lanes only — the fleet-wide
transcript archive (Drive `claude-transcripts/<machine>/`) starts 2026-08-28,
so the OTHER machines' July is unrecoverable, and the local semantic index
holds only local skeletons. July and September are therefore compared on the
same lane set, which is what makes the comparison valid at all.

Flag-don't-assert: the delta is contaminated by the cron cadence — a lane
idle-waits between cycles, which is not picker friction. The report prints the
picker-call count next to the delta, and the "active" span (first picker call
to the START) next to the total, so a reader can separate waiting from picking.
Marker prevalence can also shift between months (a reporting convention, not a
behaviour); the script prints it, it does not interpret it.

Usage:
  python scripts/coursia-picker-friction.py [YYYY-MM ...] [--cluster-min N]
                                            [--projects-dir DIR] [--list]
  # default months: 2026-07 2026-09

Exit codes: 0 clean · 2 usage or empty corpus.
"""
import argparse
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta

PROJECTS_DEFAULT = os.path.join(os.path.expanduser("~"), ".claude", "projects")
# CoursIA transcript dirs, exact-anchored (the G2 lesson): `c--dev-CoursIA`,
# `d--Dev-CoursIA-2`, `C--dev-CoursIA--claude-worktrees-…`, … The workspace key
# is the CoursIA segment plus its `-N` suffix, so `-2`/`-3` ventilate apart.
DIR_RE = re.compile(r"^[cCdD]--(?:[Dd]ev-)?(?P<ws>CoursIA(?:-\d)?)(?:--|$)")
DASH = "mcp__roo-state-manager__roosync_dashboard"
WRITE_ACTIONS = {"append", "write", "update"}
MONTHS = ["2026-07", "2026-09"]
CLUSTER_MIN = 10

# A real `gh pr create`, on any line of a command whose heredoc bodies are gone.
RE_PR_CREATE = re.compile(r"\bgh\s+pr\s+create\b")
# Branch creation: `checkout -b/-B`, `switch -c/-C`, `worktree add` (a plain
# `git worktree list` is an inventory scan, not a start — see PICKER below).
RE_BRANCH = re.compile(r"\bgit\s+(?:checkout|switch)\s+-[bBcC]\b|\bgit\s+worktree\s+add\b")
# Picker calls — what a lane does to FIND its next grain. Enumerated so a reader
# can re-derive the class, never a fuzzy "search-ish" match.
PICKER_BASH = [
    ("gh_issue", re.compile(r"\bgh\s+issue\s+(?:list|view|status)\b")),
    ("gh_pr", re.compile(r"\bgh\s+pr\s+(?:list|view|status)\b")),
    ("gh_search", re.compile(r"\bgh\s+search\s+(?:issues|prs|repos)\b")),
    ("branch_inventory", re.compile(r"\bgit\s+(?:worktree\s+list|branch\s+-a)\b")),
]
# A `view <N>` names a concrete target — the selection-shape signal (#328 G3
# suite). Declared limit: a view right after `gh pr create` may just be the
# lane checking its OWN fresh PR; the bias is the same instrument both months,
# so it cancels in the July-vs-September comparison (same argument as the
# published counter), but a single-month `named` share is a proxy, never a
# dispatch join — that join is G2's to make.
RE_NUMBERED_VIEW = re.compile(r"\bgh\s+(?:issue|pr)\s+view\s+\d")
PICKER_MCP = {"mcp__roo-state-manager__roosync_search",
              "mcp__roo-state-manager__conversation_browser"}
RE_BACKLOG_PATH = re.compile(r"backlog|ledger|issue-debt|roadmap|open-questions", re.I)
RE_HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def strip_heredocs(cmd):
    """Remove `<<MARKER … MARKER` bodies (trap 1). A `gh` command on line 2+ of
    the surviving text is kept — only body lines are dropped."""
    out, until = [], None
    for ln in cmd.split("\n"):
        if until is not None:
            if ln.strip() == until:
                until = None
            continue
        out.append(ln)
        m = RE_HEREDOC.search(ln)
        if m:
            until = m.group(2)
    return "\n".join(out)


def scan_file(path, ws):
    """Transcript JSONL -> boundary events [(dt, kind, detail)]. `kind` is
    START / END / PICKER. Sidechain (sub-agent) records are skipped: a
    sub-agent's calls are not the lane choosing a grain."""
    ev = []
    n_calls = 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("isSidechain"):
                continue
            ts = d.get("timestamp")
            m = d.get("message")
            if not ts or not isinstance(m, dict) or not isinstance(m.get("content"), list):
                continue
            try:
                dt = datetime.strptime(ts.replace("Z", ""), "%Y-%m-%dT%H:%M:%S.%f")
            except ValueError:
                continue
            for b in m["content"]:
                if not (isinstance(b, dict) and b.get("type") == "tool_use"):
                    continue
                n_calls += 1
                name, inp = b.get("name"), b.get("input") or {}
                if name == "Bash":
                    cmd = strip_heredocs(inp.get("command", "") or "")
                    if RE_PR_CREATE.search(cmd):
                        ev.append((dt, "END", "gh pr create", ws, path, False))
                    if RE_BRANCH.search(cmd):
                        ev.append((dt, "START", "branch", ws, path, False))
                    for cls, rx in PICKER_BASH:
                        if rx.search(cmd):
                            numbered = bool(RE_NUMBERED_VIEW.search(cmd))
                            ev.append((dt, "PICKER", cls, ws, path, numbered))
                elif name == DASH and str(inp.get("action")) in WRITE_ACTIONS:
                    c = str(inp.get("content", ""))
                    if "[DONE]" in c:
                        ev.append((dt, "END", "dashboard [DONE]", ws, path, False))
                    if "[CLAIMED]" in c:
                        ev.append((dt, "START", "dashboard [CLAIMED]", ws, path, False))
                elif name in PICKER_MCP:
                    ev.append((dt, "PICKER", name.split("__")[-1], ws, path, False))
                elif name == "Read" and RE_BACKLOG_PATH.search(str(inp.get("file_path", ""))):
                    ev.append((dt, "PICKER", "backlog_read", ws, path, False))
    ev.sort(key=lambda e: e[0])
    return ev, n_calls


def select_files(projects, months):
    out = []
    for d in glob.glob(os.path.join(projects, "*")):
        if not os.path.isdir(d):
            continue
        m = DIR_RE.match(os.path.basename(d))
        if not m:
            continue
        for f in glob.glob(os.path.join(d, "*.jsonl")):
            out.append((f, m.group("ws")))
    return sorted(out)


def cluster(events, cluster_s):
    """Same-kind boundary events within `cluster_s` collapse to ONE boundary,
    stamped at the FIRST (trap 2). PICKER events are not boundaries."""
    bnd = []
    for e in events:
        if e[1] not in ("START", "END"):
            continue
        if bnd and bnd[-1][1] == e[1] and (e[0] - bnd[-1][0]).total_seconds() <= cluster_s \
                and bnd[-1][4] == e[4]:
            continue
        bnd.append(e)
    return bnd


def windows(bounds, events):
    """Per file, walk boundaries in order: the pending END is the LATEST one
    seen, and the next START closes a window from it (the immediately preceding
    end — so `END, END, START` is ONE window, not two, and not a dropped one).
    An END with no following START in its file ends at the session boundary and
    is DROPPED, never counted as an infinite window. Returns windows
    [(end_dt, start_dt, picker Counter, total_picker, first_picker_dt|None, ws,
    class)] plus the dropped count. `class` is the selection SHAPE of the
    window: 'named' (>=1 numbered `view <N>` — a concrete target was on the
    lane's mind), 'scan' (picker calls but no numbered view — the grain was
    searched for), 'direct' (no picker call at all)."""
    pickers = defaultdict(list)
    for e in events:
        if e[1] == "PICKER":
            pickers[e[4]].append(e)
    per_file = defaultdict(list)
    for b in bounds:
        per_file[b[4]].append(b)
    out, dropped = [], 0
    for f, bs in per_file.items():
        pending = None
        for b in sorted(bs, key=lambda x: x[0]):
            if b[1] == "END":
                pending = b
            elif b[1] == "START":
                if pending is None:
                    continue
                win = [p for p in pickers[f] if pending[0] < p[0] < b[0]]
                cnt = Counter(p[2] for p in win)
                total = sum(cnt.values())
                named = any(len(p) > 5 and p[5] for p in win)
                wclass = "direct" if total == 0 else ("named" if named else "scan")
                first = min((p[0] for p in win), default=None)
                out.append((pending[0], b[0], cnt, total, first, b[3], wclass))
                pending = None
        if pending is not None:
            dropped += 1
    out.sort(key=lambda w: w[0])
    return out, dropped


def pct(vals, q):
    vals = sorted(vals)
    return vals[min(len(vals) - 1, int(len(vals) * q))] if vals else 0


def main(argv=None):
    p = argparse.ArgumentParser(description="CoursIA picker friction (#328 G3)")
    p.add_argument("months", nargs="*", default=None)
    p.add_argument("--cluster-min", type=float, default=CLUSTER_MIN)
    p.add_argument("--projects-dir", default=PROJECTS_DEFAULT)
    p.add_argument("--list", action="store_true", help="print boundary events per file")
    a = p.parse_args(sys.argv[1:] if argv is None else argv)
    months = a.months or list(MONTHS)
    bad = [m for m in months if not re.fullmatch(r"\d{4}-\d{2}", m)]
    if bad:
        p.error(f"malformed month(s) {bad}")
    files = select_files(a.projects_dir, months)
    if not files:
        print(f"no CoursIA transcripts under {a.projects_dir}", file=sys.stderr)
        raise SystemExit(2)

    all_ev, n_files, n_calls = [], 0, 0
    for f, ws in files:
        try:
            ev, nc = scan_file(f, ws)
        except OSError:
            continue
        n_files += 1
        n_calls += nc
        all_ev.extend(ev)
        if n_files % 20 == 0:
            print(f"  … {n_files}/{len(files)} files, {n_calls} tool calls",
                  file=sys.stderr, flush=True)
    all_ev.sort(key=lambda e: e[0])
    bounds = cluster(all_ev, a.cluster_min * 60)
    wins, dropped = windows(bounds, all_ev)
    print(f"corpus: {n_files} files, {n_calls} tool calls, "
          f"{len(all_ev)} boundary/picker events, {len(bounds)} boundaries, "
          f"{dropped} END(s) dropped at a session end "
          f"(projects-dir={a.projects_dir}, cluster={a.cluster_min:g}min)")

    if a.list:
        for e in bounds[:400]:
            print(f"  {e[0]} {e[1]:5} {e[2]:18} {os.path.basename(e[4])[:12]}")
        return

    for mo in months:
        mw = [w for w in wins if w[0].strftime("%Y-%m") == mo]
        grains = [b for b in bounds if b[1] == "START" and b[0].strftime("%Y-%m") == mo]
        print(f"\n=== {mo} — grains(started) {len(grains)} | friction windows {len(mw)} ===")
        if not mw:
            print("  no windows")
            continue
        deltas = [(s - e).total_seconds() / 60 for e, s, _, _, _, _, _ in mw]
        counts = [c for _, _, _, c, _, _, _ in mw]
        acts = [((s - fp).total_seconds() / 60 if fp else 0.0)
                for e, s, _, _, fp, _, _ in mw]
        withp = sum(1 for c in counts if c > 0)
        reopened = sum(1 for d in deltas if d > 360)
        print(f"  delta END->START min : p50={pct(deltas,.5):.0f} p90={pct(deltas,.9):.0f} "
              f"max={max(deltas):.0f} | >6h (session reopened, not friction): {reopened}")
        print(f"  delta when a picker call exists (n={withp}): "
              f"p50={pct([d for d,c in zip(deltas,counts) if c>0],.5):.0f}")
        print(f"  picker calls / window : mean={sum(counts)/len(counts):.1f} "
              f"p50={pct(counts,.5):.0f} p90={pct(counts,.9):.0f} "
              f"| windows with >=1: {withp}/{len(mw)} ({100*withp/len(mw):.0f}%)")
        print(f"  active span first-picker->START min : p50={pct(acts,.5):.0f} "
              f"p90={pct(acts,.9):.0f}")
        cls = Counter()
        for _, _, c, _, _, _, _ in mw:
            cls.update(c)
        print("  picker class mix      : " + ", ".join(f"{k}:{v}" for k, v in cls.most_common()))
        bws = defaultdict(int)
        for w in mw:
            bws[w[5]] += 1
        print("  windows per workspace : " + ", ".join(f"{k}:{v}" for k, v in sorted(bws.items())))
        print("  window class (selection shape) — share, picker calls, delta:")
        for wclass in ("named", "scan", "direct"):
            sub = [w for w in mw if w[6] == wclass]
            if not sub:
                print(f"    {wclass:7}: 0 windows")
                continue
            sc = [w[3] for w in sub]
            sd = [(w[1] - w[0]).total_seconds() / 60 for w in sub]
            print(f"    {wclass:7}: {len(sub):3} ({100*len(sub)/len(mw):3.0f}%) | "
                  f"calls/window mean={sum(sc)/len(sc):4.1f} p50={pct(sc,.5):3.0f} "
                  f"p90={pct(sc,.9):3.0f} | delta p50={pct(sd,.5):3.0f} min")
    print(f"\n  [scope] files under {a.projects_dir}; July is single-machine (see docstring)")


if __name__ == "__main__":
    main()
