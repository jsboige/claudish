#!/usr/bin/env python3
"""All-lane IN/OUT-token trend — "what do we READ and what do we GENERATE, per day?"

Generalizes native-trend.py beyond the native lane: the user's productivity
metric is tokens generated per merged PR, fleet-wide — not $ extrapolated from
the PAYG overflow (subscriptions OpenAI/Kimi/Qwen/Mistral invalidate any such
extrapolation; the PAYG is the overflow, not the spend).

Since the #328 cost-post mandate (08/10) it also prints the INPUT side and the
cached share, because the two posts answer to different levers: IN is what the
harness costs per request (slimming acts there, but it is re-paid on every
turn), OUT is what the agent produces (coordination round-trips and CI/review
churn act there). %cached is the share of IN served from the prompt cache —
without it an IN total reads as new spend when most of it is a cache re-read.

    python scripts/lane-out-trend.py --days 2026-07-05 2026-09-30 2026-10-06
        [--archives-dir "G:\\Mon Drive\\Backups-Cloud\\claudish"]
        [--7z "D:\\PortableApps\\PortableApps\\7-ZipPortable\\App\\7-Zip64\\7z.exe"]

Every resp-*.sse capture is Anthropic-wire regardless of upstream provider
(captures sit downstream of translation), so one set of usage regexes covers
all lanes. Files with no usage block are counted separately, never dropped
silently (the Sol lane had partial usage until #117).

Aggregation of the input side is NOT positional — it takes the MAX of the
occurrences, and that is load-bearing (measured 2026-10-08, 07-05 vs 09-30):

    era     handler     sampled  first==0   sum(first)     sum(last)
    07-05   openai          40    40/40             0      5,292,758
    07-05   anthropic       40    40/40             0        828,682
    09-30   openai          40     0/40     6,862,799        201,687
    09-30   anthropic       40    34/40       760,117         56,164

A capture carries `input_tokens` twice (message_start states the request's
context, the terminal message_delta repeats the three input counters), and the
two eras put the real value in OPPOSITE slots: July's message_start carries an
explicit `input_tokens: 0`, while on the OpenAI wire September's message_delta
carries a small residue. `findall(...)[0]` therefore read ZERO for every
openai- and anthropic-wire capture of July and reported `IN total x6064` for a
fleet whose response count grew x3.41 — a parser artefact dressed as a finding.
`[-1]` fails the mirror way (5,042 tok/resp on September's openai lane against
a real ~170k). The input side is fixed at request time and repeated verbatim,
so max() recovers it in both eras; OUT keeps the LAST occurrence, which is the
terminal cumulative output (and equals max() there, since it only grows).

%cache is the share of the whole context served from the prompt cache —
cache_read / (input + cache_read + cache_creation) — and ctx/resp is that whole
context, i.e. the harness floor. Reporting an IN total without them invites
launching a slimming programme against tokens that are re-read, not re-paid.

Lane groups are imported from fleet-dashboard.py — one shared definition, no
drift between the two scripts.

Heavier than native-trend (~30k resp/day vs ~2-5k native): run off-peak.
"""
import argparse
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict

NAME_RX = re.compile(
    r"resp-\S+?-(\d{4}-\d{2}-\d{2})T\d{2}[\d-]+Z-(\w+)-(.+)\.sse$"
)
U_OUT = re.compile(r'"output_tokens":\s*(\d+)')
U_IN = re.compile(r'"input_tokens":\s*(\d+)')
U_CR = re.compile(r'"cache_read_input_tokens":\s*(\d+)')
U_CC = re.compile(r'"cache_creation_input_tokens":\s*(\d+)')


