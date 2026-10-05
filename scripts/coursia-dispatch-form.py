#!/usr/bin/env python3
"""coursia-dispatch-form.py — who opens the grain: the coordinator or the lane?

Measures the FORM of the CoursIA coordinator's dispatch, July vs September 2026,
from the shared-state archive of those workspaces' dashboards. Read-only, and no
model probe: the corpus is markdown already on disk.

Why it exists (#328 G2). The hypothesis under test is that July's higher
productivity came from the coordinator naming 5-6 coherent grains per lane per
cycle, where September lanes fetch their own grain ("the picker takes grains
more painfully"). This instrument measures the two sides of that:

  1. COUPLING — for each `[CLAIMED] #N`, had the coordinator named `#N` shortly
     BEFORE the claim? Reported as a share per window (30/120/360/1440 min).
  2. GRAINS PER DISPATCH — distinct `#NN` named per coordinator message.

The trap this script exists to avoid: (1) alone proves nothing. The coordinator
writes a lot in both months, so any claim is likely to have SOME earlier message
naming its number. The share is therefore reported next to TWO permutation
controls, because they answer different objections:

  - NULL-A "random times": every claim time is redrawn uniformly in the month.
    This controls for volume alone — it does NOT control for co-activity (the
    coordinator posts long numbered lists while lanes work).
  - NULL-B "number shuffle": claim TIMES are kept, the NUMBERS are permuted
    among them. This keeps the co-activity structure and breaks only the
    number->response pairing.

Each null is K draws (default 200) with its 2.5-97.5% band, seeded PER CELL
(workspace, month) so the result cannot depend on argument order. A ratio
against a null is secondary to the raw share and must name its null.

Second trap, flag-don't-assert: `[CLAIMED]` is a PROTOCOL MARKER, and a change
in its prevalence is not a change in behaviour. On the scoped corpus CoursIA
alone shows 13.8% of messages carrying the marker in July against 7.1% in
September (the pre-scope mixed-corpus figures 15.2%/4.7% covered three
workspaces); that can be a reporting-convention shift rather than more grains
claimed. The script prints it, it does not interpret it.

Third trap, claim selection. Not every `[CLAIMED]` is a lane picking a grain:
about a hundred July mentions are PROTOCOL QUOTES inside backticks (rule text
like `` `[CLAIMED] #3968 <notebook-exact>` ``), the coordinator itself echoes
claims, and a lane re-mentions a number it already claimed (an ACK or a
report, not a dispatch answer). The script therefore reports TWO selections and
names the drops:

  - raw: every numbered claim (the pre-CR definition, kept for continuity);
  - first: protocol quotes (backticked marker), the coordinator's own claims
    and later repeats dropped — the FIRST claim per (machine, #NN) is the
    dispatch answer.

Fourth trap, scope (CR B1): the glob `workspace-CoursIA-*.md` matches
CoursIA, CoursIA-2 AND CoursIA-3 — three workspaces with distinct lane
dynamics — plus annex tables (`-issue-debt-ledger`, `-forks-retrait`) that name
issue numbers by construction, and Drive-duplicate ` (1)` names. File selection
is an exact-anchored regex instead, and EVERY output is ventilated per
workspace; the headline workspace is CoursIA alone (the user's scope).

Fifth trap, the cache (same CR, B3): a key on months alone freezes a month
still being written and serves the first corpus silently after any re-scope.
The key is therefore the parser version + the retained file list (name + size),
the header prints the provenance (cache or disk) and the file count, and a run
that failed to read ANY file is never cached — a partial corpus must not be
served silently on the next run (same rule as test_qwen_guard.py).

Coverage caveats, declared rather than hidden: ~38 message headers in the
corpus use `HH:MMZ` / `~HH:MMxZ` forms that the strict ISO parser refuses and
skips; and each month loses its last ~2 hours, which live in the next month's
archive — minor and symmetric across months.

Usage:
  python scripts/coursia-dispatch-form.py [YYYY-MM ...] [--no-cache]
                                          # default 2026-07 2026-09
  COURSIA_ARCHIVE=<dir> python scripts/coursia-dispatch-form.py

Exit codes: 0 clean · 2 usage/empty corpus · 3 some archive file was
unreadable (results are partial and were NOT cached).
"""
import argparse
import glob
import json
import math
import os
import random
import re
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta

