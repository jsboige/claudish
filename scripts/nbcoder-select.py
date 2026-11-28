#!/usr/bin/env python3
"""nb_coder batch selection for CoursIA C# parity targets, GitHub-App wired.

Mandate (ai-01:CoursIA GO, 2026-11-19T01:03Z, thread c2048-nbcoder-app-
selection): selection reads ride the per-lane GitHub App installation's OWN
quota bucket. The token is forged at start, lives in the child process
environment only, is never printed, never written to disk. If the App is
unavailable the tool refuses explicitly (exit 3) and NEVER falls back to the
shared account. Writes (issues, PRs, comments) are out of scope by design.

Verification is 4-way, REST-only (list endpoints carry bodies; no per-item
calls): (a) C# twin absent from the PINNED tree (default origin/main — the
working index is not an oracle), (b) target absent from ANY open PR's changed
files (all pages), (c) target absent from ANY open issue body, (d) target
absent from a declared in-flight grains file.

Instrument honesty: a failed Git read REFUSES (exit 2) — it is never read as
an empty tree, which would turn every Python notebook into a false orphan.
Credential-bearing subprocess failures report a sanitized status only.

Proof mode: --evidence FILE records the App bucket before/after and the call
count (App bucket delta must equal the call count up to the documented
tolerance); --corpus-check re-runs the same selection under the shared
identity in a SEPARATE process (--shared-corpus-dump, never the default) and
requires an identical candidate corpus on the same snapshot. A corpus
mismatch refuses (exit 2) whether or not --evidence is given.

Portable configuration: the gh binary is resolved from NBCODER_GH then PATH;
--repo defaults to the current directory; --forge defaults to
<repo>/scripts/secrets/github_app_token.py; --tmp-root defaults to
<$TMP>/nbcoder-select. No machine-specific path is baked in.

Exit codes: 0 ok; 2 usage/instrument defect; 3 App unavailable (refusal,
zero network calls made by this process).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BS = chr(92)
SUF = "-Python.ipynb"
IPYNB = re.compile(r"`([A-Za-z0-9_./" + BS + r"-]+\.ipynb)`")

EXIT_OK = 0
EXIT_DEFECT = 2
EXIT_APP_UNAVAILABLE = 3
EXIT_NOT_FREE = 4

DEFAULT_APP_ID = "5751481"  # coursia-lane-po-2028
DEFAULT_PEM = "~/.secrets/github-apps/coursia-lane-po-2028.pem"
DEFAULT_PIN = "origin/main"
API_MAX_PAGES = 100


class InstrumentError(RuntimeError):
    """An instrument (git, gh) failed. Never degrade it to 'empty'."""


def resolve_gh() -> str | None:
    """Portable gh resolution: explicit env override, then PATH."""
    return os.environ.get("NBCODER_GH") or shutil.which("gh")


def forge_token(forge: Path, pem: Path, app_id: str, repo: str) -> str:
    """Forge an installation token via the fleet organ. Token lives in memory.

    Any failure mode (missing organ, unreadable key, HTTP refusal, empty
    output) is the refusal witness: caller must exit 3, never fall back.
    The subprocess is credential-bearing, so failures report a SANITIZED
    status only — exit code and a fixed label, never the child's output.
    """
    if not forge.is_file():
        raise RuntimeError(f"forge organ absent: {forge}")
    if not pem.is_file():
        raise RuntimeError(f"App private key absent: {pem}")
    r = subprocess.run(
        [sys.executable, str(forge), "--app-id", app_id, "--key", str(pem), "--repo", repo, "--quiet"],
        capture_output=True, text=True, encoding="utf-8", timeout=60,
    )
    if r.returncode != 0:
        # Sanitized on purpose: stderr/stdout of a credential-bearing child
        # can leak key material or token fragments into logs and dashboards.
        raise RuntimeError(f"forge exited {r.returncode} (output suppressed: credential-bearing subprocess)")
    token = (r.stdout or "").strip()
    if not token:
        raise RuntimeError("forge printed no token")
    return token


class Identity:
    """One GitHub identity for every gh subprocess of a selection run.

    App mode injects GH_TOKEN in the child environment (never argv, never
    disk). Shared mode is the explicit comparison identity only.
    """

    def __init__(self, gh: str, token: str | None, label: str):
        self.gh_bin = gh
        self.token = token
        self.label = label
        self.calls = 0

    def gh(self, args: list[str]) -> str:
        env = dict(os.environ)
        if self.token is not None:
            env["GH_TOKEN"] = self.token
        r = subprocess.run([self.gh_bin, *args], capture_output=True, text=True, encoding="utf-8", env=env)
        if r.returncode != 0:
            endpoint = args[1] if len(args) > 1 else "?"
            # Sanitized: gh stderr can echo auth material. Status only.
            raise InstrumentError(f"gh failed ({self.label}) rc={r.returncode} endpoint={endpoint}")
        self.calls += 1
        return r.stdout


def api_all(identity: Identity, path: str) -> list:
    """Paginate a list endpoint to exhaustion — BOUNDED.

    A page cap, not a trust: an endpoint that keeps answering exactly 100 items
    (measured 20/11: a matching bug in a fake turned `page=1` into a substring
    of `page=196965` and the loop ran unbounded) must refuse, never hang. The
    real ceilings are far below (a PR caps at 3 000 files = 30 pages).
    """
    items: list = []
    page = 1
    while page <= API_MAX_PAGES:
        chunk = json.loads(identity.gh(["api", f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}"]))
        if not chunk:
            return items
        items.extend(chunk)
        if len(chunk) < 100:
            return items
        page += 1
    raise InstrumentError(
        f"api pagination refused after {API_MAX_PAGES} pages: {path} — an endpoint "
        "that never shortens its pages is an instrument defect, not a corpus")


def norm(p: str) -> str:
    return p.replace(BS, "/")


def twin(f: str) -> str:
    d, _, name = f.rpartition("/")
    return f"{d}/{name[: -len(SUF)]}-CSharp.ipynb"


def read_pinned_tree(repo: Path, pin: str) -> set[str]:
    """The notebook membership of the PINNED tree — never the working index.

    The index carries staged/untracked state that the remote does not have;
    reading it makes selection depend on whoever last touched the checkout.
    Every Git failure REFUSES: an unreadable tree is not an empty tree.
    """
    rev = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", f"{pin}^{{commit}}"],
                         capture_output=True, text=True, encoding="utf-8")
    if rev.returncode != 0:
        raise InstrumentError(f"pinned ref unresolvable: {pin} (fetch it or pass --pin)")
    sha = rev.stdout.strip()
    # -z + core.quotePath=false: with the default, git QUOTES any non-ASCII path
    # ("...Cr\303\251ateur..."), so endswith('.ipynb') silently drops it — an
    # accented -CSharp twin would vanish from cs and its Python source would
    # become a false orphan, which is the exact class this selector closes.
    ls = subprocess.run(["git", "-C", str(repo), "-c", "core.quotePath=false",
                         "ls-tree", "-r", "-z", "--name-only", sha],
                        capture_output=True, text=True, encoding="utf-8")
    if ls.returncode != 0:
        raise InstrumentError(f"git ls-tree failed on {pin} — refusing to read an empty tree")
    return {norm(p) for p in ls.stdout.split("\0") if p.endswith(".ipynb")}


def resolve_inflight(tmp_root: Path, inflight_queues: list[str]) -> set[str]:
    """Targets a named state-dir already covers. Two accepted shapes.

    Fail-closed (the #1120 class): a NAMED state-dir whose grains cannot be
    read is a read failure (typo in the name), never 'nothing in flight'. A
    finished queue is retired by removing its whole state-dir AND dropping the
    --inflight name, not one file alone.

    The shapes, because the live directories carry neither name the first
    revision expected (#1170, measured 23/11: zero grains.jsonl under
    .tmp/nbst while every state-dir holds state.json + scheduler.jsonl — the
    single-shape read therefore refused every real state-dir):
      * grains.jsonl — an explicit queue copy, when a launcher writes one;
      * state.json   — the scheduler's own status file; its grain keys are
                       "<issue>:<notebook>" and ARE the authority on what a
                       state-dir has taken.
    """
    inflight: set[str] = set()
    for q in inflight_queues:
        d = tmp_root / q
        p = d / "grains.jsonl"
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue          # an in-flight blank line is not a defect
                g = json.loads(line)
                for k in ("notebook", "source_nb"):
                    if g.get(k):
                        inflight.add(norm(g[k]))
            continue
        st = d / "state.json"
        if st.exists():
            s = json.loads(st.read_text(encoding="utf-8"))
            for key in (s.get("grains") or {}):
                _, _, nb = key.partition(":")      # "#<issue>:<notebook>"
                if nb:
                    inflight.add(norm(nb))
            continue
        raise InstrumentError(
            f"in-flight queue absent: neither {p} nor {st} (typo in --inflight?)")
    return inflight


def run_selection(repo: Path, identity: Identity, inflight_queues: list[str],
                  tmp_root: Path, pin: str = DEFAULT_PIN) -> dict:
    """4-way verified availability. Every gh call rides the given identity."""
    files = read_pinned_tree(repo, pin)
    cs = {f for f in files if f.endswith("-CSharp.ipynb")}
    py = {f for f in files if f.endswith("-Python.ipynb")}
    orphans = sorted(f for f in py if twin(f) not in cs)

    prs = api_all(identity, "repos/jsboige/CoursIA/pulls?state=open")
    taken_pr: set[str] = set()
    for pr in prs:
        # ALL pages: a target on page 2 is just as taken as one on page 1.
        for f in api_all(identity, f"repos/jsboige/CoursIA/pulls/{pr['number']}/files"):
            fn = norm(f["filename"])
            if fn.endswith(".ipynb"):
                taken_pr.add(fn)

    iss = [i for i in api_all(identity, "repos/jsboige/CoursIA/issues?state=open") if "pull_request" not in i]
    taken_iss: set[str] = set()
    for i in iss:
        for t in IPYNB.findall(i.get("body") or ""):
            taken_iss.add(norm(t))

    inflight = resolve_inflight(tmp_root, inflight_queues)

    blocked = taken_pr | taken_iss | inflight
    avail = [f for f in orphans if twin(f) not in blocked and f not in blocked]
    return {"avail": avail, "counts": {
        "py": len(py), "cs": len(cs), "orphans": len(orphans),
        "open_prs": len(prs), "taken_pr": len(taken_pr),
        "open_issues": len(iss), "taken_issue": len(taken_iss),
        "inflight": len(inflight), "available": len(avail),
    }}


DELIVERED = "[DELIVERED]"


# Marker line of a grain spec: first word (after `#`-heading / `-`-bullet
# decoration) is `Cible`. Two shapes coexist, both measured on real bodies:
# the 20/11 C# template (`- Cible C# : \`...-CSharp.ipynb\``) and the
# coordinator's Rust portage spec (`- Cible : \`...-Rust.ipynb\``, #27718 —
# no language suffix). A `Source :` line never matches (different first word),
# which is what keeps the portage SOURCE from being read as the target.
CIBLE_LINE = re.compile(r"^\s*(?:#+\s*|-\s*)?Cible\b")


def issue_target(body: str) -> str | None:
    """The twin notebook a grain issue asks for: the `.ipynb` on its `Cible` line.

    Bodies vary ('a creer', 'a créer', path between backticks) — the marker line is
    the stable part across templates (C# 20/11 and Rust portage 21/11, both
    bullets carrying the backticked target on the SAME line). A template change
    is caught by a test, not in production.
    """
    for line in (body or "").splitlines():
        if CIBLE_LINE.match(line):
            found = IPYNB.findall(line)
            if found:
                return norm(found[-1])
    return None


# The `paths:` clause of a lane marker's HEAD line (`[DELIVERED] lane L -- PR #N --
# paths: a, b`), the form the harness and check_lane_claim.py write. Read from the
# first line only: a path quoted in the explanation below is prose, not the scope.
PATHS_CLAUSE = re.compile(r"(?<![`\"'\w])paths\s*:\s*([^\n]+?)\s*$", re.IGNORECASE)


def marker_paths(body: str) -> list[str] | None:
    """The paths a marker's head line scopes it to, or None when it names no clause."""
    head = (body or "").lstrip().splitlines()[0] if (body or "").strip() else ""
    m = PATHS_CLAUSE.search(head)
    if not m:
        return None
    return [norm(x.strip().strip("`")) for x in m.group(1).split(",") if x.strip()]


def delivered_covers(body: str, path: str) -> bool:
    """Does this [DELIVERED] marker speak for `path`, one path of a lot issue?

    A scoped marker speaks for the paths of its clause only: on lot #27133, the
    MGS-28 delivery (27/11) froze MGS-27, attributed to the same lane by a bounded
    [OVERRIDE] (28/11), because the bar read every marker as issue-wide. An
    UNSCOPED marker stays fail-closed when it names the notebook (its basename
    or its stem anywhere in the comment, the 25/11 MGS-29 form); one that names
    neither is not this path's delivery -- the pinned-tree and open-PR legs, which
    a delivered grain cannot escape (its PR is open, or its file is on main),
    still read that path independently."""
    scoped = marker_paths(body)
    if scoped is not None:
        return path in scoped
    base = path.rsplit("/", 1)[-1]
    stem = base[:-len(".ipynb")] if base.endswith(".ipynb") else base
    return base in body or stem in body


def parse_preflight_arg(raw: str) -> tuple[list[int], dict[int, str]]:
    """`N[,N...]` with an optional `=path` per entry, for a path of a lot issue."""
    issues: list[int] = []
    paths: dict[int, str] = {}
    for tok in raw.replace(",", " ").split():
        n, sep, path = tok.partition("=")
        issue = int(n)
        issues.append(issue)
        if sep:
            if not path.strip():
                raise ValueError(f"--preflight entry {tok!r}: empty path after '='")
            paths[issue] = norm(path.strip())
    return issues, paths


def run_preflight(repo: Path, identity: Identity, issues: list[int], lane: str,
                  inflight_queues: list[str], tmp_root: Path, pin: str = DEFAULT_PIN,
                  require_free: bool = False, paths: dict[int, str] | None = None) -> dict:
    """Per named issue: may a grain be queued? FOUR measurements, each opposable.

    Measured 20/11 (po-2028:claudish): `check_lane_claim.py` answers 'CLEAR: no
    OTHER lane claims #N' — it says nothing about MY OWN lane having already
    delivered the grain. #27508/#27509 came back CLEAR while open PRs #27562 and
    #27515 already carried their targets; two duplicate drivers were launched and
    killed. This mode closes that gap and names, per issue:
      (a) the target already present in the PINNED tree (read_pinned_tree — a
          failed Git read refuses, it never reads as 'absent from main');
      (b) a [DELIVERED] marker in the thread (ANY lane, my own included);
      (c) the target in an OPEN PR's changed files, ALL pages (api_all);
      (d) the lane registry's claim verdict.
    A grain is FREE only when none of them speaks.

    `paths` names, per issue, ONE path of a LOT issue (a body with no `Cible`
    line, several notebooks, each attributed by a bounded marker). Measured
    28/11 on #27133: the issue-level bar refused MGS-27 three ways at once
    (no target in body, the MGS-28 [DELIVERED], the claim organ without
    `--paths` exiting 2) while `check_lane_claim.py --paths <MGS-27>` answered
    CLEAR. With a path the target IS that path (a body whose own `Cible` names
    another notebook refuses), only a [DELIVERED] that speaks for it blocks
    (`delivered_covers`), and the claim organ receives `--paths`.

    The PR-file scan is the expensive part (~1 call per open PR). Its cache is
    DISABLED under require_free: the gate path must not serve a verdict older
    than a sibling lane's PR — that race is the reason the bar exists. In the
    plain reporting path the cache is 15 min and its age is recorded per entry.
    """
    # 23/11: the claim leg used to answer 'blocked(rc=2)' for EVERY issue when
    # --repo pointed anywhere but the CoursIA checkout (the script path does not
    # exist there, python exits 2, and a non-zero rc read as a blocking claim).
    # That is the 'instrument unreachable = clean slate' inversion: a bar that
    # cannot measure must refuse, never report a claim it never read.
    claim_script = repo / "scripts" / "check_lane_claim.py"
    if not claim_script.is_file():
        raise InstrumentError(
            f"claim organ absent: {claim_script} — pass --repo (or $NBCODER_REPO) pointing at "
            f"the CoursIA checkout; a missing organ never reads as a claim verdict")
    files = read_pinned_tree(repo, pin)
    cache = tmp_root / "pr-files-cache.json"
    taken_pr: dict[str, int] = {}
    cache_age_s: int | None = None
    if not require_free and cache.exists() and time.time() - cache.stat().st_mtime < 900:
        try:
            taken_pr = {k: int(v) for k, v in json.loads(cache.read_text(encoding="utf-8")).items()}
            cache_age_s = int(time.time() - cache.stat().st_mtime)
        except Exception:
            taken_pr = {}
    if not taken_pr:
        prs = api_all(identity, "repos/jsboige/CoursIA/pulls?state=open")
        for pr in prs:
            for f in api_all(identity, f"repos/jsboige/CoursIA/pulls/{pr['number']}/files"):
                fn = norm(f["filename"])
                if fn.endswith(".ipynb"):
                    taken_pr.setdefault(fn, pr["number"])
        if not require_free:
            # 23/11: a %TEMP% sweep removed the default tmp-root and the bar died on
            # this write AFTER paying the whole PR scan -- create the directory first.
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(taken_pr), encoding="utf-8")

    inflight = resolve_inflight(tmp_root, inflight_queues)

    report: dict = {}
    for n in issues:
        body = identity.gh(["api", f"repos/jsboige/CoursIA/issues/{n}", "--jq", ".body"])
        target = issue_target(body)
        reasons: list[str] = []
        path = (paths or {}).get(n)
        if path is not None:
            if target and target != path:
                reasons.append("path-is-not-the-issue-cible")
            target = path
        if not target:
            reasons.append("no-target-in-body")
        else:
            if target in files:
                reasons.append("target-in-main")
            if target in taken_pr:
                reasons.append(f"target-in-open-pr#{taken_pr[target]}")
            if target in inflight:
                reasons.append("target-inflight")
        comments = api_all(identity, f"repos/jsboige/CoursIA/issues/{n}/comments")
        # lstrip(): the marker is written bare at column 0 by the harness, but a
        # human hand may indent or bold it — the marker itself is the contract.
        delivered = [c for c in comments if (c.get("body") or "").lstrip().startswith(DELIVERED)]
        other_paths: list[str] = []
        if path is not None:
            other_paths = [c.get("created_at") for c in delivered
                           if not delivered_covers(c.get("body") or "", path)]
            delivered = [c for c in delivered if delivered_covers(c.get("body") or "", path)]
        if delivered:
            reasons.append("delivered-marker")
        # cwd=repo: check_lane_claim.py resolves the registry and tracked paths
        # against the repository root; run from elsewhere it answers rc=2 (measured
        # 20/11 — a BLOCKED verdict for every issue, including FREE ones).
        claim_argv = [sys.executable, str(repo / "scripts" / "check_lane_claim.py"),
                      str(n), "--lane", lane]
        if path is not None:
            claim_argv += ["--paths", path]
        claim = subprocess.run(claim_argv, cwd=str(repo),
                               capture_output=True, text=True, encoding="utf-8")
        # check_lane_claim.py contract (issue mode): 0 ok / 1 blocked (other lane, or the
        # weekly EPIC cap) / 2 io-or-gh error **or a NOT_SCOPED blocker** -- without
        # `--paths` the organ cannot prove disjointness, so a legacy `blocking_lanes`
        # entry lands on 2 (#11755, measured 23/11 on #27108). Both mean 'not clear',
        # so the verdict stays fail-closed; it now NAMES which of the two it was and
        # carries the organ's own first stderr line, where the blocking lane is written.
        if claim.returncode == 2:
            claim_verdict = "blocked(rc=2: not-scoped-or-io)"
        elif claim.returncode == 0:
            claim_verdict = "clear"
        else:
            claim_verdict = f"blocked(rc={claim.returncode})"
        claim_note = ""
        if claim.returncode != 0:
            for line in (claim.stderr or "").splitlines():
                if line.strip() and not line.startswith("  "):
                    claim_note = line.strip()[:160]
                    break
        if claim.returncode != 0:
            reasons.append("claim-" + claim_verdict)
        report[n] = {"target": target,
                     **({"scope": "path", "delivered_other_paths": other_paths}
                        if path is not None else {}),
                     "verdict": "FREE" if not reasons else "BLOCKED",
                     "reasons": reasons,
                     "claim": claim_verdict,
                     **({"claim_note": claim_note} if claim_note else {}),
                     "last_delivered": delivered[-1]["created_at"] if delivered else None}
        if cache_age_s is not None:
            report[n]["pr_files_cache_age_s"] = cache_age_s
    return report


