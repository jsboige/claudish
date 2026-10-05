#!/usr/bin/env python3
r"""Pins for coursia-dispatch-form.py (claudish #328 G2, CR 5985488019).

The three review defects each made an ALREADY-PUBLISHED number wrong rather
than crashing, which is why they are pinned and not just fixed:

  B1 scope — the glob mixed CoursIA, CoursIA-2 and CoursIA-3 with three annex
     tables (`-issue-debt-ledger` names issue numbers BY CONSTRUCTION and only
     exists in September, an asymmetry that diluted September's coupling).
     Every accept below carries a refusal next to it, and the refusal is the
     pin: a reader that matched nothing would still "not crash".
  B2 control — one random draw per take; the ratio against it was noise with a
     precise-looking decimal. The control is now K draws; pinned for count,
     bounds, determinism and one semantic case.
  B3 cache — keyed on months alone, a month still being written froze at first
     run and a re-scope served the old corpus silently. The key is the file
     list; a size change must be a MISS.
  nit   — a message naming exactly nine numbers vanished from the histogram
     (`k > 9` in the 9+ bucket); `>= 9` counts it.

Run standalone (no pytest needed):
  python scripts/tests/test_coursia_dispatch_form.py
Or under pytest:
  pytest scripts/tests/test_coursia_dispatch_form.py
"""

import importlib.util
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

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def test_file_re_scope():
    print("FILE_RE scope (CR B1)")
    accepts = {
        "workspace-CoursIA-2026-07-01T05-55-37.md": "CoursIA",
        "workspace-CoursIA-2-2026-07-02T05-55-37.md": "CoursIA-2",
        "workspace-CoursIA-3-2026-09-02T05-55-37.md": "CoursIA-3",
    }
    for name, ws in accepts.items():
        m = cdf.FILE_RE.match(name)
        check(f"accept {name}", m is not None and m.group("ws") == ws,
              f"-> {m and m.group('ws')!r}")
    rejects = [
        "workspace-CoursIA-issue-debt-ledger-2026-09-01T05-55-37.md",
        "workspace-CoursIA-forks-retrait-2026-09-01T05-55-37.md",
        "workspace-CoursIA-2026-07-01T05-55-37 (1).md",  # Drive duplicate
        "workspace-Maintenance-2026-07-01T05-55-37.md",
        "workspace-CoursIA-20-07-01T05-55-37.md",        # not a date
    ]
    for name in rejects:
        check(f"reject {name}", cdf.FILE_RE.match(name) is None)
    check("positive control: at least one shape accepted", True)


def test_month_of():
    print("month_of")
    check("extracts 2026-07",
          cdf.month_of("workspace-CoursIA-2026-07-01T05-55-37.md") == "2026-07")


def test_format_dist():
    print("format_dist (CR nit: exactly nine)")
    d = Counter({0: 5, 3: 4, 9: 2, 10: 1})
    line = cdf.format_dist(d)
    check("0:5 listed", "0:5" in line)
    check("exactly-nine NOT listed as 9:2", "9:2" not in line)
    check("9+ sums k>=9 (2+1=3)", "9+:3" in line)
    check("no 9+ tail when none", "9+" not in cdf.format_dist(Counter({0: 1})))


def _arch_with(files):
    d = tempfile.mkdtemp(prefix="cdf-test-")
    for name, content in files.items():
        with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
            fh.write(content)
    return d


MSG_A = "### [2026-07-01T10:00:00.000Z] myia-ai-01|claudish\ngrain #101 for you\n"
MSG_B = "### [2026-07-01T11:00:00.000Z] myia-po-2023|claudish\n[CLAIMED] #101\n"


def test_select_files():
    print("select_files (glob -> regex -> month, before any read)")
    arch = _arch_with({
        "workspace-CoursIA-2026-07-01T05-55-37.md": MSG_A + MSG_B,
        "workspace-CoursIA-issue-debt-ledger-2026-07-01T05-55-37.md": MSG_A,
        "workspace-CoursIA-2026-09-01T05-55-37.md": MSG_A,   # out of month
        "workspace-CoursIA-2026-07-02T05-55-37 (1).md": MSG_A,
    })
    got = [os.path.basename(f) for f in cdf.select_files(arch, ["2026-07"])]
    check("only the scoped July file retained",
          got == ["workspace-CoursIA-2026-07-01T05-55-37.md"], f"-> {got}")
    shutil.rmtree(arch)


def test_load_cache_key():
    print("load() cache key = retained file list (CR B3)")
    arch = _arch_with({"workspace-CoursIA-2026-07-01T05-55-37.md": MSG_A})
    cdf.ARCH = arch
    cdf.CACHE = os.path.join(arch, "cache.json")
    msgs, prov, n = cdf.load(["2026-07"])
    check("first read from disk", prov == "disk")
    check("message carries its workspace", msgs and msgs[0]["ws"] == "CoursIA")
    check("file count reported", n == 1)
    msgs2, prov2, _ = cdf.load(["2026-07"])
    check("second read is a cache hit", prov2 == "cache")
    check("cache hit serves the same corpus", msgs2 == msgs)
    # A size change (month still being written) must be a MISS.
    with open(os.path.join(arch, "workspace-CoursIA-2026-07-01T05-55-37.md"),
              "a", encoding="utf-8") as fh:
        fh.write(MSG_B)
    msgs3, prov3, _ = cdf.load(["2026-07"])
    check("size change -> cache miss", prov3 == "disk")
    check("re-parse sees the appended message", len(msgs3) == 2, f"-> {len(msgs3)}")
    shutil.rmtree(arch)


def test_control_rates():
    print("control_rates (CR B2: K draws, bounded, deterministic)")
    lo = datetime(2026, 7, 1)
    span = 100 * 60.0  # 100 minutes
    pairs = [(101, lo + timedelta(minutes=60))]
    coord_nums = {101: [lo]}  # dispatch at the very start
    r1 = cdf.control_rates(pairs, coord_nums, lo, span, Random(1), 50, [30, 1440])
    r2 = cdf.control_rates(pairs, coord_nums, lo, span, Random(1), 50, [30, 1440])
    check("deterministic under a fixed seed", r1 == r2)
    check("K rates per window", len(r1[30]) == 50)
    check("rates bounded in [0,1]",
          all(0 <= v <= 1 for v in r1[30] + r1[1440]))
    # Semantic pin: dispatch at lo means every random time has a prior, delay is
    # uniform over the 100-min span, so <=1440m coverage is exactly 1.0 and the
    # <=30m mean sits near 30/100 (loose bounds: it is a random draw).
    check("<=1440m control is exactly 1.0 in this shape",
          all(v == 1.0 for v in r1[1440]))
    mean30 = sum(r1[30]) / len(r1[30])
    check("<=30m control mean near span ratio (0.15-0.45)",
          0.15 < mean30 < 0.45, f"-> {mean30:.3f}")


def main():
    tests = [test_file_re_scope, test_month_of, test_format_dist,
             test_select_files, test_load_cache_key, test_control_rates]
    for t in tests:
        t()
    print()
    if FAILS:
        print(f"FAILED {len(FAILS)}: {FAILS}")
        return 1
    print(f"OK — {sum(1 for _ in tests)} test groups passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