ARCH = os.environ.get(
    "COURSIA_ARCHIVE",
    r"G:/Mon Drive/Synchronisation/RooSync/.shared-state/dashboards/archive")
CACHE = os.path.join(tempfile.gettempdir(), "coursia-dispatch-msgs-cache.json")
MSG_RE = re.compile(r"^### \[(.+?)\] (\S+)\|(\S+)\s*$", re.M)
NUM_RE = re.compile(r"#(\d{3,6})\b")
CLAIM_RE = re.compile(r"\[CLAIMED\]\s*#?(\d{3,6})?", re.I)
BT_RE = re.compile(r"`[^`]+`")
COORD = "myia-ai-01"
# Exact workspace scope (CR B1): the three real workspaces only. `(?:-2|-3)?`
# refuses every other suffix (`-issue-debt-ledger`, `-forks-retrait`), and
# `[^ ]*\.md$` refuses a Drive-duplicate ` (1)` name, which has a space.
FILE_RE = re.compile(
    r"^workspace-(?P<ws>CoursIA(?:-2|-3)?)-\d{4}-\d{2}-\d{2}T[^ ]*\.md$")
WORKSPACES = ["CoursIA", "CoursIA-2", "CoursIA-3"]  # headline first
WINDOWS = [30, 120, 360, 1440]
MONTHS = ["2026-07", "2026-09"]
SEED = 20261005
K_DRAWS = 200
# Bump when the parser or the selection changes so no stale corpus is served.
CACHE_VERSION = 3


def parse_args(argv):
    p = argparse.ArgumentParser(
        description="CoursIA dispatch-form measurement (#328 G2)")
    p.add_argument("months", nargs="*",
                   help="months to measure, YYYY-MM (default 2026-07 2026-09)")
    p.add_argument("--no-cache", action="store_true",
                   help="re-read the archive even on a cache hit")
    a = p.parse_args(argv)
    months = a.months or list(MONTHS)
    bad = [m for m in months if not re.fullmatch(r"\d{4}-\d{2}", m)]
    if bad:
        p.error(f"malformed month(s) {bad} — expected YYYY-MM")
    return months, a.no_cache


def month_of(name):
    m = re.search(r"-(\d{4})-(\d{2})-\d{2}T", name)
    return f"{m.group(1)}-{m.group(2)}" if m else "?"


def select_files(arch, months):
    """Archive dir -> the retained files, scoped by FILE_RE and month. The glob
    is the cheap first pass; the regex and month filter run before any stat or
    read, so an annex table never costs a file open."""
    out = []
    for f in glob.glob(os.path.join(arch, "workspace-CoursIA-*.md")):
        base = os.path.basename(f)
        if FILE_RE.match(base) and month_of(base) in months:
            out.append(f)
    return sorted(out)


def parse(path, ws):
    """One archive file -> its messages. The body is truncated to 4 kB: the
    markers and numbers this measures all sit near the top, and the archive set
    is re-read whole on a cold cache."""
    txt = open(path, encoding="utf-8", errors="replace").read()
    hits = list(MSG_RE.finditer(txt))
    out = []
    for i, m in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(txt)
        for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
            try:
                dt = datetime.strptime(m.group(1).replace("Z", ""), fmt)
                break
            except ValueError:
                dt = None
        if dt is None:
            continue
        out.append({"ts": dt.isoformat(), "machine": m.group(2), "ws": ws,
                    "body": txt[m.end():end][:4000]})
    return out


