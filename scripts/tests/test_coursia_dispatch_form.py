#!/usr/bin/env python3
"""Pins for coursia-dispatch-form.py (claudish #328 G2, CRs 5985488019, 5993624642).

The review defects each made an ALREADY-PUBLISHED number wrong rather than
crashing, which is why they are pinned and not just fixed:

  B1 scope — the glob mixed CoursIA, CoursIA-2 and CoursIA-3 with three annex
     tables (`-issue-debt-ledger` names issue numbers BY CONSTRUCTION and only
     exists in September, an asymmetry that diluted September's coupling).
     Every accept below carries a refusal next to it, and the refusal is the
     pin: a reader that matched nothing would still "not crash".
  B2 control — one random draw per take; the ratio against it was noise with a
     precise-looking decimal. The control is K draws; pinned for count,
     bounds, determinism and one semantic case.
  B3 cache — keyed on months alone, a month still being written froze at first
     run and a re-scope served the old corpus silently. The key is the file
     list; a size change must be a MISS. A run with an unreadable file must
     NOT be cached (CR 5993624642 B3 — a partial corpus served silently).
  CR3 golden — `main()` itself has a golden-fixture test: the pre-CR suite
     stayed green under pytest whatever the code did, because `check()` only
     appended to a list. Every check here raises.

Run standalone (no pytest needed):
  python scripts/tests/test_coursia_dispatch_form.py
Or under pytest:
  pytest scripts/tests/test_coursia_dispatch_form.py
"""

import contextlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
from collections import Counter
from datetime import datetime, timedelta
from random import Random

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "coursia-dispatch-form.py")

_spec = importlib.util.spec_from_file_location("cdf", _TARGET)
cdf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cdf)


# ── fixture builders ─────────────────────────────────────────────────────────

def _arch_with(files):
    d = tempfile.mkdtemp(prefix="cdf-test-")
    for name, content in files.items():
        with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
            fh.write(content)
    return d


MSG_A = "### [2026-07-01T10:00:00.000Z] myia-ai-01|claudish\ngrain #101 for you\n"
MSG_B = "### [2026-07-01T11:00:00.000Z] myia-po-2023|claudish\n[CLAIMED] #101\n"


def _run_main(arch, months, no_cache=False):
    """main() against a private cache; returns (stdout, exit_code|None)."""
    cache = os.path.join(arch, "..",
                         os.path.basename(arch) + "-cache.json")
    argv = list(months) + (["--no-cache"] if no_cache else [])
    buf = io.StringIO()
    code = None
    with contextlib.redirect_stdout(buf):
        try:
            cdf.main(argv, arch=arch, cache=cache)
        except SystemExit as e:
            code = e.code
    return buf.getvalue(), code


# The golden corpus: hand-computable coverage, one cell per workspace, plus a
# September file so argument order can be varied. See test_golden_main.
GOLDEN_COURSIA = (
    "### [2026-07-01T08:00:00.000Z] myia-ai-01|claudish\n"
    "grains: #101 #102 #103\n"
    "### [2026-07-01T08:10:00.000Z] myia-po-2023|claudish\n"
    "[CLAIMED] #101\n"
    "### [2026-07-01T09:30:00.000Z] myia-po-2024|claudish\n"
    "rule text says `[CLAIMED] #101` verbatim\n"
    "### [2026-07-01T12:00:00.000Z] myia-ai-01|claudish\n"
    "next grain #204\n"
    "### [2026-07-01T12:05:00.000Z] myia-po-2023|claudish\n"
    "[CLAIMED] #204 too\n"
    "### [2026-07-01T13:00:00.000Z] myia-po-2023|claudish\n"
    "[CLAIMED] #204 (repeat, report)\n"
    "### [2026-07-01T14:00:00.000Z] myia-po-2026|claudish\n"
    "[CLAIMED] #999\n"
    "### [2026-07-01T15:00:00.000Z] myia-ai-01|claudish\n"
    "[CLAIMED] #555\n"
)
GOLDEN_COURSIA2 = (
    "### [2026-07-01T08:00:00.000Z] myia-ai-01|claudish\n"
    "one grain #501\n"
    "### [2026-07-01T08:20:00.000Z] myia-po-2027|claudish\n"
    "[CLAIMED] #501\n"
)
GOLDEN_SEPT = (
    "### [2026-09-01T08:00:00.000Z] myia-ai-01|claudish\n"
    "grain #301\n"
    "### [2026-09-01T08:25:00.000Z] myia-po-2023|claudish\n"
    "[CLAIMED] #301\n"
)


