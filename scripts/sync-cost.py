#!/usr/bin/env python3
r"""sync-cost — what the upstream drift costs, measured, not estimated (#731/S0).

The Epic's questions are "what can be absorbed now", "which refactors shrink the
conflict set", "what does the drift cost per week". None of them is answerable
from a feeling, so this script freezes the numbers:

    python scripts/sync-cost.py [--fork main] [--upstream upstream/main]
        [--json-out FILE] [--md-out FILE] [--top 20] [--selftest]

Outputs the same facts in two shapes (JSON for comparison across runs, markdown
for a comment on the Epic). It writes ONLY the paths named on the command line —
no refs, no branch, no working-tree file, no tag. `git merge-tree --write-tree`
does create a tree object, which is idempotent and unaddressed by any ref.

WHAT IT MEASURES, AND WHAT IT REFUSES TO

  conflicts      one row per conflicted file, with the conflict CLASS git itself
                 reported (`content`, `add/add`, `modify/delete`,
                 `file-location`) and the churn on both sides since the merge
                 base. The class is not inferred from a heuristic — it is parsed
                 from git's own CONFLICT line.
  absorption     upstream commits split into `disjoint` (touch no file the fork
                 has touched since the base) and `coupled` (touch >= 1).
  orchestration  line counts of the shared hot modules on each ref.

  `blocked` is deliberately a NULL with a reason, not a number. Blocked means
  "disjoint on paper but depends on a conflicted predecessor", and that is a
  per-commit dependency judgement — S3's job (`git cherry-pick` outcomes on a
  scratch branch), not a property this script can compute. Inventing a
  mechanical proxy here would be the instrument lying in the Epic's own voice.
  Do not "fix" the null into a count.

READING RULES THAT CHANGE A VERDICT

  - `disjoint` is a FILE statement, never a claim of cherry-pickability. A
    disjoint commit can depend on a coupled predecessor; the honesty note in
    the Epic body says so and this instrument keeps it visible.
  - churn counts COMMITS, not lines. A 40-commit file upstream retitled ten
    times is not a hot seam; read the counts next to the orchestration table.
  - the numbers move with the refs, so every block records the resolved SHAs.
    Two runs are comparable only if those SHAs match — that is what
    `--selftest` and the `control` block are for.
  - `files.fork_modified_since_base` is the denominator of the absorption
    split: it is `git diff --name-only base..fork`, renames resolved the way
    git resolves them by default.
  - rename detection is LOAD-BEARING, not cosmetic: with `diff.renames=false`
    this instrument reads 119 conflicts instead of 122 — the three
    `file-location` rows exist only because upstream renamed `channel/` to
    `mcp-session/`. Measured while building it (28/10), recorded here so the
    next reader does not "simplify" the flag away.
  - a MERGE commit carries no file list under `--name-only`, so its file set is
    empty. Empty is vacuously disjoint from the fork's files, which inflates
    the absorbable surface: `disjoint_empty_diff` is reported next to
    `disjoint_with_diff` so a pure merge is never mistaken for work to
    cherry-pick. The Epic's 55 % headline is the sum of both; the number a wave
    plan can actually use is `disjoint_with_diff`.

DETERMINISM (the acceptance bar: same refs => byte-identical output, twice)

  - no timestamp, no hostname, no clock, no absolute repo path in either
    output shape;
  - every list sorted, `json.dumps(..., sort_keys=True)`;
  - git invoked with `-c diff.renames=true` and `core.quotePath=false`
    PINNED, so a user's own `diff.renames` or a non-ASCII path cannot change
    the bytes (and the conflict count stays 122 rather than 119).

Exit codes: 0 ok · 2 a ref (or the merge base) does not resolve · 3 the
`control` block failed an internal invariant · 4 `--selftest` found a drift.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

SCHEMA = "sync-cost/1"

# The modules the Epic named as the inverted orchestration (finding 3), plus the
# module upstream extracted from composed-handler.ts. A missing path on one side
# is 0 lines and is reported as such, never skipped silently.
ORCHESTRATION_PATHS = [
    "packages/cli/src/proxy-server.ts",
    "packages/cli/src/handlers/composed-handler.ts",
    "packages/cli/src/handlers/handler-set.ts",
    "packages/cli/src/hooks/response-seam.ts",
]

# Area buckets for the disjoint half, so S3 can order waves. The rule is
# path-shaped and stated here once: docs = `docs/` or a root `*.md`; tests =
# a `.test.`/`.spec.` segment or a `test`/`tests`/`__tests__` directory; config =
# dotfiles, `.github/`, `*.json`, `*.toml`, `*.yml`; code = `packages/` or
# `src/`; everything else = `other`.
def area_of(path):
    parts = path.split("/")
    name = parts[-1]
    if path.startswith("docs/") or (len(parts) == 1 and name.endswith(".md")):
        return "docs"
    if (
        ".test." in name
        or ".spec." in name
        or any(seg in ("test", "tests", "__tests__") for seg in parts[:-1])
    ):
        return "tests"
    if (
        path.startswith(".github/")
        or name.startswith(".")
        or name.endswith((".json", ".toml", ".yml", ".yaml", ".lock"))
    ):
        return "config"
    if path.startswith(("packages/", "src/")):
        return "code"
    return "other"


def git(*args, check=True):
    """Run git with the determinism flags every call shares."""
    cmd = [
        "git",
        "-c",
        "core.quotePath=false",
        "-c",
        "diff.renames=true",
        "-c",
        "log.showSignature=false",
        "--no-pager",
        *args,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and proc.returncode != 0:
        raise GitError(args, proc.returncode, proc.stderr.strip())
    return proc


class GitError(RuntimeError):
    def __init__(self, args, code, stderr):
        super().__init__(f"git {' '.join(args)} -> {code}: {stderr}")
        self.code = code
        self.stderr = stderr


def resolve(ref, label):
    """Resolve a ref to a commit SHA, or die with an explicit diagnostic."""
    proc = git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False)
    sha = proc.stdout.strip()
    if proc.returncode != 0 or not sha:
        print(f"sync-cost: {label} ref does not resolve: {ref!r}", file=sys.stderr)
        sys.exit(2)
    return sha


def commit_count(rev_range):
    return int(git("rev-list", "--count", rev_range).stdout.strip())


def commit_date(rev):
    return git("log", "-1", "--format=%ad", "--date=short", rev).stdout.strip()


def diff_names(rev_range):
    out = git("diff", "--name-only", rev_range).stdout
    return {line for line in out.split("\n") if line}


def log_file_sets(rev_range):
    """One `git log` pass per range -> {sha: {paths it touched}}.

    One pass for 1 775 commits beats 122 per-file queries and yields the same
    numbers; churn is derived from it rather than paid for twice. A merge
    commit legitimately yields an empty set (`--name-only` prints no diff for a
    merge) — that emptiness is preserved, never smoothed away.
    """
    out = git("log", "--name-only", "--format=\x01%H", rev_range).stdout
    per_commit = {}
    for block in out.split("\x01"):
        if not block.strip():
            continue
        lines = block.split("\n")
        sha = lines[0].strip()
        per_commit[sha] = {p.strip() for p in lines[1:] if p.strip()}
    return per_commit


def churn(rev_range, paths):
    """path -> commits in the range that touched it, path-simplified.

    `git rev-list --count <range> -- <path>` is the definition, deliberately:
    it is the one the Epic's published table used (159 fork / 92 upstream for
    `CLAUDE.md`, reproduced exactly), it counts merges that carry the change
    into the branch, and it is a command any reader can re-run by hand. The
    one-pass `log_file_sets` aggregation reads 153 / 80 on the same file because
    `--name-only` prints nothing for a merge — measured 28/10, and the reason
    this table does not reuse that pass. Two definitions, two jobs, both named.
    """
    counts = {}
    for path in paths:
        counts[path] = int(git("rev-list", "--count", rev_range, "--", path).stdout.strip() or 0)
    return counts


def line_count(rev, path):
    proc = git("show", f"{rev}:{path}", check=False)
    if proc.returncode != 0:
        return None
    text = proc.stdout
    return text.count("\n") + (0 if text.endswith("\n") or not text else 1)


def parse_conflicts(fork_ref, upstream_ref):
    """Run the merge and return (classes, tree_oid).

    `--write-tree` exits 1 when there are conflicts — that is the expected
    outcome, not an error. Any other non-zero code is a real failure and is
    raised, because a merge that could not run must never read as "0 conflicts".
    """
    proc = git(
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--messages",
        fork_ref,
        upstream_ref,
        check=False,
    )
    if proc.returncode not in (0, 1):
        raise GitError(("merge-tree", fork_ref, upstream_ref), proc.returncode, proc.stderr.strip())

    lines = proc.stdout.split("\n")
    tree_oid = lines[0].strip() if lines and lines[0].strip() else None

    by_path = {}
    relocated = {}
    for line in lines[1:]:
        if line.startswith("CONFLICT ("):
            head, _, tail = line.partition("):")
            class_ = head[len("CONFLICT (") :]
            tail = tail.strip()
            if class_ == "modify/delete":
                # "CONFLICT (modify/delete): <path> deleted in X and modified in Y."
                path = tail.split(" deleted in ", 1)[0].strip()
            elif class_ == "file location":
                # "CONFLICT (file location): <path> added in main inside a
                #  directory that was renamed in <other>, suggesting it should
                #  perhaps be moved to <target>."
                # The source path is the one the FORK added; the target is where
                # upstream's rename would put it. The name-only section lists the
                # TARGET, so the target is dropped below and kept as a hint —
                # otherwise one conflict is counted twice (125 instead of 122).
                path = tail.split(" added in ", 1)[0].strip()
                if "moved to " in tail:
                    target = tail.split("moved to ", 1)[1].rstrip(".").strip()
                    if target:
                        relocated[target] = path
            else:
                # "CONFLICT (content): Merge conflict in <path>"
                path = tail.split("Merge conflict in ", 1)[-1].strip()
            if path:
                by_path[path] = {"path": path, "class": class_.replace(" ", "-")}
        elif line.startswith(("Auto-merging ", "Removing ", "Adding ")):
            continue
        elif line.strip() and not line.startswith(" "):
            # A bare path in the conflicted-file-info section: belt and braces,
            # so a git whose message wording changed still yields the file list.
            probe = line.strip()
            if "/" in probe or "." in probe:
                by_path.setdefault(probe, {"path": probe, "class": "unclassified"})

    for target, source in relocated.items():
        if target == source:
            continue
        # Only an unclassified row can be the rename target ghost; a path that
        # git also reports under a real class is a conflict in its own right.
        if by_path.get(target, {}).get("class") == "unclassified":
            by_path.pop(target)
        if source in by_path:
            by_path[source]["suggested_path"] = target
    return by_path, tree_oid


def measure(fork_ref, upstream_ref, top):
    fork_sha = resolve(fork_ref, "fork")
    upstream_sha = resolve(upstream_ref, "upstream")

    proc = git("merge-base", fork_ref, upstream_ref, check=False)
    base = proc.stdout.strip()
    if proc.returncode != 0 or not base:
        print(
            f"sync-cost: no merge base between {fork_ref!r} and {upstream_ref!r}",
            file=sys.stderr,
        )
        sys.exit(2)

    fork_commits = commit_count(f"{base}..{fork_ref}")
    upstream_commits = commit_count(f"{base}..{upstream_ref}")

    fork_files = diff_names(f"{base}..{fork_ref}")
    upstream_per_commit = log_file_sets(f"{base}..{upstream_ref}")

    conflicts, tree_oid = parse_conflicts(fork_ref, upstream_ref)
    conflict_paths = sorted(conflicts)
    fork_churn = churn(f"{base}..{fork_ref}", conflict_paths)
    upstream_churn = churn(f"{base}..{upstream_ref}", conflict_paths)

    rows = []
    for path in sorted(conflicts):
        row = {
            "path": path,
            "class": conflicts[path]["class"],
            "fork_commits": fork_churn.get(path, 0),
            "upstream_commits": upstream_churn.get(path, 0),
        }
        if "suggested_path" in conflicts[path]:
            row["suggested_path"] = conflicts[path]["suggested_path"]
        rows.append(row)

    by_class = {}
    for row in rows:
        by_class[row["class"]] = by_class.get(row["class"], 0) + 1

    # Absorption split, recomputed from the same churn pass rather than trusted
    # from a previous comment. A commit is disjoint when every path it touched
    # is outside the fork's modified set; a merge commit (empty set) is
    # vacuously disjoint and is reported separately so it cannot pass for work.
    disjoint, coupled, empty_diff = 0, 0, 0
    disjoint_by_area = {"code": 0, "config": 0, "docs": 0, "other": 0, "tests": 0}
    for sha, paths in upstream_per_commit.items():
        if not paths:
            empty_diff += 1
            disjoint += 1
            continue
        if paths.isdisjoint(fork_files):
            disjoint += 1
            for area in {area_of(p) for p in paths}:
                disjoint_by_area[area] = disjoint_by_area.get(area, 0) + 1
        else:
            coupled += 1
    disjoint_with_diff = disjoint - empty_diff

    orchestration = []
    for path in ORCHESTRATION_PATHS:
        fork_lines = line_count(fork_sha, path)
        upstream_lines = line_count(upstream_sha, path)
        orchestration.append(
            {
                "path": path,
                "fork_lines": fork_lines if fork_lines is not None else 0,
                "upstream_lines": upstream_lines if upstream_lines is not None else 0,
                "fork_present": fork_lines is not None,
                "upstream_present": upstream_lines is not None,
            }
        )

    total_conflicts = len(rows)
    control = {
        "sum_by_class_equals_total": sum(by_class.values()) == total_conflicts,
        "rows_equal_total": total_conflicts == len(rows),
        "disjoint_plus_coupled_equals_upstream_ahead": (disjoint + coupled) == upstream_commits,
        "disjoint_splits_into_with_and_without_diff": (disjoint_with_diff + empty_diff) == disjoint,
        "conflict_classes_known": all(
            row["class"] in ("content", "add/add", "modify/delete", "file-location")
            for row in rows
        ),
    }

    return {
        "schema": SCHEMA,
        "refs": {
            "fork": fork_ref,
            "fork_sha": fork_sha,
            "upstream": upstream_ref,
            "upstream_sha": upstream_sha,
            "base": base,
            "base_date": commit_date(base),
        },
        "commits": {"fork_ahead": fork_commits, "upstream_ahead": upstream_commits},
        "files": {"fork_modified_since_base": len(fork_files)},
        "conflicts": {
            "total": total_conflicts,
            "tree_oid": tree_oid,
            "by_class": by_class,
            "files": rows,
            "top_by_churn": sorted(
                rows, key=lambda r: (-(r["fork_commits"] + r["upstream_commits"]), r["path"])
            )[:top],
        },
        "upstream_absorption": {
            "disjoint": disjoint,
            "disjoint_with_diff": disjoint_with_diff,
            "disjoint_empty_diff": empty_diff,
            "coupled": coupled,
            "disjoint_by_area": disjoint_by_area,
            "blocked": {
                "value": None,
                "reason": (
                    "not mechanically measurable at S0: 'blocked' means a disjoint commit "
                    "depends on a conflicted predecessor, which needs a per-commit "
                    "cherry-pick walk (S3). This instrument refuses to proxy it."
                ),
            },
        },
        "orchestration": orchestration,
        "control": control,
    }


def render_markdown(data):
    refs = data["refs"]
    commits = data["commits"]
    conflicts = data["conflicts"]
    absorption = data["upstream_absorption"]

    lines = []
    lines.append(
        f"<!-- sync-cost {SCHEMA} · fork {refs['fork_sha'][:8]} · upstream {refs['upstream_sha'][:8]} "
        f"· base {refs['base'][:8]} -->"
    )
    lines.append("")
    lines.append(f"**Refs** — fork `{refs['fork']}` @ `{refs['fork_sha'][:12]}` · "
                 f"upstream `{refs['upstream']}` @ `{refs['upstream_sha'][:12]}` · "
                 f"base `{refs['base'][:12]}` ({refs['base_date']})")
    lines.append("")

    lines.append("| Metric | Value |")
    lines.append("|---|---|")
    lines.append(f"| Fork ahead | **{commits['fork_ahead']}** commits |")
    lines.append(f"| Upstream ahead | **{commits['upstream_ahead']}** commits |")
    lines.append(f"| `merge-tree` conflicted files | **{conflicts['total']}** |")
    lines.append(f"| Files the fork modified since base | {data['files']['fork_modified_since_base']} |")
    share = (
        100.0 * absorption["disjoint"] / commits["upstream_ahead"] if commits["upstream_ahead"] else 0.0
    )
    lines.append(
        f"| Upstream commits touching **zero** fork-modified file | **{absorption['disjoint']}** "
        f"/ {commits['upstream_ahead']} = {share:.0f} % |"
    )
    lines.append(
        f"| — of which carry a diff (the number a wave plan can use) | "
        f"**{absorption['disjoint_with_diff']}** |"
    )
    lines.append(
        f"| — of which are merges / empty diffs (no cherry-pick surface) | "
        f"{absorption['disjoint_empty_diff']} |"
    )
    lines.append(
        f"| Upstream commits touching >= 1 fork-modified file | {absorption['coupled']} |"
    )
    for item in data["orchestration"]:
        if item["path"].endswith(("proxy-server.ts", "composed-handler.ts")):
            lines.append(
                f"| `{item['path'].split('/')[-1]}` lines (fork / upstream) | "
                f"{item['fork_lines']} / {item['upstream_lines']} |"
            )
    lines.append("")

    lines.append(f"**Conflicts by class** — " + " · ".join(
        f"`{cls}` {n}" for cls, n in sorted(conflicts["by_class"].items())
    ))
    lines.append("")

    lines.append(f"**Top {len(conflicts['top_by_churn'])} conflicted files by churn** (commits since base)")
    lines.append("")
    lines.append("| File | Conflict | Fork commits | Upstream commits |")
    lines.append("|---|---|---|---|")
    for row in conflicts["top_by_churn"]:
        lines.append(
            f"| `{row['path']}` | {row['class']} | {row['fork_commits']} | {row['upstream_commits']} |"
        )
    lines.append("")

    areas = absorption["disjoint_by_area"]
    lines.append(
        "**Disjoint half by area** (a commit counts in each area it touches) — "
        + " · ".join(f"{area} {areas.get(area, 0)}" for area in ("code", "tests", "docs", "config", "other"))
    )
    lines.append("")
    lines.append(
        "**Blocked** — null by design: "
        + absorption["blocked"]["reason"]
    )
    lines.append("")
    failed = [name for name, ok in sorted(data["control"].items()) if not ok]
    if failed:
        lines.append(f"⚠ **control** — failed invariants: {', '.join(failed)}")
    else:
        lines.append("**control** — all invariants hold (classes sum to total, rows = total, "
                     "disjoint + coupled = upstream ahead).")
    lines.append("")
    return "\n".join(lines)


def dumps(data):
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def write_only(path, text):
    """Write exactly the path asked for — nothing else, not even a directory."""
    if path is None:
        return
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Measure the claudish fork/upstream divergence (Epic #731, grain S0)."
    )
    parser.add_argument("--fork", default="main", help="fork ref (default: main)")
    parser.add_argument("--upstream", default="upstream/main", help="upstream ref (default: upstream/main)")
    parser.add_argument("--json-out", help="write JSON here (default: stdout is markdown only)")
    parser.add_argument("--md-out", help="write markdown here")
    parser.add_argument("--top", type=int, default=20, help="rows in the churn table (default: 20)")
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="measure twice and fail (exit 4) unless both renders are byte-identical",
    )
    args = parser.parse_args(argv)

    data = measure(args.fork, args.upstream, args.top)
    json_text = dumps(data)
    md_text = render_markdown(data)

    if args.selftest:
        with tempfile.TemporaryDirectory() as tmp:
            previous = os.environ.get("GIT_OPTIONAL_LOCKS")
            os.environ["GIT_OPTIONAL_LOCKS"] = "0"
            try:
                again = measure(args.fork, args.upstream, args.top)
            finally:
                if previous is None:
                    os.environ.pop("GIT_OPTIONAL_LOCKS", None)
                else:
                    os.environ["GIT_OPTIONAL_LOCKS"] = previous
            ok = dumps(again) == json_text and render_markdown(again) == md_text
            del tmp
        if not ok:
            print("sync-cost: selftest FAILED — two runs on the same refs differ", file=sys.stderr)
            return 4
        print("sync-cost: selftest ok — two runs byte-identical", file=sys.stderr)

    failed = [name for name, ok in sorted(data["control"].items()) if not ok]
    if failed:
        print(f"sync-cost: control invariants failed: {', '.join(failed)}", file=sys.stderr)
        write_only(args.json_out, json_text)
        write_only(args.md_out, md_text)
        if args.json_out is None and args.md_out is None:
            sys.stdout.write(md_text)
        return 3

    write_only(args.json_out, json_text)
    write_only(args.md_out, md_text)
    if args.json_out is None and args.md_out is None:
        sys.stdout.write(md_text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
