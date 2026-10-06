#!/usr/bin/env python3
r"""G1 instrument (claudish #328) — how merged CoursIA PRs relate to issues.

TWO instruments, and every cited number is VERIFIED as an issue or a PR
before it counts (re-review, 2026-10-05 — the loose `#\d+` count of the
first revision counted PR references as issue citations: on 19/07 it read
142 citing-PRs where only 111 cite a verified issue, flattening the very
gap the inquiry measures):

  1. CLOSURE LINKAGE — `closingIssuesReferences`: the issues GitHub will
     close on merge. Populated by closing keywords AND by manually linked
     issues in the sidebar, so "keyword linkage" would understate it.
     This is what feeds H4's weekly "PRs per closed issue" ratio.
  2. VERIFIED-ISSUE CITATION — the PR cites `#N` (title or body) and that
     number resolves to an ISSUE via `issueOrPullRequest`. Reported per
     form: title-scope (CoursIA convention: `fix(prover,#6790)` — the
     convention FORBIDS closing keywords, so the issue stays open until
     its criteria are met) and body `See #N`. Also reports **PRs per
     title-cited issue** (mean + median) — the granularity axis H4 names.

Measured ground (2026-10-04/05, G5 pivot weeks + G6 day):

    13-19/07   1 013 merged PRs · closure linkage  27 =  2.7%
    14-20/09     571 merged PRs · closure linkage  78 = 13.7%
    (verified-citation shares: recomputed by this revision — see output)

⚠ RETRACTED readings (kept so they are not remade): (a) the first draft's
"the September grain mostly doesn't touch issues / issue quasi decorative"
(read one instrument as the other); (b) the first revision's "H4's ratio
collapse is a change of close mechanism" — a title-scope closes nothing on
GitHub and this script measures no closing mechanism. H4 is about grain
size; the citation and closure shares are its inputs, not its conclusion.

⚠ GitHub's search caps at 1000 results/query: the July week needs the
built-in half-week split or the count silently reads 1000 with 13 PRs
dropped. A cap hit prints CAP on stderr and exits 1. The cap check runs
AFTER dedup (issueCount vs distinct PRs).

Read-only, replayable:
    python scripts/coursia-pr-issue-linkage.py                 # default weeks
    python scripts/coursia-pr-issue-linkage.py --week 2026-09-28..2026-09-28
Exit codes: 0 = measured · 1 = search cap hit (split the range) · 2 = query
error (bad repo/date, gh failure) — distinct from the cap on purpose.
"""

import argparse
import json
import re
import subprocess
import sys
from datetime import date, timedelta

PR_QUERY = ("query($q: String!, $cursor: String) { search(type: ISSUE, query: $q, first: 100, "
            "after: $cursor) { issueCount pageInfo { endCursor hasNextPage } nodes { ... on "
            "PullRequest { number mergedAt title body closingIssuesReferences { totalCount } } } } }")

# (label, [merged: ranges]) — a week split into sub-ranges each under the
# 1000-result search cap; sub-ranges are summed and deduped by PR number.
DEFAULT_WEEKS = [
    ("2026-07-13..2026-07-19 (juillet)", ["2026-07-13..2026-07-16", "2026-07-17..2026-07-19"]),
    ("2026-09-14..2026-09-20 (septembre)", ["2026-09-14..2026-09-20"]),
]

ANY_NUM = re.compile(r"#(\d+)")
SEE_NUM = re.compile(r"\bsee\s+#(\d+)", re.I)


# ---------------------------------------------------------------------------
# pure extraction — tested without network
# ---------------------------------------------------------------------------

def cited_numbers(title, body):
    """((title_nums, see_nums, other_body_nums)) — sets, deduped.

    Title numbers are the CoursIA title-scope convention (`fix(prover,#6790)`);
    `See #N` in the body is the explicit pointer; everything else (mentions,
    cross-PR references) is kept apart so it can never pass for a title scope.
    """
    t = set(ANY_NUM.findall(title or ""))
    b = body or ""
    see = set(SEE_NUM.findall(b))
    other = set(ANY_NUM.findall(b)) - see
    return t, see, other