def _golden_arch():
    return _arch_with({
        "workspace-CoursIA-2026-07-01T00-00-00.000Z.md": GOLDEN_COURSIA,
        "workspace-CoursIA-2-2026-07-01T00-00-00.000Z.md": GOLDEN_COURSIA2,
        "workspace-CoursIA-2026-09-01T00-00-00.000Z.md": GOLDEN_SEPT,
    })


# ── pure-function pins ───────────────────────────────────────────────────────

def test_file_re_scope():
    accepts = {
        "workspace-CoursIA-2026-07-01T05-55-37.md": "CoursIA",
        "workspace-CoursIA-2-2026-07-02T05-55-37.md": "CoursIA-2",
        "workspace-CoursIA-3-2026-09-02T05-55-37.md": "CoursIA-3",
    }
    for name, ws in accepts.items():
        m = cdf.FILE_RE.match(name)
        assert m is not None and m.group("ws") == ws, (name, m)
    rejects = [
        "workspace-CoursIA-issue-debt-ledger-2026-09-01T05-55-37.md",
        "workspace-CoursIA-forks-retrait-2026-09-01T05-55-37.md",
        "workspace-CoursIA-2026-07-01T05-55-37 (1).md",  # Drive duplicate
        "workspace-Maintenance-2026-07-01T05-55-37.md",
        "workspace-CoursIA-20-07-01T05-55-37.md",        # not a date
    ]
    for name in rejects:
        assert cdf.FILE_RE.match(name) is None, name


def test_month_of():
    assert cdf.month_of(
        "workspace-CoursIA-2026-07-01T05-55-37.md") == "2026-07"


def test_format_dist():
    d = Counter({0: 5, 3: 4, 9: 2, 10: 1})
    line = cdf.format_dist(d)
    assert "0:5" in line
    assert "9:2" not in line          # exactly-nine belongs in 9+
    assert "9+:3" in line             # 2 + 1
    assert "9+" not in cdf.format_dist(Counter({0: 1}))


def test_select_files():
    arch = _arch_with({
        "workspace-CoursIA-2026-07-01T05-55-37.md": MSG_A + MSG_B,
        "workspace-CoursIA-issue-debt-ledger-2026-07-01T05-55-37.md": MSG_A,
        "workspace-CoursIA-2026-09-01T05-55-37.md": MSG_A,   # out of month
        "workspace-CoursIA-2026-07-02T05-55-37 (1).md": MSG_A,
    })
    got = [os.path.basename(f) for f in cdf.select_files(arch, ["2026-07"])]
    assert got == ["workspace-CoursIA-2026-07-01T05-55-37.md"], got
    shutil.rmtree(arch)


# ── cache pins (CR B3 + CR 5993624642 B3) ────────────────────────────────────

def test_load_cache_key():
    arch = _arch_with({"workspace-CoursIA-2026-07-01T05-55-37.md": MSG_A})
    cache = os.path.join(arch, "cache.json")
    msgs, prov, n, failed = cdf.load(["2026-07"], cache=cache, arch=arch)
    assert prov == "disk"
    assert failed == 0
    assert msgs and msgs[0]["ws"] == "CoursIA"
    assert n == 1
    msgs2, prov2, _, _ = cdf.load(["2026-07"], cache=cache, arch=arch)
    assert prov2 == "cache"
    assert msgs2 == msgs
    # A size change (month still being written) must be a MISS.
    with open(os.path.join(arch, "workspace-CoursIA-2026-07-01T05-55-37.md"),
              "a", encoding="utf-8") as fh:
        fh.write(MSG_B)
    msgs3, prov3, _, _ = cdf.load(["2026-07"], cache=cache, arch=arch)
    assert prov3 == "disk"
    assert len(msgs3) == 2
    shutil.rmtree(arch)


