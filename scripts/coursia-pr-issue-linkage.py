#!/usr/bin/env python3
r"""G1 instrument (claudish #328) — how merged CoursIA PRs relate to issues.

TWO instruments, because reading one as the other produced a refuted
conclusion (PR #337 review, 2026-10-05):

  1. CLOSURE-KEYWORD LINKAGE — `closingIssuesReferences`, i.e. GitHub's
     automatic close: a `Closes #N`/`Fixes #N` keyword in the PR body.
     This is what populates the "merged PRs per closed issue" ratio of H4.
  2. BY-REFERENCE CITATION — the PR cites `#N` ANYWHERE (title or body).
     CoursIA's convention is title-scope (`fix(prover,#6790)`) + a `See #N`
     line: it FORBIDS closing keywords (an auto-close would end the issue
     before its acceptance criteria are met) but cites the issue everywhere.

Measured ground (2026-10-04/05, G5 pivot weeks + coordinator by-reference):

    13-19/07   1 013 merged PRs · closure-keyword   27 =  2.7%
                          by-reference (coordinator)   = 90.1%
    14-20/09     571 merged PRs · closure-keyword   78 = 13.7%
                          by-reference (coordinator)   = 98.2%

⚠ RETRACTED reading (kept here so it is not remade): the first draft
concluded from instrument 1 alone that "the September grain mostly doesn't
touch issues / the issue is quasi decorative". Instrument 2 refutes it —
September PRs cite issues nearly always; they close them manually or by
title-scope, not by keyword. H4's ratio collapse is a CHANGE OF CLOSE
MECHANISM, not of issue-touching.

⚠ GitHub's search caps at 1000 results per query: the July week needs the
built-in half-week split (each half < 1000) or the count silently reads 1000
with 13 PRs dropped. A cap hit prints CAP on stderr and exits 1.

Read-only, replayable:
    python scripts/coursia-pr-issue-linkage.py                 # default weeks
    python scripts/coursia-pr-issue-linkage.py --week 2026-09-28..2026-09-28
                                                               # G6: a single day (UTC)
Exit codes: 0 = measured · 1 = search cap hit (split the range).
"""

import argparse
import json
import re
import subprocess
import sys
from datetime import date, timedelta

QUERY = ("query($q: String!, $cursor: String) { search(type: ISSUE, query: $q, first: 100, "
         "after: $cursor) { issueCount pageInfo { endCursor hasNextPage } nodes { ... on "
         "PullRequest { number mergedAt title body closingIssuesReferences { totalCount } } } } }")

# (label, [merged: ranges]) — a week split into sub-ranges each under the
# 1000-result search cap; sub-ranges are summed and deduped by PR number.
DEFAULT_WEEKS = [
    ("2026-07-13..2026-07-19 (juillet)", ["2026-07-13..2026-07-16", "2026-07-17..2026-07-19"]),
    ("2026-09-14..2026-09-20 (septembre)", ["2026-09-14..2026-09-20"]),
]

# `#123` in title or body. Deliberately loose (a `#` followed by digits):
# markdown headers carry a space, and CoursIA's title-scope form is
# `fix(prover,#6790)` — no space. This is a CITATION probe, not a parser.
REF_RE = re.compile(r"#\d+")


def gh_graphql(query, variables):
    args = ["gh", "api", "graphql", "-f", "query=" + query]
    for k, v in variables.items():
        if v is None:
            continue
        args += ["-f", "%s=%s" % (k, v)]
    out = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        raise RuntimeError(out.stderr[:500])
    return json.loads(out.stdout)["data"]


def range_prs(repo, merged_range):
    """Merged PRs of one range; sets `cap` when the search cap bit."""
    q = "repo:%s is:pr is:merged merged:%s" % (repo, merged_range)
    prs, cursor, cap = [], None, False
    while True:
        s = gh_graphql(QUERY, {"q": q, "cursor": cursor})["search"]
        for n in s["nodes"]:
            body = n.get("body") or ""
            title = n.get("title") or ""
            prs.append({"number": n["number"], "mergedAt": n["mergedAt"],
                        "closing": n["closingIssuesReferences"]["totalCount"],
                        "cites": 1 if (REF_RE.search(title) or REF_RE.search(body)) else 0})
        if not s["pageInfo"]["hasNextPage"]:
            if s["issueCount"] > len(prs):
                sys.stderr.write("CAP: %s reports issueCount=%d but search returned %d — "
                                 "split the range further\n" % (merged_range, s["issueCount"], len(prs)))
                cap = True
            return prs, cap
        cursor = s["pageInfo"]["endCursor"]


def week_prs(repo, subranges):
    """Sub-ranges summed, deduped by PR number (boundary-overlap guard)."""
    prs, seen, cap = [], set(), False
    for r in subranges:
        part, c = range_prs(repo, r)
        cap = cap or c
        for p in part:
            if p["number"] not in seen:
                seen.add(p["number"])
                prs.append(p)
    return prs, cap


def fill_days(by_day, subranges):
    """Every UTC day of every sub-range appears, at zero if no PR merged —
    'no PRs that day' and 'no data that day' must not render the same."""
    days = set(by_day)
    for r in subranges:
        a, _, b = r.partition("..")
        try:
            d0, d1 = date.fromisoformat(a), date.fromisoformat(b)
        except ValueError:
            continue
        while d0 <= d1:
            days.add(d0.isoformat())
            d0 += timedelta(days=1)
    return days


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", default="jsboige/CoursIA")
    ap.add_argument("--week", action="append", default=None, metavar="FROM..TO",
                    help="UTC merged range (repeatable) — replaces the default weeks, e.g. "
                         "--week 2026-09-28..2026-09-28 for a single G6 day")
    args = ap.parse_args()

    weeks = [(w, [w]) for w in args.week] if args.week else DEFAULT_WEEKS
    any_cap = False
    for label, subranges in weeks:
        prs, cap = week_prs(args.repo, subranges)
        any_cap = any_cap or cap
        n = len(prs)
        kw = sum(1 for p in prs if p["closing"] > 0)
        ref = sum(1 for p in prs if p["cites"])
        print("== %s — %d merged PRs" % (label, n))
        print("   closure-keyword linkage (closingIssuesReferences): %d (%.2f%%)"
              % (kw, 100.0 * kw / max(1, n)))
        print("   cites >=1 #N anywhere (title/body):                %d (%.2f%%)"
              % (ref, 100.0 * ref / max(1, n)))
        print("   closing >1 issue: %d · closing nothing: %d (%.1f%%)"
              % (sum(1 for p in prs if p["closing"] > 1), n - kw, 100.0 * (n - kw) / max(1, n)))
        by_day = {}
        for p in prs:
            d = by_day.setdefault(p["mergedAt"][:10], [0, 0, 0])
            d[0] += 1
            d[1] += 1 if p["closing"] else 0
            d[2] += p["cites"]
        for day in sorted(fill_days(by_day, subranges)):
            tot, lk, rf = by_day.get(day, (0, 0, 0))
            print("   %s  %4d PRs  %4d keyword (%3.0f%%)  %4d citing (%3.0f%%)"
                  % (day, tot, lk, 100.0 * lk / max(1, tot), rf, 100.0 * rf / max(1, tot)))
    return 1 if any_cap else 0


if __name__ == "__main__":
    sys.exit(main())
