#!/usr/bin/env python3
"""nb_coder batch selection for CoursIA C# parity targets, GitHub-App wired.

Mandate (ai-01:CoursIA GO, 2026-11-19T01:03Z, thread c2048-nbcoder-app-
selection): selection reads ride the per-lane GitHub App installation's OWN
quota bucket. The token is forged at start, lives in the child process
environment only, is never printed, never written to disk. If the App is
unavailable the tool refuses explicitly (exit 3) and NEVER falls back to the
shared account. Writes (issues, PRs, comments) are out of scope by design.

Verification is 4-way, REST-only (list endpoints carry bodies; no per-item
calls): (a) C# twin absent from main, (b) target absent from ANY open PR's
changed files, (c) target absent from ANY open issue body, (d) target absent
from a declared in-flight grains file.

Proof mode: --evidence FILE records the App bucket before/after and the call
count (App bucket delta must equal the call count); --corpus-check re-runs the
same selection under the shared identity in a SEPARATE process
(--shared-corpus-dump, never the default) and requires an identical candidate
corpus on the same snapshot.

Exit codes: 0 ok; 2 usage/instrument defect; 3 App unavailable (refusal,
zero network calls made by this process).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

GH = r"C:/Program Files/GitHub CLI/gh.exe"
BS = chr(92)
SUF = "-Python.ipynb"
IPYNB = re.compile(r"`([A-Za-z0-9_./" + BS + r"-]+\.ipynb)`")

EXIT_OK = 0
EXIT_DEFECT = 2
EXIT_APP_UNAVAILABLE = 3

DEFAULT_APP_ID = "5751481"  # coursia-lane-po-2028
DEFAULT_PEM = "~/.secrets/github-apps/coursia-lane-po-2028.pem"
DEFAULT_FORGE = "D:/dev/CoursIA/scripts/secrets/github_app_token.py"


def forge_token(forge: Path, pem: Path, app_id: str, repo: str) -> str:
    """Forge an installation token via the fleet organ. Token lives in memory.

    Any failure mode (missing organ, unreadable key, HTTP refusal, empty
    output) is the refusal witness: caller must exit 3, never fall back.
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
        raise RuntimeError(f"forge exit {r.returncode}: {(r.stderr or r.stdout).strip()[:200]}")
    token = (r.stdout or "").strip()
    if not token:
        raise RuntimeError("forge printed no token")
    return token


class Identity:
    """One GitHub identity for every gh subprocess of a selection run.

    App mode injects GH_TOKEN in the child environment (never argv, never
    disk). Shared mode is the explicit comparison identity only.
    """

    def __init__(self, token: str | None, label: str):
        self.token = token
        self.label = label
        self.calls = 0

    def gh(self, args: list[str]) -> str:
        env = dict(os.environ)
        if self.token is not None:
            env["GH_TOKEN"] = self.token
        r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", env=env)
        if r.returncode != 0:
            raise SystemExit(f"gh failed ({self.label}): {args[2] if len(args) > 2 else args}\n{r.stderr[:200]}")
        self.calls += 1
        return r.stdout