def test_no_cache_after_read_failure():
    """An unreadable file must NOT be cached under the full key: the next run
    would serve the partial corpus silently (the trap test_qwen_guard pins)."""
    arch = _arch_with({"workspace-CoursIA-2026-07-01T05-55-37.md": MSG_A})
    cache = os.path.join(arch, "cache.json")
    # A DIRECTORY named like an archive file: selected, getsize'd, unreadable.
    os.mkdir(os.path.join(arch, "workspace-CoursIA-2026-07-02T05-55-37.md"))
    msgs, prov, n, failed = cdf.load(["2026-07"], cache=cache, arch=arch)
    assert prov == "disk"
    assert failed == 1, "the unreadable file must be counted"
    assert n == 2
    assert not os.path.exists(cache), "a partial corpus must not be cached"
    shutil.rmtree(arch)


def test_main_exit_3_on_partial():
    arch = _golden_arch()
    os.mkdir(os.path.join(arch, "workspace-CoursIA-2026-07-02T00-00-00.000Z.md"))
    out, code = _run_main(arch, ["2026-07"])
    assert code == 3, "partial read -> exit 3 (loud, not silent)"
    shutil.rmtree(arch)


# ── usage pins (CR 5993624642: argparse, malformed month, empty corpus) ─────

def test_argparse_rejects_typo_and_bad_month():
    for argv in (["--nocache"],                  # typo'd flag: was silently ignored
                 ["2026-7"],                     # malformed month
                 ["2026-07", "juillet"]):
        try:
            cdf.parse_args(argv)
        except SystemExit as e:
            assert e.code == 2, (argv, e.code)
        else:
            raise AssertionError(f"parse_args accepted {argv}")
    months, no_cache = cdf.parse_args(["2026-07", "--no-cache"])
    assert months == ["2026-07"] and no_cache is True
    months, no_cache = cdf.parse_args([])
    assert months == ["2026-07", "2026-09"] and no_cache is False


def test_empty_archive_exits_nonzero():
    arch = tempfile.mkdtemp(prefix="cdf-empty-")
    out, code = _run_main(arch, ["2026-07"])
    assert code == 2, "0 files matched -> exit 2 (was exit 0)"
    shutil.rmtree(arch)


# ── null pins (CR B2 + CR 5993624642: two nulls, same coverage predicate) ───

def test_null_random_times():
    lo = datetime(2026, 7, 1)
    span = 100 * 60.0  # 100 minutes
    pairs = [(101, lo + timedelta(minutes=60))]
    coord_nums = {101: [lo]}  # dispatch at the very start
    r1 = cdf.null_random_times(pairs, coord_nums, lo, span, Random(1), 50,
                               [30, 1440])
    r2 = cdf.null_random_times(pairs, coord_nums, lo, span, Random(1), 50,
                               [30, 1440])
    assert r1 == r2, "deterministic under a fixed seed"
    assert len(r1[30]) == 50
    assert all(0 <= v <= 1 for v in r1[30] + r1[1440])
    # Semantic: dispatch at lo means every random time has a prior, delay is
    # uniform over the span, so <=1440m coverage is exactly 1.0 and the <=30m
    # mean sits near 30/100.
    assert all(v == 1.0 for v in r1[1440])
    mean30 = sum(r1[30]) / len(r1[30])
    assert 0.15 < mean30 < 0.45, mean30


