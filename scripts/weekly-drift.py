#!/usr/bin/env python3
"""Weekly drift series — responses by served model vs merged PRs (#445 D4).

The canonical instrument for the consumption-drift chantier: one table, replayed
every Monday, that keeps the two sides of "productivity per token" honest.

  numerator   daily hub capture archives (filenames only — the resp-* name
              carries the model that SERVED), counted per day, cached;
  denominator merged PRs per ISO week (Mon..Sun) via the GitHub search API's
              issueCount (NOT REST pagination: search counts are not capped at
              1 000 and deep `updated desc` windows never reach old months —
              the Grain-1 lesson of lean-audit-2026-10.md).

Scopes are whole owners, so the per-repo columns are subsets of the owner
column, never double counts. jsboige/CoursIA is broken out on purpose: it is
the fleet's largest PR source and the October audit omitted it, which made its
rep/PR level wrong by ~4x (corrected 2026-11-03, same day's edit of
lean-audit-2026-10.md Grain 1).

Bias to state with any published figure: hub captures only (a NOMINAL sidecar
writes none — the hub captures centrally); machine-tagged off-site archives are
excluded; a request counter can carry several resp-* files (cascade attempts);
responses are not tokens (prompt/response grew ~x1.17 over the window, #328 L2);
PRs are not units of value (CoursIA median PR size tripled July->Oct).

No provider-console figure ever enters this file — counts of our own captures
and public GitHub counts only (PR #784's R1 blocker).

Usage:
  python scripts/weekly-drift.py                    # census + PR table
  python scripts/weekly-drift.py --no-prs           # census side only
  python scripts/weekly-drift.py --refresh 7        # recount the last 7 days
  python scripts/weekly-drift.py --json out.json    # also dump the series
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import date, timedelta

import py7zr

RESP = re.compile(r"resp-(\d+)-r(\d+)-\d{4}-\d{2}-\d{2}T[\d-]+Z-"
                  r"(?:anthropic|gemini|ollama|responses|openai|native)-(.+)\.sse$")
REQ = re.compile(r"req-\d+-\d+-\d{4}-\d{2}-\d{2}T[\d-]+Z-(.+)\.json$")

# Whole owners (their repos are subsets); CoursIA broken out as the largest source.
PR_SCOPES = {
    "all": ["user:jsboige", "org:jsboigeEpita", "org:jsboigeEPF",
            "org:jsboigeECE", "org:ArgumentumGames"],
    "coursia": ["repo:jsboige/CoursIA"],
}

BUCKETS = ["payg-deepseek", "zai-glm", "minimax", "anthropic", "openai", "kimi",
           "local-vllm", "deepseek-other", "qwen", "mistral", "gemini", "other"]
PAYG_MODEL = "deepseek-flash"


def bucket(model: str) -> str:
    """Provider bucket for a served-model name (resp-* filename tail)."""
    m = model.lower()
    if m == PAYG_MODEL:
        return "payg-deepseek"
    if m.startswith("deepseek"):
        return "deepseek-other"
    if m.startswith("claude"):
        return "anthropic"
    if "gpt" in m or m.startswith(("o3", "o4", "openai")) or m == "mini" or m.endswith("-sol"):
        return "openai"
    if "glm" in m:
        return "zai-glm"
    if m.startswith("minimax"):
        return "minimax"
    if m.startswith(("k2", "k3", "kimi")):
        return "kimi"
    if m.startswith(("swift", "frognano", "qwen3.6")):
        return "local-vllm"
    if m.startswith("qwen"):
        return "qwen"
    if "mistral" in m or "devstral" in m or "codestral" in m:
        return "mistral"
    if m.startswith("gemini"):
        return "gemini"
    return "other"


def week_monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def census_day(archive_dirs: list[str], day: str) -> dict:
    """Count req/resp files and served models for one day, filenames only."""
    path = None
    for d in archive_dirs:
        p = os.path.join(d, f"captures-{day}.7z")
        if os.path.isfile(p):
            path = p
            break
    if path is None:
        return {"day": day, "archive": "", "req": 0, "resp": 0, "models": {}}
    req = resp = 0
    models: Counter = Counter()
    with py7zr.SevenZipFile(path) as z:
        for raw in z.getnames():
            base = os.path.basename(raw.strip())
            m = RESP.search(base)
            if m:
                resp += 1
                models[m.group(3)] += 1
                continue
            if REQ.search(base):
                req += 1
    return {"day": day, "archive": os.path.basename(path), "req": req,
            "resp": resp, "models": dict(models)}


def load_cache(cache_path: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if os.path.isfile(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    rec = json.loads(line)
                    out[rec["day"]] = rec
    return out


def build_census(archive_dirs: list[str], start: date, end: date,
                 cache_path: str, refresh_last: int) -> dict[str, dict]:
    cache = load_cache(cache_path)
    fresh_from = end - timedelta(days=refresh_last)
    d = start
    while d <= end:
        k = d.isoformat()
        if k not in cache or d >= fresh_from:
            try:
                cache[k] = census_day(archive_dirs, k)
            except Exception as e:  # a broken archive must not stop the series
                cache[k] = {"day": k, "archive": "", "req": 0, "resp": 0,
                            "models": {}, "error": repr(e)}
            with open(cache_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(cache[k]) + "\n")
        d += timedelta(days=1)
    return cache


def gh_search_counts(weeks: list[date]) -> dict[str, int]:
    """Merged-PR count per week per scope, via aliased GraphQL search (bulk only)."""
    aliases: list[tuple[str, str]] = []
    for wk in weeks:
        lo, hi = wk, wk + timedelta(days=6)
        for name, scopes in PR_SCOPES.items():
            q = " ".join(scopes) + f" is:pr is:merged merged:{lo.isoformat()}..{hi.isoformat()}"
            aliases.append((f"w{wk:%m%d}_{name}", q))
    res: dict[str, int] = {}
    for i in range(0, len(aliases), 15):  # small batches: GraphQL 504s on big fan-outs
        batch = aliases[i:i + 15]
        body = " ".join(f'{a}: search(query: "{q}", type: ISSUE, first: 0) {{ issueCount }}'
                        for a, q in batch)
        for attempt in range(4):
            out = subprocess.run(["gh", "api", "graphql", "-f", f"query={{ {body} }}"],
                                 capture_output=True, text=True, encoding="utf-8")
            if out.returncode == 0:
                data = json.loads(out.stdout)["data"]
                res.update({a: v["issueCount"] for a, v in data.items()})
                break
            time.sleep(5 * (attempt + 1))
        else:
            raise SystemExit(f"gh graphql failed after retries: {out.stderr[:200]}")
    return res


def aggregate(cache: dict[str, dict]) -> dict[str, dict]:
    """Per-week (Mon-start) day-averages; days with zero traffic never count."""
    weeks: dict[str, dict] = defaultdict(
        lambda: {"days": 0, "req": 0, "resp": 0, "b": Counter()})
    for k in sorted(cache):
        rec = cache[k]
        d = date.fromisoformat(k)
        w = weeks[week_monday(d).isoformat()]
        if rec.get("resp") or rec.get("req"):
            w["days"] += 1
        w["req"] += rec.get("req", 0)
        w["resp"] += rec.get("resp", 0)
        for mdl, n in rec.get("models", {}).items():
            w["b"][bucket(mdl)] += n
    return weeks


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--start", default="2026-06-03", help="first census day (ISO)")
    ap.add_argument("--end", default=date.today().isoformat(), help="last census day (ISO)")
    ap.add_argument("--arch", default=r"D:\claudish-captures\archive", help="local archive dir")
    ap.add_argument("--gdir", default=r"G:\Mon Drive\Backups-Cloud\claudish",
                    help="off-site archive dir (fallback)")
    ap.add_argument("--cache", default=os.path.expanduser(r"~\.claudish\drift-census.jsonl"))
    ap.add_argument("--refresh", type=int, default=0,
                    help="recount the last N days even if cached")
    ap.add_argument("--no-prs", action="store_true", help="skip the GitHub denominator")
    ap.add_argument("--json", help="dump the weekly series to this path")
    args = ap.parse_args(argv)

    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    cache = build_census([args.arch, args.gdir], start, end, args.cache, args.refresh)
    weeks = aggregate(cache)

    pr_counts: dict[str, int] = {}
    pr_weeks = [date.fromisoformat(w) for w in weeks
                if date.fromisoformat(w) >= week_monday(start)]
    if not args.no_prs and pr_weeks:
        raw = gh_search_counts(pr_weeks)
        for w in weeks:
            pr_counts[w] = raw.get(f"w{date.fromisoformat(w):%m%d}_all", 0)
            pr_counts[w + ":coursia"] = raw.get(f"w{date.fromisoformat(w):%m%d}_coursia", 0)

    print("week(Mon)   days    req/d   resp/d  " + "  ".join(f"{c[:9]:>9}" for c in BUCKETS)
          + "  %PAYG   PR/d  coursia  resp/PR")
    series = {}
    for wk in sorted(weeks):
        w = weeks[wk]
        n = max(w["days"], 1)
        row = "  ".join(f"{w['b'][c] / n:>9.0f}" for c in BUCKETS)
        payg = 100 * w["b"]["payg-deepseek"] / max(w["resp"], 1)
        prd = pr_counts.get(wk, 0) / 7 if wk in pr_counts else None
        cs = pr_counts.get(wk + ":coursia", 0) / 7 if wk in pr_counts else None
        ratio = f"{w['resp'] / n / prd:7.0f}" if prd else "      -"
        cs_s = f"{cs:7.0f}" if cs is not None else "      -"
        prd_s = f"{prd:5.0f}" if prd is not None else "    -"
        print(f"{wk}  {w['days']:>4} {w['req'] / n:>8.0f} {w['resp'] / n:>8.0f}  {row}"
              f"  {payg:5.1f} {prd_s} {cs_s} {ratio}")
        series[wk] = {"days": w["days"], "req_per_day": w["req"] / n,
                      "resp_per_day": w["resp"] / n,
                      "buckets": {c: w["b"][c] / n for c in BUCKETS},
                      "payg_share": payg,
                      "pr_per_day": prd, "coursia_pr_per_day": cs,
                      "resp_per_pr": (w["resp"] / n / prd) if prd else None}
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(series, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
