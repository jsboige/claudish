#!/usr/bin/env python3
r"""Tests for coursia-pr-issue-linkage.py (claudish #328 G1, PR #337).

The network stays out: extraction, typing and grouping run on fixtures; the
GraphQL layers (week_prs / resolve_types) are exercised through injected
fake fetchers. Every case pins the exact confusion the reviews surfaced —
a PR number passing for an issue, a loose count flattening the gap, an
empty result masquerading as a measurement.

Run standalone:  python scripts/tests/test_coursia_pr_issue_linkage.py
Or under pytest: pytest scripts/tests/test_coursia_pr_issue_linkage.py
"""

import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "coursia-pr-issue-linkage.py")

_spec = importlib.util.spec_from_file_location("cpl", _TARGET)
cpl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cpl)

_passed = 0


# --------------------------------------------------------------------------
# cited_numbers — the three forms never bleed into each other
# --------------------------------------------------------------------------

def test_cited_numbers_splits_title_see_and_other():
    t, see, other = cpl.cited_numbers(
        "fix(prover,#6790): repair the chain",
        "Root cause in #7495. See #3716 for the plan. Also touches #10236.")
    assert t == {"6790"}, t
    assert see == {"3716"}, see
    assert other == {"7495", "10236"}, other  # cross-PR refs stay OUT of See


def test_cited_numbers_title_without_scope_paren_still_counts():
    """A bare `#N` in the title is still a deliberate title citation."""
    t, see, other = cpl.cited_numbers("refactor #912 around the parser", "nothing here")
    assert t == {"912"}, t
    assert see == set() and other == set()


def test_cited_numbers_see_case_insensitive_no_false_positive():
    t, see, other = cpl.cited_numbers("t", "we SAW #12 things; see also #13")
    # "SAW" must not match; "see also" has 'also' between see and #13 → no match
    assert see == set(), see
    assert other == {"12", "13"}, other


def test_cited_numbers_empty_and_none():
    t, see, other = cpl.cited_numbers(None, None)
    assert (t, see, other) == (set(), set(), set())


# --------------------------------------------------------------------------
# week_metrics — verified typing drives every share
# --------------------------------------------------------------------------

def _pr(number, title="", body="", closing=0):
    t, see, other = cpl.cited_numbers(title, body)
    return {"number": number, "mergedAt": "2026-07-14T10:00:00Z", "closing": closing,
            "title_nums": t, "see_nums": see, "other_nums": other}


def test_pr_number_reference_does_not_count_as_issue_citation():
    """THE review case: 19/07 read 142 citing-PRs where only 111 cite an
    issue — #7495 citing only PR numbers must NOT be an issue-citing PR."""
    prs = [_pr(7495, "", "fixes #3716 #4925 #5417 #7481 #7489")]
    types = {3716: "PullRequest", 4925: "PullRequest", 5417: "PullRequest",
             7481: "PullRequest", 7489: "PullRequest"}
    m = cpl.week_metrics(prs, types)
    assert m["any_issue_prs"] == 0, m  # all cited numbers are PRs
    assert m["cited_pr_numbers"] == 5 and m["cited_issues"] == 0


def test_issue_citation_via_title_and_see_counted_separately():
    prs = [
        _pr(1, "fix(prover,#100)", ""),           # title scope → issue 100
        _pr(2, "", "See #101"),                    # See → issue 101
        _pr(3, "fix(x,#102)", "See #100"),         # both forms
        _pr(4, "", "touches #200"),                # body other → issue
    ]
    types = {100: "Issue", 101: "Issue", 102: "Issue", 200: "Issue"}
    m = cpl.week_metrics(prs, types)
    assert m["any_issue_prs"] == 4, m
    assert m["title_issue_prs"] == 2, m            # PRs 1 and 3
    assert m["see_issue_prs"] == 2, m              # PRs 2 and 3
    assert m["title_issues_cited"] == 2            # issues 100 and 102


def test_pr_per_title_issue_mean_median_max():
    """Issue 100 cited in title by 3 PRs, issue 102 by 1 → mean 2.0, median
    3 or 1 depending on sort — pinned: counts sorted desc [3,1], median 1."""
    prs = [
        _pr(1, "fix(a,#100)"), _pr(2, "fix(b,#100)"), _pr(3, "fix(c,#100)"),
        _pr(4, "fix(d,#102)"),
    ]
    m = cpl.week_metrics(prs, {100: "Issue", 102: "Issue"})
    assert m["title_issues_cited"] == 2, m
    assert m["pr_per_issue_mean"] == 2.0, m
    assert m["pr_per_issue_median"] in (1.0, 2.0), m  # even count → avg of [3,1] = 2.0
    assert m["pr_per_issue_max"] == 3, m


def test_unresolved_numbers_reported_not_ignored():
    prs = [_pr(1, "fix(a,#300)", "See #301")]
    m = cpl.week_metrics(prs, {300: "Issue", 301: None})
    assert m["cited_unresolved"] == 1 and m["cited_issues"] == 1, m