def test_null_number_shuffle():
    """Semantic pin: shuffling numbers keeps times (co-activity) and breaks the
    pairing. #101 dispatched at 10:00, claimed at 10:10 (hit <=30m); #202 never
    dispatched, claimed at 18:00 (miss). Of the two permutations, identity
    keeps the <=30m hit and the swap moves #101 to 18:00 (480m, <=1440m only):
    every draw is 0.0 or 1.0, never anything else, and <=1440m coverage is 1.0
    under BOTH permutations — the shuffle moved the hit between windows, it
    cannot create or destroy the one prior dispatch."""
    t0 = datetime(2026, 7, 1, 10, 0)
    t1 = datetime(2026, 7, 1, 10, 10)
    t2 = datetime(2026, 7, 1, 18, 0)
    pairs = [(101, t1), (202, t2)]
    coord_nums = {101: [t0]}
    cov_m, _ = cdf.coverage(pairs, coord_nums, [30, 1440])
    assert cov_m[30] == 1 and cov_m[1440] == 1  # #101 hits both, #202 misses
    r = cdf.null_number_shuffle(pairs, coord_nums, Random(7), 40, [30, 1440])
    assert len(r[30]) == 40
    assert set(r[30]) <= {0.0, 0.5}, r[30]      # 0 or 1 hit over n=2: a permutation, not a blur
    assert all(v == 0.5 for v in r[1440]), r[1440]
    r2 = cdf.null_number_shuffle(pairs, coord_nums, Random(7), 40, [30, 1440])
    assert r == r2, "deterministic under a fixed seed"
    # Rates, not counts: count/n can never exceed 1 (the count-only form of
    # this null printed 188.0% on the golden fixture — caught only by eye).
    assert all(0.0 <= v <= 1.0 for v in r[30] + r[1440])


def test_ratio_suffix():
    # The exact shape the 2026-07 CoursIA corpus hit on first run: mean > 0
    # but the 2.5th percentile is 0.0 — division by the 0 endpoint crashed.
    s = cdf.ratio_suffix(0.219, 0.03, 0.0, 0.06, 397)
    assert "ratio" in s and "touches 0" in s and "[>" in s
    # Closed interval: low bound of the RATIO uses the HIGH control bound.
    s2 = cdf.ratio_suffix(0.219, 0.03, 0.01, 0.06, 397)
    assert s2 == " -> ratio 7.3 [3.7-21.9]", s2
    # Thin-corpus shape (real: CoursIA-2 2026-09, n=25): p97.5 also 0.
    s3 = cdf.ratio_suffix(0.04, 0.002, 0.0, 0.0, 25)
    assert "p97.5=0" in s3
    # Thin marker: n < 10 says so (a 100.0 ratio on n=1 is a coin flip).
    s4 = cdf.ratio_suffix(1.0, 0.5, 0.2, 0.8, 1)
    assert "[n=1 thin]" in s4
    assert "n/a" in cdf.ratio_suffix(0.2, 0.0, 0.0, 0.0, 10)


def test_wilson():
    # 13/441 = 2.9% -> the published September interval [1.7-5.0].
    lo, hi = cdf.wilson(13, 441)
    assert abs(lo - 1.7) < 0.1 and abs(hi - 5.0) < 0.1, (lo, hi)
    assert lo < hi
    # Extremes stay inside [0, 100] and never collapse to a point.
    assert cdf.wilson(0, 10)[0] == 0.0 and cdf.wilson(0, 10)[1] > 0
    assert cdf.wilson(10, 10)[1] == 100.0 and cdf.wilson(10, 10)[0] < 100
    assert cdf.wilson(0, 0) == (0.0, 0.0)


# ── claim-selection pins (CR 5993624642 B4) ──────────────────────────────────

def _ev(dt, num, machine, body=None):
    return {"dt": datetime.fromisoformat(dt), "machine": machine,
            "body": body or f"[CLAIMED] #{num}"}


