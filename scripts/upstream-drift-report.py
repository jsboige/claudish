#!/usr/bin/env python3
"""Reproducible upstream drift report for the claudish fork (#897 P0).

Read-only. Never merges, never writes into the working tree. Uses `git
merge-tree --write-tree` (git >= 2.38) so the trial merge happens entirely in
the object database — safe to run at any time, on any branch, in CI.

Outputs:
  - conflict count per ZONE (the unit workers claim in #897),
  - per-file classification: ours-only / upstream-only / both-rewrote,
  - files upstream deleted that we modified (modify/delete conflicts),
  - our files upstream never touched (merge-clean private surface),
  - commit drift both ways since the merge-base.

Usage (from the repo root, or with --repo):
  python -I scripts/upstream-drift-report.py --repo D:/dev/claudish
  python -I scripts/upstream-drift-report.py --json drift.json
Deterministic: no network (fetch is a separate, explicit step), same input refs
=> same output. Exit 0 always (the report is the deliverable, not a gate).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict

# Zone = the unit a seat claims in #897. Order matters: first match wins.
ZONES: list[tuple[str, str]] = [
    ("handlers/shared", r"^packages/cli/src/handlers/shared/"),
    ("handlers", r"^packages/cli/src/handlers/"),
    ("providers/transport", r"^packages/cli/src/providers/transport/"),
    ("providers", r"^packages/cli/src/providers/"),
    ("adapters", r"^packages/cli/src/adapters/"),
    ("channel", r"^packages/cli/src/channel/"),
    ("auth", r"(^|/)auth"),
    ("scripts", r"^scripts/"),
    ("compose/infra", r"(docker-compose|\.env|Dockerfile|\.docker)"),
    ("docs", r"(^docs/|\.md$)"),
    ("tests", r"(test|\.test\.ts$|test-fixtures)"),
    ("fork", r"^packages/cli/src/fork/"),
    ("proxy-server", r"^packages/cli/src/proxy-server\.ts$"),
    ("mcp", r"^packages/cli/src/(mcp-server|mcp-session)"),
    ("middleware", r"^packages/cli/src/middleware/"),
    ("team/tui", r"^packages/cli/src/(team-|tui/)"),
    ("config", r"^packages/cli/src/(config-|profile-config|default-provider|model-selector)"),
    ("cli/core", r"^packages/cli/src/[^/]+\.(ts|tsx)$|^packages/cli/(bin/|bunfig|package\.json)|bunfig|package\.json|\.gitignore"),
]
ZONE_OTHER = "other"


def zone_of(path: str) -> str:
    for name, pat in ZONES:
        if re.search(pat, path):
            return name
    return ZONE_OTHER


def git(repo: str, *args: str, check: bool = True) -> str:
    p = subprocess.run(
        ["git", "-C", repo, *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if check and p.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} -> rc={p.returncode}\n{p.stderr.strip()[:400]}")
    return p.stdout


def changed_files(repo: str, rng: str) -> set[str]:
    out = git(repo, "diff", "--name-only", "--diff-filter=ACMRD", rng)
    return {l.strip() for l in out.splitlines() if l.strip()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--ours", default="main")
    ap.add_argument("--theirs", default="upstream/main")
    ap.add_argument("--json", dest="json_path", default="")
    args = ap.parse_args()
    repo = args.repo

    ours = git(repo, "rev-parse", args.ours).strip()
    theirs = git(repo, "rev-parse", args.theirs).strip()
    base = git(repo, "merge-base", ours, theirs).strip()

    n_theirs = int(git(repo, "rev-list", "--count", f"{ours}..{theirs}").strip())
    n_ours = int(git(repo, "rev-list", "--count", f"{theirs}..{ours}").strip())

    # Trial merge in the object DB. rc=1 => conflicts (expected), not an error.
    mt = subprocess.run(
        ["git", "-C", repo, "merge-tree", "--write-tree", "--name-only",
         "--no-messages", ours, theirs],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if mt.returncode not in (0, 1):
        print(mt.stderr[:800], file=sys.stderr)
        return 2
    lines = [l for l in mt.stdout.splitlines() if l.strip()]
    # First line = tree OID; conflicted paths follow (with --name-only).
    conflicted = lines[1:] if mt.returncode == 1 else []

    ours_changed = changed_files(repo, f"{base}..{ours}")
    theirs_changed = changed_files(repo, f"{base}..{theirs}")

    # Files upstream deleted between base..theirs (diff-filter=D).
    deleted_theirs = {
        l.strip()
        for l in git(repo, "diff", "--name-only", "--diff-filter=D",
                     f"{base}..{theirs}").splitlines() if l.strip()
    }
    # Ours-only files upstream never touched since base (private surface).
    ours_only_files = sorted(p for p in ours_changed if p not in theirs_changed)

    rows = []
    for path in sorted(set(conflicted)):
        in_ours = path in ours_changed
        in_theirs = path in theirs_changed
        if path in deleted_theirs and in_ours:
            kind = "modify/delete (upstream deleted, we modified)"
        elif in_ours and in_theirs:
            kind = "both-rewrote"
        elif in_ours:
            kind = "ours-only rewrite"
        else:
            kind = "upstream-only rewrite"
        rows.append({"path": path, "zone": zone_of(path), "kind": kind})

    by_zone = Counter(r["zone"] for r in rows)
    by_kind = Counter(r["kind"] for r in rows)
    modify_delete = [r for r in rows if r["kind"].startswith("modify/delete")]

    report = {
        "ours": ours, "theirs": theirs, "merge_base": base,
        "commits_theirs_ahead": n_theirs, "commits_ours_ahead": n_ours,
        "conflict_files": len(rows),
        "conflicts_by_zone": dict(by_zone.most_common()),
        "conflicts_by_kind": dict(by_kind.most_common()),
        "modify_delete": [r["path"] for r in modify_delete],
        "ours_changed_files": len(ours_changed),
        "ours_only_files_upstream_untouched": len(ours_only_files),
        "rows": rows,
    }

    print(f"merge-base {base[:12]}  ours {ours[:12]} ({args.ours})  "
          f"theirs {theirs[:12]} ({args.theirs})")
    print(f"drift: upstream ahead {n_theirs}, ours ahead {n_ours}")
    print(f"conflicting files: {len(rows)}")
    print("\n-- conflicts by ZONE (claim unit for #897) --")
    for z, c in by_zone.most_common():
        print(f"  {c:4d}  {z}")
    print("\n-- conflicts by KIND --")
    for k, c in by_kind.most_common():
        print(f"  {c:4d}  {k}")
    print(f"\n-- modify/delete (upstream deleted, we modified): {len(modify_delete)} --")
    for r in modify_delete:
        print(f"  {r['path']}")
    print(f"\nours changed {len(ours_changed)} files since base; "
          f"{len(ours_only_files)} of them upstream never touched (merge-clean surface).")

    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        print(f"\nJSON written: {args.json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