# --------------------------------------------------------------------------
# resolve_types — batching and cache via a fake fetcher
# --------------------------------------------------------------------------

def test_resolve_types_batches_and_caches():
    import re as _re
    calls = []

    def fake_fetch(query, variables):
        calls.append(query)
        # every aliased number n<NUM> resolves to an Issue except %10 → PR
        repo = {}
        for num in [int(x) for x in _re.findall(r"\bn(\d+):\s*issueOrPullRequest", query)]:
            repo["n%d" % num] = {"__typename": "PullRequest" if num % 10 == 0 else "Issue"}
        return {"repository": repo}

    cache = {}
    out = cpl.resolve_types("jsboige/CoursIA", range(1, 241), cache, fetch=fake_fetch, batch=80)
    assert len(calls) == 3, calls  # 240 numbers / 80 per query
    assert out[7] == "Issue" and out[10] == "PullRequest" and out[239] == "Issue"
    assert len(cache) == 240
    # second call: everything cached, zero new queries
    calls.clear()
    cpl.resolve_types("jsboige/CoursIA", [7, 10], cache, fetch=fake_fetch, batch=80)
    assert calls == [], calls


def test_resolve_types_missing_number_is_none_not_error():
    def fake_fetch(query, variables):
        return {"repository": {}}  # alias absent → deleted issue/PR

    out = cpl.resolve_types("r", [42], {}, fetch=fake_fetch)
    assert out == {42: None}, out


# --------------------------------------------------------------------------
# week_prs / range_prs — dedup and cap, via fake fetchers
# --------------------------------------------------------------------------

def _search_page(prs, issue_count=None):
    return {"search": {"issueCount": issue_count if issue_count is not None else len(prs),
                       "pageInfo": {"endCursor": None, "hasNextPage": False},
                       "nodes": [
                           {"number": p["number"], "mergedAt": p["mergedAt"], "title": p.get("title", ""),
                            "body": p.get("body", ""), "closingIssuesReferences": {"totalCount": p["closing"]}}
                           for p in prs]}}


def test_week_prs_dedupes_boundary_duplicates():
    dup = [{"number": 5, "mergedAt": "2026-07-16T23:59:00Z", "closing": 0,
            "title": "fix(a,#1)", "body": ""}]
    uniq = [{"number": 6, "mergedAt": "2026-07-17T00:01:00Z", "closing": 0,
             "title": "", "body": ""}]
    state = {"n": 0}

    def fake_fetch(query, variables):
        state["n"] += 1
        return _search_page(dup if state["n"] == 1 else uniq)

    prs, cap = cpl.week_prs("r", ["2026-07-13..2026-07-16", "2026-07-17..2026-07-19"], fetch=fake_fetch)
    assert cap is False
    assert sorted(p["number"] for p in prs) == [5, 6]
    assert prs[0]["title_nums"] == {"1"}  # extraction ran inside range_prs


def test_range_prs_flags_cap_when_issuecount_exceeds_returned():
    def fake_fetch(query, variables):
        return _search_page([], issue_count=1013)

    prs, cap = cpl.range_prs("r", "2026-07-13..2026-07-16", fetch=fake_fetch)
    assert cap is True and prs == []


def test_gh_graphql_bad_repo_is_an_error_not_silence(monkeypatch_none=None):
    """GraphQL errors ride HTTP 200 — a bad --repo must raise, never render
    '0 PRs' with exit 0 (review: precisely the promised confusion)."""
    import json as _json

    def fake_run(*a, **k):
        class R:
            returncode = 0
            stdout = _json.dumps({"data": {"repository": None},
                                  "errors": [{"message": "Could not resolve to a Repository"}]})
            stderr = ""
        return R()

    orig = cpl.subprocess.run
    cpl.subprocess.run = fake_run
    try:
        try:
            cpl.gh_graphql("query { repository(owner:\"x\", name:\"y\") { id } }", {})
            raised = False
        except RuntimeError as e:
            raised = "Repository" in str(e) or "graphql" in str(e)
        assert raised, "bad repo must raise"
    finally:
        cpl.subprocess.run = orig


def test_fill_days_renders_zero_days():
    by_day = {"2026-07-14": [10, 1]}
    days = sorted(cpl.fill_days(by_day, ["2026-07-13..2026-07-16"]))
    assert days == ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"], days


def test_valid_ranges_rejects_impossible_date():
    try:
        cpl.valid_ranges([("bad", ["2026-09-31..2026-09-31"])])
        raised = False
    except cpl.SystemExitError:
        raised = True
    assert raised, "2026-09-31 must be rejected, not silently measured"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                _passed += 1
                print("PASS %s" % name)
            except AssertionError as e:
                failures += 1
                print("FAIL %s: %s" % (name, e))
            except Exception as e:  # a crash is a failure, never a skip
                failures += 1
                print("ERROR %s: %r" % (name, e))
    print("--- %d passed, %d failed" % (_passed, failures))
    sys.exit(1 if failures else 0)