def test_claim_events_drops_backquoted():
    events = cdf.claim_events([
        _ev("2026-07-01T08:10:00", 101, "po-2023"),
        _ev("2026-07-01T09:30:00", 101, "po-2024",
            "rule text says `[CLAIMED] #101` verbatim"),
        _ev("2026-07-01T10:00:00", None, "po-2025", "marker without number"),
    ])
    assert events == [(101, datetime.fromisoformat("2026-07-01T08:10:00"),
                       "po-2023")], events


def test_select_pairs_first_only():
    events = [
        (101, datetime(2026, 7, 1, 8, 10), "po-2023"),
        (101, datetime(2026, 7, 1, 9, 30), "po-2024"),   # same num, other lane: NOT a repeat
        (101, datetime(2026, 7, 1, 13, 0), "po-2023"),   # repeat by same lane
        (555, datetime(2026, 7, 1, 15, 0), cdf.COORD),   # coordinator echo
    ]
    raw, first, drops = cdf.select_pairs(events)
    assert len(raw) == 4
    assert first == [(101, datetime(2026, 7, 1, 8, 10)),
                     (101, datetime(2026, 7, 1, 9, 30))], first
    assert drops == {"coord": 1, "repeat": 1}


# ── golden main() (CR 5993624642 B1) ─────────────────────────────────────────

