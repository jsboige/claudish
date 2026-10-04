#!/usr/bin/env python3
"""coursia-dispatch-form.py — who opens the grain: the coordinator or the lane?

Measures the FORM of the CoursIA coordinator's dispatch, July vs September 2026,
from the shared-state archive of that workspace's dashboards. Read-only, and no
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
month. Only the gap between measured and control is interpretable.

Second trap, flag-don't-assert: `[CLAIMED]` is a PROTOCOL MARKER, and a change
in its prevalence is not a change in behaviour. July shows 15.2% of all messages
carrying the marker against 4.7% in September; that can be a reporting-convention
shift rather than more grains claimed. The script prints it, it does not
interpret it.

Usage:
  python scripts/coursia-dispatch-form.py [month ...]      # default 2026-07 2026-09
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
WINDOWS = [30, 120, 360, 1440]
MONTHS = ["2026-07", "2026-09"]
SEED = 20261005


def month_of(name):
    m = re.search(r"-(\d{4})-(\d{2})-\d{2}T", name)
    return f"{m.group(1)}-{m.group(2)}" if m else "?"


def parse(path):
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
        out.append({"ts": dt.isoformat(), "machine": m.group(2),
                    "body": txt[m.end():end][:4000]})
    return out


def load(months):
    key = {"months": months}
    if os.path.exists(CACHE):
        cached = json.load(open(CACHE, encoding="utf-8"))
        if cached.get("key") == key:
            return cached["msgs"]
    files = [f for f in glob.glob(os.path.join(ARCH, "workspace-CoursIA-*.md"))
             if month_of(os.path.basename(f)) in months]
    raw = []
    for f in sorted(files):
        try:
            raw.extend(parse(f))
        except OSError:
            pass
    # The same message reappears in overlapping archives; key it by content.
    seen, uniq = set(), []
    for m in raw:
        k = (m["ts"], m["machine"], m["body"][:80])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(m)
    json.dump({"key": key, "msgs": uniq}, open(CACHE, "w", encoding="utf-8"))
    return uniq


def main():
    months = sys.argv[1:] or MONTHS
    msgs = load(months)
    for m in msgs:
        m["dt"] = datetime.fromisoformat(m["ts"])
    per_month = defaultdict(list)
    for m in msgs:
        per_month[m["dt"].strftime("%Y-%m")].append(m)
    rng = random.Random(SEED)

    for mo in months:
        mm = sorted(per_month.get(mo, []), key=lambda x: x["dt"])
        if not mm:
            print(f"=== {mo}: no messages ===")
            continue
        lo, hi = mm[0]["dt"], mm[-1]["dt"]
        span = (hi - lo).total_seconds()
        coord = [x for x in mm if x["machine"] == COORD]
        coord_nums = defaultdict(list)
        for x in coord:
            for n in set(NUM_RE.findall(x["body"])):
                coord_nums[int(n)].append(x["dt"])
        claims = [x for x in mm if CLAIM_RE.search(x["body"])]

        print(f"=== {mo} — {len(mm)} msgs | coordinator {len(coord)} | claims {len(claims)} "
              f"({100*len(claims)/max(len(mm),1):.1f}% of msgs) ===")
        dist = Counter(len(set(NUM_RE.findall(x["body"]))) for x in coord)
        print("  distinct #NN per coordinator msg: " +
              " ".join(f"{k}:{dist[k]}" for k in sorted(dist) if k <= 8) +
              (f" 9+:{sum(v for k, v in dist.items() if k > 9)}" if any(k > 9 for k in dist) else ""))
        ge3 = sum(1 for x in coord if len(set(NUM_RE.findall(x["body"]))) >= 3)
        print(f"  coordinator msgs naming >=3 distinct #NN: {ge3}/{len(coord)} "
              f"({100*ge3/max(len(coord),1):.1f}%)")
        lane_claims = Counter(x["machine"] for x in claims)
        print("  claims by lane: " + ", ".join(f"{k}:{v}" for k, v in lane_claims.most_common(6)))

        pairs = [(int(CLAIM_RE.search(c["body"]).group(1)), c["dt"])
                 for c in claims if CLAIM_RE.search(c["body"]).group(1)]
        for label, randomize in (("measured", False), ("CONTROL random times", True)):
            cov = {w: 0 for w in WINDOWS}
            delays = []
            for num, t in pairs:
                if randomize:
                    t = lo + timedelta(seconds=rng.random() * span)
                prior = [x for x in coord_nums.get(num, []) if x < t]
                if not prior:
                    continue
                d = (t - max(prior)).total_seconds() / 60
                delays.append(d)
                for w in WINDOWS:
                    if d <= w:
                        cov[w] += 1
            n = max(len(pairs), 1)
            print(f"  [{label}] n={len(pairs)}: " +
                  "  ".join(f"<={w}m {100*cov[w]/n:.1f}%" for w in WINDOWS))
            if delays and not randomize:
                delays.sort()
                p = lambda q: delays[min(len(delays) - 1, int(len(delays) * q))]
                print(f"    delay claim-after-dispatch p50={p(.5):.0f}m p90={p(.9):.0f}m")
        print()


if __name__ == "__main__":
    main()