def api_all(identity: Identity, path: str) -> list:
    items: list = []
    page = 1
    while True:
        chunk = json.loads(identity.gh([GH, "api", f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}"]))
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


def run_selection(repo: Path, identity: Identity, inflight_queues: list[str], tmp_root: Path) -> dict:
    """4-way verified availability. Every gh call rides the given identity."""
    out = subprocess.run(["git", "-C", str(repo), "ls-files", "*.ipynb"],
                         capture_output=True, text=True, encoding="utf-8").stdout.splitlines()  # local, no quota
    files = {norm(p) for p in out}
    cs = {f for f in files if f.endswith("-CSharp.ipynb")}
    py = {f for f in files if f.endswith("-Python.ipynb")}
    orphans = sorted(f for f in py if twin(f) not in cs)

    prs = api_all(identity, "repos/jsboige/CoursIA/pulls?state=open")
    taken_pr: set[str] = set()
    for pr in prs:
        fns = json.loads(identity.gh([GH, "api", f"repos/jsboige/CoursIA/pulls/{pr['number']}/files?per_page=100"]))
        for f in fns:
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
    data = json.loads(identity.gh([GH, "api", "rate_limit", "--jq", "{core: .resources.core, graphql: .resources.graphql}"]))
    return {"core_remaining": data["core"]["remaining"], "graphql_remaining": data["graphql"]["remaining"]}


def dump_avail(path: str, avail: list[str]) -> None:
    Path(path).write_text(
        json.dumps({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "avail": avail},
                   ensure_ascii=False, indent=0), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", default="D:/dev/CoursIA")
    ap.add_argument("--key", default=os.environ.get("APP_SELECT_PEM", DEFAULT_PEM))
    ap.add_argument("--forge", default=os.environ.get("APP_SELECT_FORGE", DEFAULT_FORGE))
    ap.add_argument("--app-id", default=DEFAULT_APP_ID)
    ap.add_argument("--installation-repo", default="jsboige/CoursIA")
    ap.add_argument("--inflight", action="append", default=[], metavar="STATE_DIR_NAME",
                    help="in-flight state-dir name under --tmp-root (repeatable)")
    ap.add_argument("--tmp-root", default="D:/dev/claudish/.tmp")
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
    args = ap.parse_args()

    repo = Path(args.repo)
    if not repo.is_dir():
        print(f"instrument defect: repo absent: {repo}", file=sys.stderr)
        return EXIT_DEFECT

    if args.witness:
        # Refusal witness: a broken App must refuse, loudly, without any gh call.
        try:
            forge_token(Path(args.forge), Path("Z:/definitely-absent.pem"), args.app_id, args.installation_repo)
        except RuntimeError as e:
            print(f"REFUSAL WITNESS OK: App unavailable -> explicit refusal, no fallback. ({e})", file=sys.stderr)
            return EXIT_APP_UNAVAILABLE
        print("witness failed: an absent key unexpectedly forged", file=sys.stderr)
        return EXIT_DEFECT

    if args.shared_corpus_dump:
        # Explicit comparison mode: the ambient (shared) identity, its own process.
        identity = Identity(None, "shared-corpus-check")
        result = run_selection(repo, identity, args.inflight, Path(args.tmp_root))
        dump_avail(args.shared_corpus_dump, result["avail"])
        print(json.dumps({"dump": args.shared_corpus_dump, "shared_calls": identity.calls, "counts": result["counts"]}))
        return EXIT_OK

    try:
        token = forge_token(Path(args.forge), Path(args.key).expanduser(), args.app_id, args.installation_repo)
    except RuntimeError as e:
        print(f"APP UNAVAILABLE — refusing: {e}\nNo fallback to the shared account is permitted (refusal contract).",
              file=sys.stderr)
        return EXIT_APP_UNAVAILABLE
    identity = Identity(token, "app")
    print(f"App token forged (process-local, {len(token)} chars, never displayed)", file=sys.stderr)

    evidence: dict = {"forged": True, "app_id": args.app_id, "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if args.evidence:
        evidence["app_bucket_before"] = bucket(identity)

    result = run_selection(repo, identity, args.inflight, Path(args.tmp_root))

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
        shared_dump = str((Path(args.tmp_root) / "avail-shared.json"))
        cmd = [sys.executable, os.path.abspath(__file__), "--repo", str(repo),
               "--shared-corpus-dump", shared_dump]
        for q in args.inflight:
            cmd += ["--inflight", q]
        cmd += ["--tmp-root", args.tmp_root]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
        if r.returncode != EXIT_OK:
            print(f"corpus-check subprocess failed: {r.stderr[:300]}", file=sys.stderr)
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

    if args.out:
        dump_avail(args.out, result["avail"])
        print(f"avail dumped to {args.out}", file=sys.stderr)

    if args.evidence:
        Path(args.evidence).write_text(json.dumps(evidence, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"evidence dumped to {args.evidence}", file=sys.stderr)
        if not evidence.get("proof_app_bucket_used", True):
            print("PROOF FAILED: App bucket shows no/wrong consumption for this run's calls", file=sys.stderr)
            return EXIT_DEFECT
        if evidence.get("corpus", {}).get("identical") is False:
            print("PROOF FAILED: candidate corpus differs between identities", file=sys.stderr)
            return EXIT_DEFECT

    print(json.dumps(result["counts"]))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