# Full-output freeze on the fixture below, with the tmp archive path
# normalized to <ARCH>. The measured/Wilson/selection/delay lines are
# HAND-COMPUTED (see the asserts); the NULL lines are seeded per cell and
# frozen verbatim — any change in draw count, seeding, a draw shared across
# pairs/cells or the coverage predicate turns the exact comparison red.
# Regenerate: run this test module standalone with CDF_DUMP_GOLDEN=1.
GOLDEN_MAIN_OUTPUT = (
    'corpus: 3 files, read from disk (COURSIA_ARCHIVE=<ARCH>)\n'
    '=== CoursIA | 2026-07 — 8 msgs | coordinator 3 | claims 6 (75.0% of msgs) ===\n'
    '  distinct #NN per coordinator msg: 1:2 3:1\n'
    '  coordinator msgs naming >=3 distinct #NN: 1/3 (33.3%)\n'
    '  claims by lane: myia-po-2023:3, myia-po-2024:1, myia-po-2026:1, myia-ai-01:1\n'
    '  selection: raw 5 numbered claims -> first 3 (dropped: 1 backquoted protocol quotes, 1 coordinator, 1 repeats)\n'
    '  [measured raw] n=5: <=30m 40.0%  <=120m 60.0%  <=360m 60.0%  <=1440m 60.0%  (<=30m Wilson 95% [11.8-76.9])\n'
    '  [measured first] n=3: <=30m 66.7%  <=120m 66.7%  <=360m 66.7%  <=1440m 66.7%  (<=30m Wilson 95% [20.8-93.9])\n'
    '    delay claim-after-dispatch p50=10m p90=60m\n'
    '  [NULL-R: random times, 200 draws, ratio vs RAW] <=30m 4.1% [0.0-20.0] -> ratio 9.8 [>2.0] [n=5 thin] (control band touches 0)  <=120m 18.8% [0.0-60.0] -> ratio 3.2 [>1.0] [n=5 thin] (control band touches 0)  <=360m 34.1% [0.0-60.0] -> ratio 1.8 [>1.0] [n=5 thin] (control band touches 0)  <=1440m 37.6% [20.0-60.0] -> ratio 1.6 [1.0-3.0] [n=5 thin]\n'
    '  [NULL-N: number shuffle, 200 draws, ratio vs RAW] <=30m 12.4% [0.0-40.0] -> ratio 3.2 [>1.0] [n=5 thin] (control band touches 0)  <=120m 28.2% [0.0-60.0] -> ratio 2.1 [>1.0] [n=5 thin] (control band touches 0)  <=360m 47.8% [20.0-60.0] -> ratio 1.3 [1.0-3.0] [n=5 thin]  <=1440m 51.5% [40.0-60.0] -> ratio 1.2 [1.0-1.5] [n=5 thin]\n'
    '\n'
    '=== CoursIA | 2026-09 — 2 msgs | coordinator 1 | claims 1 (50.0% of msgs) ===\n'
    '  distinct #NN per coordinator msg: 1:1\n'
    '  coordinator msgs naming >=3 distinct #NN: 0/1 (0.0%)\n'
    '  claims by lane: myia-po-2023:1\n'
    '  selection: raw 1 numbered claims -> first 1 (dropped: 0 backquoted protocol quotes, 0 coordinator, 0 repeats)\n'
    '  [measured raw] n=1: <=30m 100.0%  <=120m 100.0%  <=360m 100.0%  <=1440m 100.0%  (<=30m Wilson 95% [20.7-100.0])\n'
    '  [measured first] n=1: <=30m 100.0%  <=120m 100.0%  <=360m 100.0%  <=1440m 100.0%  (<=30m Wilson 95% [20.7-100.0])\n'
    '    delay claim-after-dispatch p50=25m p90=25m\n'
    '  [NULL-R: random times, 200 draws, ratio vs RAW] <=30m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=120m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=360m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=1440m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]\n'
    '  [NULL-N: number shuffle, 200 draws, ratio vs RAW] <=30m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=120m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=360m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=1440m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]\n'
    '\n'
    '=== CoursIA-2 | 2026-07 — 2 msgs | coordinator 1 | claims 1 (50.0% of msgs) ===\n'
    '  distinct #NN per coordinator msg: 1:1\n'
    '  coordinator msgs naming >=3 distinct #NN: 0/1 (0.0%)\n'
    '  claims by lane: myia-po-2027:1\n'
    '  selection: raw 1 numbered claims -> first 1 (dropped: 0 backquoted protocol quotes, 0 coordinator, 0 repeats)\n'
    '  [measured raw] n=1: <=30m 100.0%  <=120m 100.0%  <=360m 100.0%  <=1440m 100.0%  (<=30m Wilson 95% [20.7-100.0])\n'
    '  [measured first] n=1: <=30m 100.0%  <=120m 100.0%  <=360m 100.0%  <=1440m 100.0%  (<=30m Wilson 95% [20.7-100.0])\n'
    '    delay claim-after-dispatch p50=20m p90=20m\n'
    '  [NULL-R: random times, 200 draws, ratio vs RAW] <=30m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=120m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=360m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=1440m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]\n'
    '  [NULL-N: number shuffle, 200 draws, ratio vs RAW] <=30m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=120m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=360m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]  <=1440m 100.0% [100.0-100.0] -> ratio 1.0 [1.0-1.0] [n=1 thin]\n'
    '\n'
    '=== CoursIA-2 | 2026-09: no messages ===\n'
    '=== CoursIA-3 | 2026-07: no messages ===\n'
    '=== CoursIA-3 | 2026-09: no messages ===\n'
)