def load(months, use_cache=True, arch=None, cache=None):
    """Returns (msgs, provenance, n_files, n_failed). The cache key is the
    parser version + the RETAINED file list (name + size), not the months: a
    month still being written or a re-scoped glob must not serve a stale
    corpus silently (CR B3). A run with ANY unreadable file is never cached."""
    arch = arch or ARCH
    cache = cache or CACHE
    files = select_files(arch, months)
    if not files:
        print(f"no archive files matched under {arch} for {sorted(months)} "
              f"(set COURSIA_ARCHIVE?)", file=sys.stderr)
        raise SystemExit(2)
    key = {"v": CACHE_VERSION, "months": list(months),
           "files": [[os.path.basename(f), os.path.getsize(f)] for f in files]}
    if use_cache and os.path.exists(cache):
        try:
            cached = json.load(open(cache, encoding="utf-8"))
        except (OSError, ValueError):
            cached = None
        if cached and cached.get("key") == key:
            return cached["msgs"], "cache", len(files), 0
    raw, failed = [], 0
    for f in files:
        try:
            raw.extend(parse(f, FILE_RE.match(os.path.basename(f)).group("ws")))
        except OSError:
            failed += 1
    # The same message reappears in overlapping archives; key it by content.
    seen, uniq = set(), []
    for m in raw:
        k = (m["ws"], m["ts"], m["machine"], m["body"][:80])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(m)
    if failed == 0:  # a partial corpus is never cached (CR #333 B3)
        try:
            json.dump({"key": key, "msgs": uniq},
                      open(cache, "w", encoding="utf-8"))
        except OSError:
            pass
    return uniq, "disk", len(files), failed


def format_dist(dist):
    """`k:count` for k <= 8 then `9+` summing k >= 9: a message naming exactly
    nine numbers belongs in 9+ (the pre-CR `k > 9` dropped it silently)."""
    line = " ".join(f"{k}:{dist[k]}" for k in sorted(dist) if k <= 8)
    tail = sum(v for k, v in dist.items() if k >= 9)
    if tail:
        line = (line + " " if line else "") + f"9+:{tail}"
    return line


def coverage(pairs, coord_nums, windows):
    """THE coverage statistic, computed once and reused by the measured pass
    and both nulls — the null is the same predicate or it is not a control."""
    cov = {w: 0 for w in windows}
    delays = []
    for num, t in pairs:
        prior = [x for x in coord_nums.get(num, []) if x < t]
        if not prior:
            continue
        d = (t - max(prior)).total_seconds() / 60
        delays.append(d)
        for w in windows:
            if d <= w:
                cov[w] += 1
    return cov, delays


def null_random_times(pairs, coord_nums, lo, span, rng, k_draws, windows):
    """NULL-A: each claim time redrawn uniformly in the month. Controls volume
    only — NOT co-activity (the coordinator posts while lanes work). Returns
    {window: [RATE per draw]} — coverage() yields counts; a null reporting
    counts above 100% on a small corpus is exactly the drift this comment
    prevents."""
    n = max(len(pairs), 1)
    out = {w: [] for w in windows}
    for _ in range(k_draws):
        drawn = [(num, lo + timedelta(seconds=rng.random() * span))
                 for num, _ in pairs]
        cov, _ = coverage(drawn, coord_nums, windows)
        for w in windows:
            out[w].append(cov[w] / n)
    return out


def null_number_shuffle(pairs, coord_nums, rng, k_draws, windows):
    """NULL-B: claim times kept, numbers permuted among them. Keeps the
    co-activity structure, breaks the number->response pairing."""
    n = max(len(pairs), 1)
    nums = [num for num, _ in pairs]
    times = [t for _, t in pairs]
    out = {w: [] for w in windows}
    for _ in range(k_draws):
        perm = nums[:]
        rng.shuffle(perm)
        cov, _ = coverage(list(zip(perm, times)), coord_nums, windows)
        for w in windows:
            out[w].append(cov[w] / n)
    return out


def pct(sorted_vals, q):
    return sorted_vals[min(len(sorted_vals) - 1, int(len(sorted_vals) * q))]


