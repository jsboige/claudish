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

G8 DAILY MODE (claudish #328 G8, 2026-10-06): `--daily FROM..TO` renders one
row per UTC day per WORKSPACE, ventilated by the `lane <machine>:<workspace>`
provenance marker in the PR body (CoursIA's own convention — never mixed, the
coordinator's explicit ask) plus an UNATTRIBUTED bucket. Per row: merged PRs,
median creation→merge delay, commits/PR, CI check-suites/PR (the two allers-
retours proxies), verified-issue citation share, PRs per title-cited issue.
Also one line per day of issues closed split organic vs balayage (bulk
sweep = any minute holding >= 8 closures — a self-contained proxy for G5's
lot filter, stated here because their exact filter is theirs). The series
discriminates: a débit break at 14-20/08 without a per-PR cost jump points
at gesture ORDER (tirage first); a per-PR cost jump at 10/08 or ~18/08
points at the GATES (lane-claim required, `Grain:` required). Both may be
true — the series says in what proportions.

⚠ GitHub's search caps at 1000 results/query: the July week needs the
built-in half-week split or the count silently reads 1000 with 13 PRs
dropped. A cap hit prints CAP on stderr and exits 1. The cap check runs
AFTER dedup (issueCount vs distinct PRs).

Read-only, replayable:
    python scripts/coursia-pr-issue-linkage.py                 # default weeks
    python scripts/coursia-pr-issue-linkage.py --week 2026-09-28..2026-09-28
    python scripts/coursia-pr-issue-linkage.py --daily 2026-08-01..2026-08-31   # G8 series
Exit codes: 0 = measured · 1 = search cap hit (split the range) · 2 = query
error (bad repo/date, gh failure) — distinct from the cap on purpose.
"""

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from datetime import date, datetime, timedelta

PR_QUERY = ("query($q: String!, $cursor: String) { search(type: ISSUE, query: $q, first: 100, "
            "after: $cursor) { issueCount pageInfo { endCursor hasNextPage } nodes { ... on "
            "PullRequest { number mergedAt title body closingIssuesReferences { totalCount } } } } }")

# G8: cost fields + the lane provenance marker live on the same search — one
# pass per day instead of week+PR-per-PR REST (August alone holds 3 287 merged
# PRs; REST per PR would burn the hourly budget before the month is read).
DAILY_PR_QUERY = ("query($q: String!, $cursor: String) { search(type: ISSUE, query: $q, first: 100, "
                  "after: $cursor) { issueCount pageInfo { endCursor hasNextPage } nodes { ... on "
                  "PullRequest { number createdAt mergedAt title body "
                  "commits(last: 100) { totalCount nodes { commit { checkSuites { totalCount } } } } "
                  "closingIssuesReferences { totalCount } } } } }")

ISSUE_QUERY = ("query($q: String!, $cursor: String) { search(type: ISSUE, query: $q, first: 100, "
               "after: $cursor) { issueCount pageInfo { endCursor hasNextPage } nodes { ... on "
               "Issue { number closedAt stateReason } } } }")

LANE_RE = re.compile(r"\blane\s+([A-Za-z0-9][A-Za-z0-9_.-]*):([A-Za-z0-9][A-Za-z0-9_.-]*)")
# A minute holding this many closures is a bulk sweep, not per-grain organic
# closing — a human closing by hand never lands 8 in 60 s.
SWEEP_MIN_CLOSURES = 8

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
# G8 daily mode — lane ventilation, per-PR cost proxies, sweep split
# ---------------------------------------------------------------------------

def lane_of(body):
    """(machine, workspace) from the `lane <machine>:<workspace>` provenance
    marker — the fleet's own convention, e.g. `Grain: MED/docs — lane
    myia-po-2024:CoursIA-2 — prev: …`. None when the body carries none
    (pre-marker convention: those PRs are UNATTRIBUTED, never guessed)."""
    m = LANE_RE.search(body or "")
    return (m.group(1), m.group(2)) if m else None


def _median(values):
    v = sorted(values)
    return v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2.0


def merge_delay_hours(created_at, merged_at):
    """Creation→merge in hours, or None when either stamp is unusable —
    a missing delay never enters the median."""
    def parse(s):
        return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None
    try:
        a, b = parse(created_at), parse(merged_at)
        if a is None or b is None:
            return None
        return (b - a).total_seconds() / 3600.0
    except ValueError:
        return None


def ci_suites_of(pr):
    """Check suites summed across the PR's commits — the CI-runs proxy.
    The commits list is capped at 100 by the query; a >100-commit PR
    undercounts suites (commits totalCount stays exact)."""
    commits = pr.get("commits") or {}
    total = 0
    for c in commits.get("nodes") or []:
        suites = (c.get("commit") or {}).get("checkSuites") or {}
        total += suites.get("totalCount") or 0
    return total


def cost_metrics(prs):
    """Per-group cost/débit proxies for one day × workspace."""
    n = len(prs)
    delays = [d for d in (merge_delay_hours(p.get("createdAt"), p.get("mergedAt")) for p in prs)
              if d is not None]
    commit_counts = [(p.get("commits") or {}).get("totalCount") or 0 for p in prs]
    suites = [ci_suites_of(p) for p in prs]
    return {
        "n": n,
        "delay_median_h": _median(delays) if delays else 0.0,
        "commits_mean": (sum(commit_counts) / float(n)) if n else 0.0,
        "commits_median": _median(commit_counts) if commit_counts else 0.0,
        "ci_mean": (sum(suites) / float(n)) if n else 0.0,
        "ci_median": _median(suites) if suites else 0.0,
    }


def sweep_split(closed):
    """(total, hors_balayage, swept) — every closure landing in a minute that
    holds >= SWEEP_MIN_CLOSURES is a bulk sweep. Self-contained proxy for G5's
    lot filter (stated in the output header): organic per-grain closing never
    clusters 8 in one minute."""
    per_minute = Counter((i.get("closedAt") or "")[:16] for i in closed)
    swept = sum(1 for i in closed if per_minute[(i.get("closedAt") or "")[:16]] >= SWEEP_MIN_CLOSURES)
    return len(closed), len(closed) - swept, swept


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


def day_prs(repo, day, fetch=None):
    """Merged PRs of ONE day with cost fields + lane marker; cap-aware
    (same contract as range_prs — August's worst day stays far under 1000)."""
    fetch = fetch or gh_graphql
    q = "repo:%s is:pr is:merged merged:%s..%s" % (repo, day, day)
    prs, cursor, cap = [], None, False
    while True:
        s = fetch(DAILY_PR_QUERY, {"q": q, "cursor": cursor})["search"]
        for x in s["nodes"]:
            t, see, other = cited_numbers(x.get("title"), x.get("body"))
            prs.append({"number": x["number"], "createdAt": x.get("createdAt"),
                        "mergedAt": x["mergedAt"], "closing": x["closingIssuesReferences"]["totalCount"],
                        "title_nums": t, "see_nums": see, "other_nums": other,
                        "lane": lane_of(x.get("body")),
                        "commits": x.get("commits")})
        if not s["pageInfo"]["hasNextPage"]:
            if s["issueCount"] > len(prs):
                sys.stderr.write("CAP: %s reports issueCount=%d but search returned %d\n"
                                 % (day, s["issueCount"], len(prs)))
                cap = True
            return prs, cap
        cursor = s["pageInfo"]["endCursor"]


def day_closed_issues(repo, day, fetch=None):
    """Issues closed that day (any reason) — ({closedAt, stateReason} dicts, cap).

    Cap-aware exactly like day_prs (returns the cap bit): an issues search that
    hit the 1000 cap must fail the run (exit 1), not silently undercount —
    asymmetric treatment of the two searches of the same day was CR #366.
    """
    fetch = fetch or gh_graphql
    q = "repo:%s is:issue closed:%s..%s" % (repo, day, day)
    out, cursor, cap = [], None, False
    while True:
        s = fetch(ISSUE_QUERY, {"q": q, "cursor": cursor})["search"]
        for x in s["nodes"]:
            out.append({"closedAt": x.get("closedAt"), "stateReason": x.get("stateReason")})
        if not s["pageInfo"]["hasNextPage"]:
            if s["issueCount"] > len(out):
                sys.stderr.write("CAP(issues): %s reports %d, got %d\n" % (day, s["issueCount"], len(out)))
                cap = True
            return out, cap
        cursor = s["pageInfo"]["endCursor"]


def daily_series(repo, d0, d1, fetch=None):
    """The G8 series: one row per day per workspace + an issues line per day
    + a month summary per workspace. Ventilated by lane marker, never mixed.
    `fetch` propagates to every network call — the orchestrator is pinned by
    test (CR #366: a mutation venting every PR to UNATTRIBUTED must go red)."""
    cache, any_cap = {}, False
    month_by_ws = {}
    print("== %s — daily %s..%s (UTC merged) ==" % (repo, d0, d1))
    print("   proxies: commits/PR exact (totalCount) · CI suites summed over the last<=100 commits")
    print("   balayage = any minute holding >=%d closures · UNATTRIBUTED = no lane marker in body"
          % SWEEP_MIN_CLOSURES)
    print("   %-10s  %-14s %5s  %11s  %8s  %6s  %6s  %5s" %
          ("day", "workspace", "n", "delay_med_h", "comm/PR", "ci/PR", "cite%", "pr/iss"))
    d, end = date.fromisoformat(d0), date.fromisoformat(d1)
    while d <= end:
        day = d.isoformat()
        d += timedelta(days=1)
        prs, cap = day_prs(repo, day, fetch)
        any_cap = any_cap or cap
        closed, cap = day_closed_issues(repo, day, fetch)
        any_cap = any_cap or cap
        total, hors, swept = sweep_split(closed)
        numbers = set()
        for p in prs:
            numbers |= p["title_nums"] | p["see_nums"] | p["other_nums"]
        types = resolve_types(repo, numbers, cache, fetch) if numbers else {}
        groups = {}
        for p in prs:
            groups.setdefault(p["lane"][1] if p["lane"] else "UNATTRIBUTED", []).append(p)
        for ws in sorted(groups):
            g = groups[ws]
            cm, wm = cost_metrics(g), week_metrics(g, types)
            month_by_ws.setdefault(ws, []).append(g)
            print("   %-10s  %-14s %5d  %11.1f  %8.1f  %6.1f  %5.0f%%  %5.2f"
                  % (day, ws, cm["n"], cm["delay_median_h"], cm["commits_mean"], cm["ci_mean"],
                     100.0 * wm["any_issue_prs"] / max(1, wm["n"]), wm["pr_per_issue_mean"]))
        print("   %-10s  issues closed %d (hors-balayage %d · balayage %d)" % (day, total, hors, swept))
    print("== month summary per workspace ==")
    for ws in sorted(month_by_ws):
        g = [p for part in month_by_ws[ws] for p in part]
        numbers = set()
        for p in g:
            numbers |= p["title_nums"] | p["see_nums"] | p["other_nums"]
        types = resolve_types(repo, numbers, cache, fetch) if numbers else {}
        cm, wm = cost_metrics(g), week_metrics(g, types)
        print("   %-14s n=%5d  cite=%5.1f%%  pr/title-issue mean=%.2f med=%.1f max=%d"
              % (ws, cm["n"], 100.0 * wm["any_issue_prs"] / max(1, wm["n"]),
                 wm["pr_per_issue_mean"], wm["pr_per_issue_median"], wm["pr_per_issue_max"]))
        print("   %-14s delay_med=%6.1fh  comm/PR mean=%.2f med=%.1f  ci/PR mean=%.1f med=%.1f"
              % ("", cm["delay_median_h"], cm["commits_mean"], cm["commits_median"],
                 cm["ci_mean"], cm["ci_median"]))
    return 1 if any_cap else 0


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
    ap.add_argument("--daily", default=None, metavar="FROM..TO",
                    help="G8: one row per UTC day per workspace (lane marker), cost proxies "
                         "+ issues closed vs balayage — e.g. --daily 2026-08-01..2026-08-31")
    args = ap.parse_args()

    if args.daily:
        if args.week:
            sys.stderr.write("ERROR: --daily and --week are exclusive — --daily renders the "
                             "whole range itself; drop --week\n")
            return 2
        try:
            d0, _, d1 = args.daily.partition("..")
            a, b = date.fromisoformat(d0), date.fromisoformat(d1)
            if not d1 or a > b:
                raise ValueError
        except ValueError:
            sys.stderr.write("ERROR: --daily wants FROM..TO ISO dates, got %r\n" % args.daily)
            return 2
        try:
            return daily_series(args.repo, d0, d1)
        except RuntimeError as e:
            sys.stderr.write("ERROR on %s: %s\n" % (args.repo, e))
            return 2

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