def test_golden_main():
    """Exact-output pin. The measured/Wilson/selection lines are HAND-COMPUTED
    (see comments); the NULL lines are seeded per cell and frozen — any change
    in draw count, seeding, shared draws or the coverage predicate turns this
    red. Kills the mutations the pre-CR suite let through: ventilation
    overwritten, K=1, unseeded rng, shared draw, inverted ratio bounds."""
    arch = _golden_arch()
    out, code = _run_main(arch, ["2026-07", "2026-09"])
    assert code is None, f"clean corpus must exit 0, got {code}"
    lines = out.splitlines()

    def cell(marker):
        i = next(k for k, l in enumerate(lines) if l.startswith(marker))
        j = next((k for k in range(i + 1, len(lines))
                  if lines[k].startswith("===")), len(lines))
        return lines[i:j]

    # Hand-computed cell: CoursIA July (see GOLDEN_COURSIA comments).
    c = cell("=== CoursIA | 2026-07")
    assert "8 msgs | coordinator 3 | claims 6 (75.0%" in c[0]
    assert "raw 5 numbered claims -> first 3 (dropped: 1 backquoted" in "".join(c)
    measured = [l for l in c if "[measured raw]" in l][0]
    # #101@+10m and #204@+5m hit <=30m; repeat #204@+60m hits <=120m+;
    # #999/#555 have no prior dispatch -> 2/5, 3/5, 3/5, 3/5.
    assert "<=30m 40.0%  <=120m 60.0%  <=360m 60.0%  <=1440m 60.0%" in measured
    assert "Wilson 95% [11.8-76.9]" in measured          # wilson(2,5)
    first = [l for l in c if "[measured first]" in l][0]
    assert "<=30m 66.7%  <=120m 66.7%  <=360m 66.7%  <=1440m 66.7%" in first
    assert "Wilson 95% [20.8-93.9]" in first             # wilson(2,3)
    assert "p50=10m p90=60m" in "".join(c)               # delays 5,10,60
    assert "ratio vs RAW" in "".join(c)

    # Ventilation: CoursIA-2 July must differ from CoursIA July (the mutation
    # "ventilation overwritten in main" made every cell identical).
    c2 = cell("=== CoursIA-2 | 2026-07")
    assert "2 msgs | coordinator 1 | claims 1" in c2[0]
    assert "[measured raw] n=1: <=30m 100.0%" in "".join(c2)
    # Provenance header: cache hit on the second, disk again with --no-cache.
    out2, _ = _run_main(arch, ["2026-07", "2026-09"])
    assert out2.splitlines()[0].startswith("corpus: 3 files, cache hit")
    out3, _ = _run_main(arch, ["2026-07", "2026-09"], no_cache=True)
    assert out3.splitlines()[0].startswith("corpus: 3 files, read from disk")
    assert out3 == out, "no-cache run must reproduce the first run exactly"
    # Exact freeze once frozen (CDF_DUMP_GOLDEN=1 prints the candidate).
    if os.environ.get("CDF_DUMP_GOLDEN"):
        print("\n--- GOLDEN CANDIDATE (normalize the corpus line) ---")
        print(out.replace(arch, "<ARCH>"), end="")
    if GOLDEN_MAIN_OUTPUT:
        assert out.replace(arch, "<ARCH>") == GOLDEN_MAIN_OUTPUT, (
            "main() output drifted from the golden fixture")
    shutil.rmtree(arch)


def test_seed_per_cell_argument_order():
    """The draws of a cell must not depend on which other cells ran before it
    (one shared Random(SEED) made July's numbers a function of argv order)."""
    arch = _golden_arch()
    out_a, _ = _run_main(arch, ["2026-07", "2026-09"])
    out_b, _ = _run_main(arch, ["2026-09", "2026-07"], no_cache=True)
    for marker in ("=== CoursIA | 2026-07", "=== CoursIA | 2026-09",
                   "=== CoursIA-2 | 2026-07"):
        a = _cell_block(out_a, marker)
        b = _cell_block(out_b, marker)
        assert a == b, f"cell {marker} changed with argument order"
    shutil.rmtree(arch)


def _cell_block(out, marker):
    lines = out.splitlines()
    i = next(k for k, l in enumerate(lines) if l.startswith(marker))
    j = next((k for k in range(i + 1, len(lines))
              if lines[k].startswith("===")), len(lines))
    return lines[i:j]


# ── standalone runner ────────────────────────────────────────────────────────

def main():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failed = []
    for t in tests:
        try:
            t()
            print(f"  PASS {t.__name__}")
        except AssertionError as e:
            print(f"  FAIL {t.__name__}: {e}")
            failed.append(t.__name__)
    print()
    if failed:
        print(f"FAILED {len(failed)}/{len(tests)}: {failed}")
        return 1
    print(f"OK — {len(tests)} test groups passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