def wilson(k, n, z=1.96):
    """Wilson 95% interval for k/n, in percent — the measured share carries
    sampling noise the permutation band knows nothing about."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (100 * max(0.0, c - h), 100 * min(1.0, c + h))


def ratio_suffix(m_rate, mean, blo, bhi, n):
    """measured/control ratio with its interval. The control band can TOUCH 0
    (most draws find no prior dispatch at <=30m) while its mean is positive:
    dividing by the 0 endpoint would crash — the real 2026-07 CoursIA corpus
    hit exactly that on first run — so the upper bound becomes an open '>'.
    Endpoints are inverted on purpose: a HIGH control bound gives the LOW
    ratio bound. A thin corpus (n < 10) says so: a 100.0 ratio on n=1 is a
    coin flip, not a finding."""
    if mean <= 0:
        return " -> ratio n/a (control 0)"
    r = m_rate / mean
    thin = f" [n={n} thin]" if n < 10 else ""
    if blo > 0 and bhi > 0:
        return f" -> ratio {r:.1f} [{m_rate/bhi:.1f}-{m_rate/blo:.1f}]{thin}"
    if bhi > 0:
        return (f" -> ratio {r:.1f} [>{m_rate/bhi:.1f}]"
                f"{thin} (control band touches 0)")
    # Thin-corpus shape (real: CoursIA-2 2026-09, n=25): even the 97.5th
    # percentile of the control is 0 — the ratio against the mean is the only
    # figure left and its interval is unbounded on both ends.
    return f" -> ratio {r:.1f}{thin} (control band ~0: p97.5=0)"


def claim_events(claims):
    """Claim messages -> (num, dt, machine) events, dropping protocol quotes:
    a marker hit inside a backtick span is rule text, not a lane claiming."""
    out = []
    for c in claims:
        m = CLAIM_RE.search(c["body"])
        if not m or not m.group(1):
            continue
        if any(b.start() < m.start() < b.end() for b in BT_RE.finditer(c["body"])):
            continue
        out.append((int(m.group(1)), c["dt"], c["machine"]))
    return out


def select_pairs(events):
    """Events -> (raw_pairs, first_pairs, drops). raw keeps every numbered
    claim (pre-CR definition, continuity of the published share); first keeps
    only the FIRST claim per (machine, #NN) from non-coordinator machines —
    later repeats are ACKs/reports, not dispatch answers. `events` must be
    chronologically sorted."""
    raw = [(num, dt) for num, dt, _ in events]
    seen, first, drops = set(), [], {"coord": 0, "repeat": 0}
    for num, dt, machine in events:
        if machine == COORD:
            drops["coord"] += 1
            continue
        k = (machine, num)
        if k in seen:
            drops["repeat"] += 1
            continue
        seen.add(k)
        first.append((num, dt))
    return raw, first, drops


def main(argv=None, arch=None, cache=None):
    months, no_cache = parse_args(
        sys.argv[1:] if argv is None else argv)
    msgs, provenance, n_files, failed = load(
        months, not no_cache, arch=arch, cache=cache)
    print(f"corpus: {n_files} files, "
          f"{'cache hit' if provenance == 'cache' else 'read from disk'} "
          f"(COURSIA_ARCHIVE={arch or ARCH})")
    if failed:
        print(f"WARNING: {failed} archive file(s) unreadable — results are "
              f"PARTIAL and were not cached", file=sys.stderr)
    if not msgs:
        print("0 messages parsed — refusing to measure nothing",
              file=sys.stderr)
        raise SystemExit(2)
    for m in msgs:
        m["dt"] = datetime.fromisoformat(m["ts"])
    per = defaultdict(list)
    for m in msgs:
        per[(m["ws"], m["dt"].strftime("%Y-%m"))].append(m)

    for ws in WORKSPACES:
        for mo in months:
            mm = sorted(per.get((ws, mo), []), key=lambda x: x["dt"])
            if not mm:
                print(f"=== {ws} | {mo}: no messages ===")
                continue
            # Seed PER CELL (CR #333 B2): the draws of one cell must not
            # depend on which other cells ran before it.
            rng = random.Random(f"{SEED}|{ws}|{mo}")
            lo, hi = mm[0]["dt"], mm[-1]["dt"]
            span = (hi - lo).total_seconds()
            coord = [x for x in mm if x["machine"] == COORD]
            coord_nums = defaultdict(list)
            for x in coord:
                for n in set(NUM_RE.findall(x["body"])):
                    coord_nums[int(n)].append(x["dt"])
            claims = [x for x in mm if CLAIM_RE.search(x["body"])]

            print(f"=== {ws} | {mo} — {len(mm)} msgs | coordinator {len(coord)} "
                  f"| claims {len(claims)} ({100*len(claims)/max(len(mm),1):.1f}% of msgs) ===")
            dist = Counter(len(set(NUM_RE.findall(x["body"]))) for x in coord)
            print("  distinct #NN per coordinator msg: " + format_dist(dist))
            ge3 = sum(1 for x in coord if len(set(NUM_RE.findall(x["body"]))) >= 3)
            print(f"  coordinator msgs naming >=3 distinct #NN: {ge3}/{len(coord)} "
                  f"({100*ge3/max(len(coord),1):.1f}%)")
            lane_claims = Counter(x["machine"] for x in claims)
            print("  claims by lane: " + ", ".join(f"{k}:{v}" for k, v in lane_claims.most_common(6)))

            events = claim_events(claims)
            raw_pairs, first_pairs, drops = select_pairs(events)
            nq = len([c for c in claims if CLAIM_RE.search(c["body"]).group(1)])
            n_bt = nq - len(events)
            print(f"  selection: raw {len(raw_pairs)} numbered claims -> "
                  f"first {len(first_pairs)} (dropped: {n_bt} backquoted "
                  f"protocol quotes, {drops['coord']} coordinator, "
                  f"{drops['repeat']} repeats)")

            cov_raw, delays = coverage(raw_pairs, coord_nums, WINDOWS)
            n_raw = max(len(raw_pairs), 1)
            w30 = wilson(cov_raw[30], len(raw_pairs))
            print(f"  [measured raw] n={len(raw_pairs)}: " +
                  "  ".join(f"<={w}m {100*cov_raw[w]/n_raw:.1f}%" for w in WINDOWS) +
                  f"  (<=30m Wilson 95% [{w30[0]:.1f}-{w30[1]:.1f}])")
            cov_first, delays_first = coverage(first_pairs, coord_nums, WINDOWS)
            n_first = max(len(first_pairs), 1)
            wf30 = wilson(cov_first[30], len(first_pairs))
            print(f"  [measured first] n={len(first_pairs)}: " +
                  "  ".join(f"<={w}m {100*cov_first[w]/n_first:.1f}%" for w in WINDOWS) +
                  f"  (<=30m Wilson 95% [{wf30[0]:.1f}-{wf30[1]:.1f}])")
            if delays:
                delays.sort()
                print(f"    delay claim-after-dispatch p50={pct(delays,.5):.0f}m "
                      f"p90={pct(delays,.9):.0f}m")

            # Both nulls draw from the same per-cell rng, in a fixed order.
            nulls = [
                ("random times",
                 null_random_times(raw_pairs, coord_nums, lo, span, rng,
                                   K_DRAWS, WINDOWS)),
                ("number shuffle",
                 null_number_shuffle(raw_pairs, coord_nums, rng,
                                     K_DRAWS, WINDOWS)),
            ]
            for label, ctrl in nulls:
                parts = []
                for w in WINDOWS:
                    v = sorted(ctrl[w])
                    mean = sum(v) / len(v)
                    blo, bhi = pct(v, .025), pct(v, .975)
                    s = f"<={w}m {100*mean:.1f}% [{100*blo:.1f}-{100*bhi:.1f}]"
                    s += ratio_suffix(cov_raw[w] / n_raw, mean, blo, bhi,
                                      len(raw_pairs))
                    parts.append(s)
                print(f"  [NULL-{label[0].upper()}: {label}, {K_DRAWS} draws, "
                      f"ratio vs RAW] " + "  ".join(parts))
            print()
    if failed:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