def load_groups():
    """Import LANE_GROUPS/group_of from fleet-dashboard.py (dashed filename:
    not importable as a module name — spec_from_file_location it)."""
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "fleet_dashboard", os.path.join(here, "fleet-dashboard.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.LANE_GROUPS, mod.group_of


def day_dir(day, a, root):
    d = os.path.join(root, "all-" + day)
    archive = os.path.join(a.archives_dir, "captures-%s.7z" % day)
    if not os.path.isfile(archive):
        print("archive absente: %s" % archive, file=sys.stderr)
        return None
    os.makedirs(d, exist_ok=True)
    subprocess.run([a.seven_z, "x", archive, "-o" + d, "resp-*.sse", "-y"],
                   check=True, stdout=subprocess.DEVNULL)
    return d


def stats(dirpath):
    per = defaultdict(
        lambda: {"n": 0, "out": 0, "in": 0, "cr": 0, "cc": 0, "no_usage": 0})
    for e in os.scandir(dirpath):
        n = e.name
        if not n.endswith(".sse"):
            continue
        m = NAME_RX.search(n)
        if not m:
            continue
        _, handler, model = m.groups()
        g = group_of(handler, model)
        row = per[g]
        row["n"] += 1
        try:
            rt = open(e.path, encoding="utf-8", errors="replace").read()
        except OSError:
            row["no_usage"] += 1
            continue
        mo = U_OUT.findall(rt)
        if not mo:
            row["no_usage"] += 1
            continue
        row["out"] += int(mo[-1])
        # max(), not [0] or [-1]: the real value sits in the first slot in one
        # era and the last in the other (see the docstring's measurement).
        mi = U_IN.findall(rt)
        row["in"] += max(int(x) for x in mi) if mi else 0
        mr = U_CR.findall(rt)
        row["cr"] += max(int(x) for x in mr) if mr else 0
        mc = U_CC.findall(rt)
        row["cc"] += max(int(x) for x in mc) if mc else 0
    return per


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--days", nargs="+", required=True)
    ap.add_argument("--archives-dir", default=r"G:\Mon Drive\Backups-Cloud\claudish")
    ap.add_argument("--7z", dest="seven_z",
                    default=r"C:\Program Files\NVIDIA Corporation\NVIDIA App\7z.exe")
    ap.add_argument("--keep", action="store_true")
    return ap.parse_args()


def main():
    global LANE_GROUPS, group_of
    a = parse_args()
    LANE_GROUPS, group_of = load_groups()
    root = os.getcwd() if a.keep else tempfile.mkdtemp(prefix="lane-out-")
    results = []
    for day in a.days:
        d = day_dir(day, a, root)
        if not d:
            continue
        per = stats(d)
        if not per:
            print(f"{day}: aucune capture resp-*", file=sys.stderr)
            continue
        results.append((day, per))
        print(f"  {day}: {sum(v['n'] for v in per.values()):,} resp lues", file=sys.stderr)
    if not results:
        return 1

    groups = [name for name, _, _ in LANE_GROUPS]
    print(f"{'jour':12s} {'resp':>7s} {'ctx/resp':>9s} {'IN/resp':>9s} "
          f"{'CR/resp':>9s} {'OUT/resp':>9s} {'%cache':>7s} {'OUT total':>12s}  "
          + " ".join(f"{g[:9]:>10s}" for g in groups) + f" {'sansUsage':>9s}")
    for day, per in results:
        tot_out = sum(v["out"] for v in per.values())
        tot_in = sum(v["in"] for v in per.values())
        tot_cr = sum(v["cr"] for v in per.values())
        tot_cc = sum(v["cc"] for v in per.values())
        tot_n = sum(v["n"] for v in per.values())
        no_u = sum(v["no_usage"] for v in per.values())
        cells = " ".join(
            f"{per[g]['out']:>10,d}" if per[g]["n"] else f"{'':>10s}"
            for g in groups)
        # ctx = the whole context re-read per request (harness floor);
        # %cache = the share of it that is a cheap re-read rather than new input.
        ctx = tot_in + tot_cr + tot_cc
        pct = (100.0 * tot_cr / ctx) if ctx else 0.0
        print(f"{day:12s} {tot_n:>7,d} {ctx // max(tot_n,1):>9,d} "
              f"{tot_in // max(tot_n,1):>9,d} {tot_cr // max(tot_n,1):>9,d} "
              f"{tot_out // max(tot_n,1):>9,d} {pct:>6.1f}% "
              f"{tot_out:>12,d}  {cells} {no_u:>9,d}")
    if len(results) >= 2:
        (d0, p0), (d1, p1) = results[0], results[-1]
        o0 = sum(v["out"] for v in p0.values())
        o1 = sum(v["out"] for v in p1.values())
        i0 = sum(v["in"] for v in p0.values())
        i1 = sum(v["in"] for v in p1.values())
        r0 = sum(v["cr"] for v in p0.values())
        r1 = sum(v["cr"] for v in p1.values())
        c0 = sum(v["cc"] for v in p0.values())
        c1 = sum(v["cc"] for v in p1.values())
        n0 = sum(v["n"] for v in p0.values())
        n1 = sum(v["n"] for v in p1.values())
        print()
        print(f"delta {d0} -> {d1}: OUT total x{o1 / max(o0, 1):.2f}  "
              f"ctx total x{(i1+r1+c1) / max(i0+r0+c0, 1):.2f}  "
              f"resp x{n1 / max(n0, 1):.2f}")
        print(f"  per response: ctx {(i0+r0+c0) // max(n0,1):,} -> "
              f"{(i1+r1+c1) // max(n1,1):,}   "
              f"IN {i0 // max(n0,1):,} -> {i1 // max(n1,1):,}   "
              f"OUT {o0 // max(n0,1):,} -> {o1 // max(n1,1):,}")
        for g in groups:
            if p0[g]["out"] and p1[g]["out"]:
                print(f"  {g:16s} OUT {p0[g]['out']:>10,d} -> {p1[g]['out']:>10,d}  "
                      f"(x{p1[g]['out'] / p0[g]['out']:.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
