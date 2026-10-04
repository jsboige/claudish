#!/usr/bin/env python3
r"""G1 instrument (claudish #328) — share of merged CoursIA PRs linked to an issue.

H4's decisive measurement in the "juillet vs septembre" coordination inquiry:
the weekly "merged PRs per closed issue" ratio mixes two populations — PRs
that close an issue (closingIssuesReferences) and PRs that don't. Measured on
the G5 pivot weeks (2026-10-04, issue #328):

    13-19/07   1 013 merged PRs,    27 linked =  2.67%  (97% close NOTHING)
    14-20/09     571 merged PRs,    78 linked = 13.7 %  (86% close NOTHING)

So the ratio's collapse is driven by the issue side (backlog sweep, manual
closes), not by PRs having become issue-closers — the September grain mostly
still doesn't touch issues either.

⚠ GitHub's search caps at 1000 results per query: the July week needs the
built-in half-week split (each half < 1000) or the count silently reads 1000
with 13 PRs dropped. The split is what this script runs by default.

One paginated GraphQL search query per range, replayable, read-only:
    python scripts/coursia-pr-issue-linkage.py [--repo jsboige/CoursIA]
"""

import argparse
import json
import subprocess
import sys

QUERY = ("query($q: String!, $cursor: String) { search(type: ISSUE, query: $q, first: 100, "
         "after: $cursor) { issueCount pageInfo { endCursor hasNextPage } nodes { ... on "
         "PullRequest { number mergedAt closingIssuesReferences { totalCount } } } } }")

# (label, [merged: ranges]) — a week split into sub-ranges each under the
# 1000-result search cap; sub-ranges are summed, so the cap never bites.
DEFAULT_WEEKS = [
    ("2026-07-13..2026-07-19 (juillet)", ["2026-07-13..2026-07-16", "2026-07-17..2026-07-19"]),
    ("2026-09-14..2026-09-20 (septembre)", ["2026-09-14..2026-09-20"]),
]


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
    q = "repo:%s is:pr is:merged merged:%s" % (repo, merged_range)
    prs, cursor = [], None
    while True:
        s = gh_graphql(QUERY, {"q": q, "cursor": cursor})["search"]
        for n in s["nodes"]:
            prs.append({"number": n["number"], "mergedAt": n["mergedAt"],
                        "closing": n["closingIssuesReferences"]["totalCount"]})
        if not s["pageInfo"]["hasNextPage"]:
            if s["issueCount"] > len(prs):
                sys.stderr.write("CAP: %s reports issueCount=%d but search returned %d — "
                                 "split the range further\n" % (merged_range, s["issueCount"], len(prs)))
            return prs
        cursor = s["pageInfo"]["endCursor"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", default="jsboige/CoursIA")
    args = ap.parse_args()

    for label, subranges in DEFAULT_WEEKS:
        prs = [p for r in subranges for p in range_prs(args.repo, r)]
        linked = [p for p in prs if p["closing"] > 0]
        print("== %s — %d merged PRs" % (label, len(prs)))
        print("   linked to >=1 issue (closingIssuesReferences): %d (%.2f%%)"
              % (len(linked), 100.0 * len(linked) / max(1, len(prs))))
        print("   closing >1 issue: %d · closing nothing: %d (%.1f%%)"
              % (sum(1 for p in prs if p["closing"] > 1), len(prs) - len(linked),
                 100.0 * (len(prs) - len(linked)) / max(1, len(prs))))
        by_day = {}
        for p in prs:
            d = by_day.setdefault(p["mergedAt"][:10], [0, 0])
            d[0] += 1
            d[1] += 1 if p["closing"] else 0
        for day in sorted(by_day):
            tot, lk = by_day[day]
            print("   %s  %4d PRs  %4d linked (%3.0f%%)" % (day, tot, lk, 100.0 * lk / max(1, tot)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
