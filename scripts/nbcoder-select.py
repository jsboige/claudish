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

DEFAULT_APP_ID = "5751481"  # coursia-lane-po-2028
DEFAULT_PEM = "~/.secrets/github-apps/coursia-lane-po-2028.pem"
DEFAULT_PIN = "origin/main"


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
    items: list = []
    page = 1
    while True:
        chunk = json.loads(identity.gh(["api", f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}"]))
        if not chunk:
            return items
        items.extend(chunk)
        if len(chunk) < 100:
            return items
        page += 1


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

    inflight: set[str] = set()
    for q in inflight_queues:
        p = tmp_root / q / "grains.jsonl"
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue          # an in-flight blank line is not a defect
                g = json.loads(line)
                for k in ("notebook", "source_nb"):
                    if g.get(k):
                        inflight.add(norm(g[k]))

    blocked = taken_pr | taken_iss | inflight
    avail = [f for f in orphans if twin(f) not in blocked and f not in blocked]
    return {"avail": avail, "counts": {
        "py": len(py), "cs": len(cs), "orphans": len(orphans),
        "open_prs": len(prs), "taken_pr": len(taken_pr),
        "open_issues": len(iss), "taken_issue": len(taken_iss),
        "inflight": len(inflight), "available": len(avail),
    }}


def bucket(identity: Identity) -> dict:
    data = json.loads(identity.gh(["api", "rate_limit", "--jq", "{core: .resources.core, graphql: .resources.graphql}"]))
    return {"core_remaining": data["core"]["remaining"], "graphql_remaining": data["graphql"]["remaining"]}


def dump_avail(path: str, avail: list[str]) -> None:
    Path(path).write_text(
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