def week_metrics(prs, types):
    """All weekly numbers from PR dicts + {number: 'Issue'|'PullRequest'|None}."""
    n = len(prs)
    closing = sum(1 for p in prs if p["closing"] > 0)
    title_issue_prs = see_issue_prs = any_issue_prs = 0
    per_issue = {}
    num_split = {"Issue": set(), "PullRequest": set(), None: set()}
    for p in prs:
        buckets = [("title", p["title_nums"]), ("see", p["see_nums"]), ("other", p["other_nums"])]
        hit_title = hit_see = hit_any = False
        for name, nums in buckets:
            for num in nums:
                num_split.setdefault(types.get(int(num)), set()).add(int(num))
                if types.get(int(num)) == "Issue":
                    hit_any = True
                    if name == "title":
                        hit_title = True
                        per_issue.setdefault(int(num), set()).add(p["number"])
                    elif name == "see":
                        hit_see = True
        title_issue_prs += hit_title
        see_issue_prs += hit_see
        any_issue_prs += hit_any
    counts = sorted((len(v) for v in per_issue.values()), reverse=True) or [0]
    counts_sum = sum(counts)
    mean = counts_sum / len(counts) if per_issue else 0.0
    median = counts[len(counts) // 2] if len(counts) % 2 else (counts[len(counts) // 2 - 1] + counts[len(counts) // 2]) / 2.0
    return {
        "n": n, "closing": closing,
        "title_issue_prs": title_issue_prs, "see_issue_prs": see_issue_prs,
        "any_issue_prs": any_issue_prs,
        "title_issues_cited": len(per_issue),
        "pr_per_issue_mean": mean, "pr_per_issue_median": median,
        "pr_per_issue_max": counts[0],
        "cited_issues": len(num_split.get("Issue", ())),
        "cited_pr_numbers": len(num_split.get("PullRequest", ())),
        "cited_unresolved": len(num_split.get(None, ())),
    }


# ---------------------------------------------------------------------------
# network
# ---------------------------------------------------------------------------

def gh_graphql(query, variables, allow_partial=False):
    """Returns data — or (data, errors) when allow_partial=True.

    A corpus cites garbage numbers (`#0`, `#5004826337` lifted from prose):
    per-alias resolution failures ride HTTP 200 and must mark that ONE
    number unresolved, not kill the batch (measured 2026-10-05: 3 garbage
    numbers aborted the whole 80-alias query).
    """
    args = ["gh", "api", "graphql", "-f", "query=" + query]
    for k, v in variables.items():
        if v is None:
            continue
        args += ["-f", "%s=%s" % (k, v)]
    out = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
    payload = None
    if out.returncode != 0 and not allow_partial:
        raise RuntimeError("gh failure: %s" % out.stderr[:300])
    if out.stdout.strip():
        try:
            payload = json.loads(out.stdout)
        except ValueError:
            pass
    if payload is None:
        raise RuntimeError("gh failure (no parsable body): %s" % out.stderr[:300])
    errs = payload.get("errors") or []
    data = payload.get("data") or {}
    if errs and not allow_partial:
        # GraphQL errors ride HTTP 200 (unknown repo → data.repository null,
        # rc 0): an invalid query is an ERROR (exit 2), never a silent empty.
        raise RuntimeError("graphql: %s" % errs[0].get("message", errs[0])[:200])
    if not allow_partial and query.lstrip().startswith("query { repository") \
            and data.get("repository") is None:
        raise RuntimeError("repository not found (check --repo)")
    return (data, errs) if allow_partial else data


def range_prs(repo, merged_range, fetch=None):
    """Merged PRs of one range; sets `cap` when the search cap bit."""
    fetch = fetch or gh_graphql
    q = "repo:%s is:pr is:merged merged:%s" % (repo, merged_range)
    prs, cursor, cap = [], None, False
    while True:
        s = fetch(PR_QUERY, {"q": q, "cursor": cursor})["search"]
        for x in s["nodes"]:
            t, see, other = cited_numbers(x.get("title"), x.get("body"))
            prs.append({"number": x["number"], "mergedAt": x["mergedAt"],
                        "closing": x["closingIssuesReferences"]["totalCount"],
                        "title_nums": t, "see_nums": see, "other_nums": other})
        if not s["pageInfo"]["hasNextPage"]:
            if s["issueCount"] > len(prs):
                sys.stderr.write("CAP: %s reports issueCount=%d but search returned %d — "
                                 "split the range further\n" % (merged_range, s["issueCount"], len(prs)))
                cap = True
            return prs, cap
        cursor = s["pageInfo"]["endCursor"]


def week_prs(repo, subranges, fetch=None):
    """Sub-ranges summed, deduped by PR number; cap checked AFTER dedup."""
    prs, seen, cap = [], set(), False
    reported = 0
    for r in subranges:
        part, c = range_prs(repo, r, fetch)
        cap = cap or c
        reported += len(part)
        for p in part:
            if p["number"] not in seen:
                seen.add(p["number"])
                prs.append(p)
    if reported > len(prs) + 1:  # boundary duplicates are expected, mass loss is a cap smell
        sys.stderr.write("CAP?: %d fetched, %d distinct after dedup\n" % (reported, len(prs)))
        cap = True
    return prs, cap


def resolve_types(repo, numbers, cache, fetch=None, batch=80):
    """{number: 'Issue'|'PullRequest'|None} via aliased issueOrPullRequest.

    One query per batch of 80 (370 numbers = 5 queries on a 5k/h budget).
    Aliased fields are the only GraphQL batching available for numbers —
    nodes() needs global ids we do not have.
    """
    fetch = fetch or gh_graphql
    owner, _, name = repo.partition("/")
    todo = sorted({int(n) for n in numbers if int(n) not in cache})
    for i in range(0, len(todo), batch):
        chunk = todo[i:i + batch]
        aliases = " ".join(
            "n%d: issueOrPullRequest(number: %d) { __typename }" % (x, x) for x in chunk)
        q = 'query { repository(owner:"%s", name:"%s") { %s } }' % (owner, name, aliases)
        res = fetch(q, {}, allow_partial=True) if fetch is gh_graphql else fetch(q, {})
        # test fakes return a bare dict; the real path returns (data, errors)
        data, errs = res if isinstance(res, tuple) else (res, [])
        rnode = (data or {}).get("repository") or {}
        failed = set()
        for e in errs:  # per-alias "Could not resolve" → that number is None
            path = e.get("path") or []
            if len(path) > 1 and isinstance(path[1], str) and path[1].startswith("n"):
                try:
                    failed.add(int(path[1][1:]))
                except ValueError:
                    pass
        for x in chunk:
            node = rnode.get("n%d" % x)
            cache[x] = node["__typename"] if node else None
            if x in failed:
                cache[x] = None  # garbage number: unresolved, not an error
    return {int(n): cache[int(n)] for n in numbers}


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------

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


def valid_ranges(weeks):
    for label, subranges in weeks:
        for r in subranges:
            a, _, b = r.partition("..")
            try:
                d0, d1 = date.fromisoformat(a), date.fromisoformat(b)
            except ValueError:
                raise SystemExitError("invalid date in range %r (%s)" % (label, r))
            if d0 > d1:
                raise SystemExitError("range %r ends before it starts" % r)


class SystemExitError(Exception):
    pass


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", default="jsboige/CoursIA")
    ap.add_argument("--week", action="append", default=None, metavar="FROM..TO",
                    help="UTC merged range (repeatable) — replaces the default weeks, e.g. "
                         "--week 2026-09-28..2026-09-28 for a single G6 day")
    args = ap.parse_args()

    weeks = [(w, [w]) for w in args.week] if args.week else DEFAULT_WEEKS
    try:
        valid_ranges(weeks)
    except SystemExitError as e:
        sys.stderr.write("ERROR: %s\n" % e)
        return 2

    cache, any_cap, any_err = {}, False, False
    for label, subranges in weeks:
        try:
            prs, cap = week_prs(args.repo, subranges)
        except RuntimeError as e:
            sys.stderr.write("ERROR on %s: %s\n" % (label, e))
            any_err = True
            continue
        any_cap = any_cap or cap
        numbers = set()
        for p in prs:
            numbers |= p["title_nums"] | p["see_nums"] | p["other_nums"]
        try:
            types = resolve_types(args.repo, numbers, cache)
        except RuntimeError as e:
            sys.stderr.write("ERROR resolving types for %s: %s\n" % (label, e))
            any_err = True
            continue
        m = week_metrics(prs, types)
        n = m["n"]
        print("== %s — %d merged PRs" % (label, n))
        print("   closure linkage (closingIssuesReferences, keyword OR sidebar link): %d (%.2f%%)"
              % (m["closing"], 100.0 * m["closing"] / max(1, n)))
        print("   cites >=1 VERIFIED issue (title or body):               %d (%.2f%%)"
              % (m["any_issue_prs"], 100.0 * m["any_issue_prs"] / max(1, n)))
        print("     ├─ title-scope citation (%s-style):                    %d (%.2f%%)"
              % ("fix(x,#N)", m["title_issue_prs"], 100.0 * m["title_issue_prs"] / max(1, n)))
        print("     └─ body 'See #N':                                      %d (%.2f%%)"
              % (m["see_issue_prs"], 100.0 * m["see_issue_prs"] / max(1, n)))
        print("   cited numbers resolved: %d issues · %d PR numbers · %d unresolved"
              % (m["cited_issues"], m["cited_pr_numbers"], m["cited_unresolved"]))
        print("   PRs per TITLE-cited issue: mean %.2f · median %.1f · max %d (over %d issues)"
              % (m["pr_per_issue_mean"], m["pr_per_issue_median"], m["pr_per_issue_max"],
                 m["title_issues_cited"]))
        by_day = {}
        for p in prs:
            d = by_day.setdefault(p["mergedAt"][:10], [0, 0])
            d[0] += 1
            d[1] += 1 if p["closing"] else 0
        for day in sorted(fill_days(by_day, subranges)):
            tot, lk = by_day.get(day, (0, 0))
            print("   %s  %4d PRs  %4d closure-linked (%3.0f%%)"
                  % (day, tot, lk, 100.0 * lk / max(1, tot)))
    if any_err:
        return 2
    return 1 if any_cap else 0


if __name__ == "__main__":
    sys.exit(main())