def bucket(identity: Identity) -> dict:
    data = json.loads(identity.gh(["api", "rate_limit", "--jq", "{core: .resources.core, graphql: .resources.graphql}"]))
    return {"core_remaining": data["core"]["remaining"], "graphql_remaining": data["graphql"]["remaining"]}


def dump_avail(path: str, avail: list[str]) -> None:
    # Both call sites write under --tmp-root (--shared-corpus-dump subprocess and
    # --out): the root may legitimately not exist yet (swept %TEMP%, fresh dir),
    # same class as the PR-file cache (#1165) — create it, never crash the dump.
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "avail": avail},
                   ensure_ascii=False, indent=0), encoding="utf-8")


def proof_refusal(evidence: dict) -> str | None:
    """The refusal decision, independent of any evidence OUTPUT path.

    A wrong App bucket or a corpus mismatch is a failed proof whether or not
    the operator asked for --evidence: refusing only while recording would
    let an unrecorded run consume a mismatched corpus silently.
    """
    if not evidence.get("proof_app_bucket_used", True):
        return "PROOF FAILED: App bucket shows no/wrong consumption for this run's calls"
    if evidence.get("corpus", {}).get("identical") is False:
        return "PROOF FAILED: candidate corpus differs between identities"
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", default=os.environ.get("NBCODER_REPO", "."))
    ap.add_argument("--key", default=os.environ.get("APP_SELECT_PEM", DEFAULT_PEM))
    ap.add_argument("--forge", default=os.environ.get("APP_SELECT_FORGE"),
                    help="fleet forge organ; default: <repo>/scripts/secrets/github_app_token.py")
    ap.add_argument("--app-id", default=DEFAULT_APP_ID)
    ap.add_argument("--installation-repo", default="jsboige/CoursIA")
    ap.add_argument("--pin", default=os.environ.get("NBCODER_PIN", DEFAULT_PIN),
                    help="pinned tree the membership is read from (default origin/main)")
    ap.add_argument("--inflight", action="append", default=[], metavar="STATE_DIR_NAME",
                    help="in-flight state-dir name under --tmp-root (repeatable)")
    ap.add_argument("--tmp-root",
                    default=os.environ.get("NBCODER_TMP_ROOT") or str(Path(tempfile.gettempdir()) / "nbcoder-select"))
    ap.add_argument("--out", help="write the avail dump here (JSON)")
    ap.add_argument("--evidence", help="write the proof artifact here (JSON)")
    ap.add_argument("--corpus-check", action="store_true",
                    help="also re-run the selection under the shared identity in a SEPARATE process "
                         "and require an identical candidate corpus")
    ap.add_argument("--shared-corpus-dump", metavar="FILE",
                    help="EXPLICIT shared-identity comparison mode (corpus proof only, never the "
                         "default): run selection under the ambient shared account, write the dump")
    ap.add_argument("--witness", action="store_true",
                    help="refusal self-test: expect exit 3 on an unavailable App, zero network calls")
    ap.add_argument("--preflight", metavar="N[=PATH][,N[=PATH]...]",
                    help="bar a named issue list before queueing grains: target-in-main (pinned tree), "
                         "[DELIVERED] marker, target in an open PR (all pages), claim verdict; "
                         "N=PATH bars ONE path of a lot issue (target = PATH, path-scoped "
                         "[DELIVERED], claim organ called with --paths)")
    ap.add_argument("--lane", default=os.environ.get("NBCODER_LANE"),
                    help="lane identity handed to check_lane_claim.py (required with --preflight; "
                         "default: $NBCODER_LANE — no machine-specific default in a fleet organ)")
    ap.add_argument("--require-free", action="store_true",
                    help="with --preflight: exit 4 when any issue is not FREE, and never serve the "
                         "PR-files cache (a sibling lane's PR inside the window must be visible)")
    args = ap.parse_args(argv)

    repo = Path(args.repo)
    if not repo.is_dir():
        print(f"instrument defect: repo absent: {repo}", file=sys.stderr)
        return EXIT_DEFECT

    gh = resolve_gh()
    if not gh:
        print("instrument defect: gh not found (set NBCODER_GH or put gh on PATH)", file=sys.stderr)
        return EXIT_DEFECT

    forge = Path(args.forge) if args.forge else repo / "scripts" / "secrets" / "github_app_token.py"

    if args.witness:
        # Refusal witness: a broken App must refuse, loudly, without any gh call.
        try:
            absent_pem = Path(tempfile.gettempdir()) / "definitely-absent-nbcoder-key.pem"
            forge_token(Path(forge), absent_pem, args.app_id, args.installation_repo)
        except RuntimeError as e:
            print(f"REFUSAL WITNESS OK: App unavailable -> explicit refusal, no fallback. ({e})", file=sys.stderr)
            return EXIT_APP_UNAVAILABLE
        print("witness failed: an absent key unexpectedly forged", file=sys.stderr)
        return EXIT_DEFECT

    tmp_root = Path(args.tmp_root)

    if args.shared_corpus_dump:
        # Explicit comparison mode: the ambient (shared) identity, its own process.
        identity = Identity(gh, None, "shared-corpus-check")
        try:
            result = run_selection(repo, identity, args.inflight, tmp_root, args.pin)
        except InstrumentError as e:
            print(f"instrument defect: {e}", file=sys.stderr)
            return EXIT_DEFECT
        dump_avail(args.shared_corpus_dump, result["avail"])
        print(json.dumps({"dump": args.shared_corpus_dump, "shared_calls": identity.calls, "counts": result["counts"]}))
        return EXIT_OK

    try:
        token = forge_token(Path(forge), Path(args.key).expanduser(), args.app_id, args.installation_repo)
    except RuntimeError as e:
        print(f"APP UNAVAILABLE — refusing: {e}\nNo fallback to the shared account is permitted (refusal contract).",
              file=sys.stderr)
        return EXIT_APP_UNAVAILABLE
    identity = Identity(gh, token, "app")
    print(f"App token forged (process-local, {len(token)} chars, never displayed)", file=sys.stderr)

    if args.preflight:
        if not args.lane:
            print("instrument defect: --preflight needs a lane (pass --lane or set NBCODER_LANE)",
                  file=sys.stderr)
            return EXIT_DEFECT
        try:
            issues, paths = parse_preflight_arg(args.preflight)
        except ValueError as e:
            print(f"instrument defect: {e}", file=sys.stderr)
            return EXIT_DEFECT
        try:
            report = run_preflight(repo, identity, issues, args.lane, args.inflight, tmp_root,
                                   args.pin, require_free=args.require_free, paths=paths)
        except InstrumentError as e:
            # A failed Git read or gh call refuses: it never reads as FREE.
            print(f"instrument defect: {e}", file=sys.stderr)
            return EXIT_DEFECT
        print(json.dumps(report, ensure_ascii=False, indent=1))
        blocked = [n for n, v in report.items() if v["verdict"] != "FREE"]
        if args.require_free and blocked:
            print(f"PREFLIGHT REFUSED: {len(blocked)} issue(s) not FREE: {blocked}", file=sys.stderr)
            return EXIT_NOT_FREE
        return EXIT_OK

    evidence: dict = {"forged": True, "app_id": args.app_id, "pin": args.pin,
                      "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    try:
        if args.evidence:
            evidence["app_bucket_before"] = bucket(identity)

        result = run_selection(repo, identity, args.inflight, tmp_root, args.pin)

        if args.evidence:
            evidence["app_bucket_after"] = bucket(identity)
            evidence["app_calls"] = identity.calls
            before, after = evidence["app_bucket_before"], evidence["app_bucket_after"]
            evidence["app_core_consumed"] = before["core_remaining"] - after["core_remaining"]
            # The two bucket() probes are free; observed installation-bucket accounting
            # drifts a few units at 200+ calls, so the bound is a tolerance, not equality.
            FREE_PROBES, TOLERANCE = 2, 5
            evidence["proof_app_bucket_used"] = (
                evidence["app_core_consumed"] > 0
                and evidence["app_core_consumed"] >= evidence["app_calls"] - FREE_PROBES - TOLERANCE
            )
            # The installation bucket is shared by EVERY process forging this App.
            # Consumption beyond this run's own calls is another consumer, not noise:
            evidence["concurrent_consumption_on_installation"] = (
                evidence["app_core_consumed"] - (evidence["app_calls"] - FREE_PROBES)
            )

        if args.corpus_check:
            shared_dump = str(tmp_root / "avail-shared.json")
            cmd = [sys.executable, os.path.abspath(__file__), "--repo", str(repo),
                   "--shared-corpus-dump", shared_dump, "--pin", args.pin]
            for q in args.inflight:
                cmd += ["--inflight", q]
            cmd += ["--tmp-root", str(tmp_root)]
            r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
            if r.returncode != EXIT_OK:
                print(f"corpus-check subprocess failed: rc={r.returncode} (details suppressed)", file=sys.stderr)
                return EXIT_DEFECT
            shared_run = json.loads(r.stdout)
            shared_avail = json.loads(Path(shared_dump).read_text(encoding="utf-8"))["avail"]
            evidence["corpus"] = {
                "app_count": len(result["avail"]),
                "shared_count": len(shared_avail),
                "identical": sorted(result["avail"]) == sorted(shared_avail),
                "diff": sorted(set(result["avail"]) ^ set(shared_avail))[:20],
                "shared_calls_by_comparison_process": shared_run.get("shared_calls"),
            }
    except InstrumentError as e:
        print(f"instrument defect: {e}", file=sys.stderr)
        return EXIT_DEFECT

    if args.out:
        dump_avail(args.out, result["avail"])
        print(f"avail dumped to {args.out}", file=sys.stderr)

    if args.evidence:
        Path(args.evidence).write_text(json.dumps(evidence, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"evidence dumped to {args.evidence}", file=sys.stderr)

    refusal = proof_refusal(evidence)  # applied with or without --evidence
    if refusal:
        print(refusal, file=sys.stderr)
        return EXIT_DEFECT

    print(json.dumps(result["counts"]))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())