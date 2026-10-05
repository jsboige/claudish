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
naming its number. The share is therefore reported next to a PERMUTATION
CONTROL — the same statistic computed against randomly drawn times in the same
month. Only the gap between measured and control is interpretable, and the
control is K draws (default 200, fixed seed) with its 2.5-97.5% band: a single
draw (the pre-CR form) is one sample of that band, and ratios built on it are
noise (CR 5985488019 B2).

Second trap, flag-don't-assert: `[CLAIMED]` is a PROTOCOL MARKER, and a change
in its prevalence is not a change in behaviour. July shows 15.2% of all messages
carrying the marker against 4.7% in September; that can be a reporting-convention
shift rather than more grains claimed. The script prints it, it does not
interpret it.

Third trap, scope (same CR, B1): the glob `workspace-CoursIA-*.md` matches
CoursIA, CoursIA-2 AND CoursIA-3 — three workspaces with distinct lane
dynamics — plus annex tables (`-issue-debt-ledger`, `-forks-retrait`) that name
issue numbers by construction, and Drive-duplicate ` (1)` names. File selection
is an exact-anchored regex instead, and EVERY output is ventilated per
workspace; the headline workspace is CoursIA alone (the user's scope).

Fourth trap, the cache (same CR, B3): a key on months alone freezes a month
still being written and serves the first corpus silently after any re-scope.
The key is therefore the retained file list (name + size), and the header
prints the provenance (cache or disk) and the file count.

Usage:
  python scripts/coursia-dispatch-form.py [month ...] [--no-cache]
                                          # default 2026-07 2026-09
  COURSIA_ARCHIVE=<dir> python scripts/coursia-dispatch-form.py
"""
import glob
import json
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


def load(months, use_cache=True):
    """Returns (msgs, provenance, n_files). The cache key is the RETAINED file
    list (name + size), not the months: a month still being written or a
    re-scoped glob must not serve a stale corpus silently (CR B3)."""
    files = select_files(ARCH, months)
    key = {"months": list(months),
           "files": [[os.path.basename(f), os.path.getsize(f)] for f in files]}
    if use_cache and os.path.exists(CACHE):
        try:
            cached = json.load(open(CACHE, encoding="utf-8"))
        except (OSError, ValueError):
            cached = None
        if cached and cached.get("key") == key:
            return cached["msgs"], "cache", len(files)
    raw = []
    for f in files:
        try:
            raw.extend(parse(f, FILE_RE.match(os.path.basename(f)).group("ws")))
        except OSError:
            pass
    # The same message reappears in overlapping archives; key it by content.
    seen, uniq = set(), []
    for m in raw:
        k = (m["ws"], m["ts"], m["machine"], m["body"][:80])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(m)
    try:
        json.dump({"key": key, "msgs": uniq}, open(CACHE, "w", encoding="utf-8"))
    except OSError:
        pass
    return uniq, "disk", len(files)


def format_dist(dist):
    """`k:count` for k <= 8 then `9+` summing k >= 9: a message naming exactly
    nine numbers belongs in 9+ (the pre-CR `k > 9` dropped it silently)."""
    line = " ".join(f"{k}:{dist[k]}" for k in sorted(dist) if k <= 8)
    tail = sum(v for k, v in dist.items() if k >= 9)
    if tail:
        line = (line + " " if line else "") + f"9+:{tail}"
    return line


def control_rates(pairs, coord_nums, lo, span, rng, k_draws, windows):
    """K-draw permutation control (CR B2): for each draw, every claim time is
    replaced by a uniform random time in the same span and the SAME coverage
    statistic is computed. Returns {window: [rate per draw]} — report the mean
    with the 2.5-97.5 percentiles; one draw is one sample of that band."""
    n = max(len(pairs), 1)
    out = {w: [] for w in windows}
    for _ in range(k_draws):
        cov = {w: 0 for w in windows}
        for num, t in pairs:
            t2 = lo + timedelta(seconds=rng.random() * span)
            prior = [x for x in coord_nums.get(num, []) if x < t2]
            if not prior:
                continue
            d = (t2 - max(prior)).total_seconds() / 60
            for w in windows:
                if d <= w:
                    cov[w] += 1
        for w in windows:
            out[w].append(cov[w] / n)
    return out


def pct(sorted_vals, q):
    return sorted_vals[min(len(sorted_vals) - 1, int(len(sorted_vals) * q))]


def ratio_suffix(m_rate, mean, blo, bhi):
    """measured/control ratio with its interval. The control band can TOUCH 0
    (most draws find no prior dispatch at <=30m) while its mean is positive:
    dividing by the 0 endpoint would crash — the real 2026-07 CoursIA corpus
    hit exactly that on first run — so the upper bound becomes an open '>'.
    Endpoints are inverted on purpose: a HIGH control bound gives the LOW
    ratio bound."""
    if mean <= 0:
        return " -> ratio n/a (control 0)"
    r = m_rate / mean
    if blo > 0 and bhi > 0:
        return f" -> ratio {r:.1f} [{m_rate/bhi:.1f}-{m_rate/blo:.1f}]"
    if bhi > 0:
        return f" -> ratio {r:.1f} [>{m_rate/bhi:.1f}] (control band touches 0)"
    # Thin-corpus shape (real: CoursIA-2 2026-09, n=25): even the 97.5th
    # percentile of the control is 0 — the ratio against the mean is the only
    # figure left and its interval is unbounded on both ends.
    return f" -> ratio {r:.1f} (control band ~0: p97.5=0)"


def main():
    args = sys.argv[1:]
    use_cache = "--no-cache" not in args
    months = [a for a in args if not a.startswith("-")] or list(MONTHS)
    msgs, provenance, n_files = load(months, use_cache)
    print(f"corpus: {n_files} files, "
          f"{'cache hit' if provenance == 'cache' else 'read from disk'} "
          f"(COURSIA_ARCHIVE={ARCH})")
    for m in msgs:
        m["dt"] = datetime.fromisoformat(m["ts"])
    per = defaultdict(list)
    for m in msgs:
        per[(m["ws"], m["dt"].strftime("%Y-%m"))].append(m)
    rng = random.Random(SEED)

    for ws in WORKSPACES:
        for mo in months:
            mm = sorted(per.get((ws, mo), []), key=lambda x: x["dt"])
            if not mm:
                print(f"=== {ws} | {mo}: no messages ===")
                continue
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

            pairs = [(int(CLAIM_RE.search(c["body"]).group(1)), c["dt"])
                     for c in claims if CLAIM_RE.search(c["body"]).group(1)]
            cov, delays = {w: 0 for w in WINDOWS}, []
            for num, t in pairs:
                prior = [x for x in coord_nums.get(num, []) if x < t]
                if not prior:
                    continue
                d = (t - max(prior)).total_seconds() / 60
                delays.append(d)
                for w in WINDOWS:
                    if d <= w:
                        cov[w] += 1
            n = max(len(pairs), 1)
            print(f"  [measured] n={len(pairs)}: " +
                  "  ".join(f"<={w}m {100*cov[w]/n:.1f}%" for w in WINDOWS))
            if delays:
                delays.sort()
                print(f"    delay claim-after-dispatch p50={pct(delays,.5):.0f}m "
                      f"p90={pct(delays,.9):.0f}m")

            ctrl = control_rates(pairs, coord_nums, lo, span, rng, K_DRAWS, WINDOWS)
            parts = []
            for w in WINDOWS:
                v = sorted(ctrl[w])
                mean = sum(v) / len(v)
                blo, bhi = pct(v, .025), pct(v, .975)
                s = f"<={w}m {100*mean:.1f}% [{100*blo:.1f}-{100*bhi:.1f}]"
                s += ratio_suffix(cov[w] / n, mean, blo, bhi)
                parts.append(s)
            print(f"  [CONTROL random times, {K_DRAWS} draws] " + "  ".join(parts))
            print()


if __name__ == "__main__":
    main()
