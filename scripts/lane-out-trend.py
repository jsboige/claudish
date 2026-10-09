#!/usr/bin/env python3
r"""All-lane IN/OUT-token trend — "what do we READ and what do we GENERATE, per day?"

Generalizes native-trend.py beyond the native lane: the user's productivity
metric is tokens generated per merged PR, fleet-wide — not $ extrapolated from
the PAYG overflow (subscriptions OpenAI/Kimi/Qwen/Mistral invalidate any such
extrapolation; the PAYG is the overflow, not the spend).

Since the #328 cost-post mandate (08/10) it also prints the INPUT side and the
cached share, because the two posts answer to different levers: IN is what the
conversation re-reads each turn (the harness floor lives there), OUT is what
the agent produces (coordination round-trips and CI/review churn act there).

    python scripts/lane-out-trend.py --days 2026-07-05 2026-09-30 2026-10-06
        [--archives-dir "G:\\Mon Drive\\Backups-Cloud\\claudish"]
        [--7z "D:\\PortableApps\\PortableApps\\7-ZipPortable\\App\\7-Zip64\\7z.exe"]

Every resp-*.sse capture is Anthropic-wire regardless of upstream provider
(captures sit downstream of translation), so one usage reader covers all lanes.

It reads the wire as JSON, LINE BY LINE, and never as a brace-delimited
regex (ai-01 review #414, measured 2026-10-09): every Anthropic-native `usage`
object contains a NESTED object — `cache_creation` (the 5m/1h split) on
message_start, `output_tokens_details` and `iterations[]` on the terminal
message_delta — so `"usage":\s*\{[^{}]*\}` matched **0 of 123** native captures
while matching all 477 openai ones, dropping the whole native lane into
`sansUsage` (its OUT with it — the lane where OUT is money) without a word.

Files with no usage statement are counted separately (`sansUsage`), never
dropped silently (the Sol lane had partial usage until #117). A file that
CONTAINS `"usage"` but from which no block could be read is NOT that case: it
is a parser failure (`parseFail`), counted apart, warned per lane, and it makes
the run exit non-zero — an instrument that absorbs its own blind spot reports
an absence it never measured.

Input-side aggregation selects ONE usage object per capture and keeps it
WHOLE — per-field aggregation is forbidden (measured twice now):

    era     handler     sampled  first==0   sum(first)     sum(last)
    07-05   openai          40    40/40             0      5,292,758
    07-05   anthropic       40    40/40             0        828,682
    09-30   openai          40     0/40     6,862,799        201,687
    09-30   anthropic       40    34/40       760,117         56,164

A capture carries `input_tokens` in several usage objects (message_start
states the request's context; the terminal message_delta repeats the three
input counters with the cache split applied — #179 clamps them so the three
always sum back to prompt_tokens), and the two eras put the real value in
OPPOSITE slots: July's message_start carries an explicit `input_tokens: 0`,
while on the OpenAI wire September's message_delta carries a small residue.
Positional reads therefore fail one era each: `[0]` read zero for every
openai- and anthropic-wire capture of July and reported `IN total x6064` —
a parser artefact dressed as a finding; `[-1]` fails the mirror way
(5,042 tok/resp on September's openai lane against a real ~170k). And
per-field MAX fails a THIRD way, measured 2026-10-09 (ai-01 review #414) on
the hub's resp-r11463 (2026-09-30): message_start says (244812, 0, 0) while
the terminal delta says (67, 244800, 0) — independent maxima read ctx=489612
where the coherent terminal triple is 244867. The cache split MOVED the mass
into cache_read between the two blocks; it did not double the context.

Selection policy: the TERMINAL usage object with a non-empty input statement
(in+cr+cc > 0) wins, kept as a whole (in, cr, cc) triple. If the stream died
before any such statement (message_start only), that block's own triple
stands in — coherently, never mixed. A capture whose usage objects are all
zero-seeded carries NO input statement: it is counted in `sansInput`, never
as zero context. The cache split is known only when the CHOSEN block is a
measured one: a block that omits the cache counters, or the stream's first
block (message_start seeds both at an explicit 0 — #179 — the split is
applied on the terminal message_delta), has an UNKNOWN split. It still
counts toward ctx and IN, but is excluded from the cache share: `%cache` is
computed only over responses with a measured split, and `ckResp` is that
denominator. A missing cache report is unknown, not zero.

IN and ctx are CONTEXT ACCOUNTING, not euros: what each turn re-reads. Cache
pricing is provider-specific and deliberately not modeled here — per-provider
money lives in the #405 ledgers. OUT keeps the LAST output_tokens, which is
the terminal cumulative output (it only grows, so it equals max() there —
but the contract is "terminal", not "largest").

Lane groups are imported from fleet-dashboard.py — one shared definition, no
drift between the two scripts.

Heavier than native-trend (~30k resp/day vs ~2-5k native): run off-peak.
"""
import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict

NAME_RX = re.compile(
    r"resp-\S+?-(\d{4}-\d{2}-\d{2})T\d{2}[\d-]+Z-(\w+)-(.+)\.sse$"
)
# Raw-text probe only: "does this file talk about usage at all". Never used to
# EXTRACT a block — that is scan_usage's job, and the difference between the two
# is exactly what `parseFail` measures.
RAW_USAGE = '"usage"'


def load_groups():
    """Import LANE_GROUPS/group_of from fleet-dashboard.py (dashed filename:
    not importable as a module name — spec_from_file_location it)."""
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "fleet_dashboard", os.path.join(here, "fleet-dashboard.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.LANE_GROUPS, mod.group_of


def scan_usage(rt):
    """(blocks, line_fail) — every usage object in file order, each as ONE
    coherent snapshot, plus the count of usage-bearing lines that would not
    decode.

    Parsed as JSON, one `data:` line at a time. A brace-delimited regex cannot
    see a nested object, and every native Anthropic usage object has one
    (review #414, measured on the hub: 0/123 native vs 477/477 openai) — the
    same wire the passthrough forwards, so this is a reading of the format, not
    a heuristic over it.

    `iterations[]` entries carry their OWN `input_tokens`: they belong to an
    iteration, never to the request's triple, so ONLY the top-level object is
    read — `.usage` on message_delta, `.message.usage` on message_start. JSON
    gives that for free; a flat key scan over the raw text would not.

    The three input counters of a block were emitted together (upstream, or by
    our splitPromptTokens — #179), so a block is the unit of truth. Mixing
    fields from different blocks doubles the context: measured on the hub's
    resp-r11463, message_start (244812, 0, 0) + terminal delta (67, 244800, 0)
    -> per-field maxima read 489612 where the coherent terminal triple is
    244867."""
    blocks = []
    line_fail = 0
    for line in rt.split("\n"):
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if not payload or RAW_USAGE not in payload:
            continue
        try:
            obj = json.loads(payload)
        except ValueError:
            # A usage-bearing line we could not decode: COUNTED, never
            # dropped. stats() turns "usage present, nothing parsed" into
            # parseFail.
            line_fail += 1
            continue
        if not isinstance(obj, dict):
            continue
        usage = obj.get("usage")
        if not isinstance(usage, dict):
            message = obj.get("message")
            usage = message.get("usage") if isinstance(message, dict) else None
        if not isinstance(usage, dict):
            continue

        def val(key):
            v = usage.get(key)
            return v if isinstance(v, int) else None

        i, cr, cc, out = (val("input_tokens"), val("cache_read_input_tokens"),
                          val("cache_creation_input_tokens"),
                          val("output_tokens"))
        blocks.append({
            "in": i or 0,
            "cr": cr or 0,
            "cc": cc or 0,
            "out": out or 0,
            "idx": len(blocks),
            # a counter ABSENT from the block is unknown, not zero — and so
            # are the counters of the stream's FIRST block: message_start
            # seeds both cache counters at an explicit 0 (#179), so only a
            # block reporting the counters AND sitting after the start
            # (a message_delta) carries a measured split
            "cache_known": len(blocks) > 0 and cr is not None and cc is not None,
            "has_out": out is not None,
        })
    return blocks, line_fail


def usage_blocks(rt):
    """Blocks only — the entry point the review called directly."""
    return scan_usage(rt)[0]


def select_usage(blocks):
    """Selection policy (ai-01 review #414): terminal valid usage preferred,
    coherent fallback for incomplete stream, never a mix.

    The LAST block with a non-empty input statement (in+cr+cc > 0) is the
    request's authoritative accounting — on a complete stream that is the
    terminal message_delta, whose triple sums to prompt_tokens (#179). If
    the stream died before it, message_start's statement stands in. Returns
    (chosen_or_None, terminal_out): output is the last output_tokens seen,
    the terminal cumulative value (None = no output statement at all)."""
    chosen = None
    out = 0
    saw_out = False
    for b in blocks:
        if b["has_out"]:
            out = b["out"]
            saw_out = True
        if b["in"] + b["cr"] + b["cc"] > 0:
            chosen = b
    return chosen, (out if saw_out else None)


def verdict_exit_code(any_parse_fail):
    """0 = the table may be published, 2 = the reader has a blind spot.

    Separated from main() so the "refuse rather than absorb" rule is a pinned
    unit, not a branch buried behind 7z extraction (review #414 point 3)."""
    return 2 if any_parse_fail else 0


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
        lambda: {"n": 0, "out": 0, "in": 0, "ctx": 0, "cr": 0, "cc": 0,
                 "ctx_ck": 0, "n_ck": 0, "no_input": 0, "no_usage": 0,
                 "parse_fail": 0, "line_fail": 0})
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
        blocks, line_fail = scan_usage(rt)
        row["line_fail"] += line_fail
        if not blocks and RAW_USAGE in rt:
            # The file TALKS about usage and we read none of it: that is a
            # parser failure, not an absent statement. Absorbing it here is
            # exactly how a regex blind to nested objects erased 123/123
            # native captures (review #414) while the table printed a clean
            # `sansUsage` column.
            row["parse_fail"] += 1
            continue
        chosen, out = select_usage(blocks)
        if out is None:
            row["no_usage"] += 1
            continue
        row["out"] += out
        if chosen is None:
            # every block zero-seeded: no input statement at all — unknown,
            # never zero
            row["no_input"] += 1
            continue
        row["in"] += chosen["in"]
        row["ctx"] += chosen["in"] + chosen["cr"] + chosen["cc"]
        if chosen["cache_known"]:
            row["cr"] += chosen["cr"]
            row["cc"] += chosen["cc"]
            row["ctx_ck"] += chosen["in"] + chosen["cr"] + chosen["cc"]
            row["n_ck"] += 1
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
          f"{'CR/ckResp':>10s} {'OUT/resp':>9s} {'%cache':>7s} {'ckResp':>7s} "
          f"{'OUT total':>12s}  "
          + " ".join(f"{g[:9]:>10s}" for g in groups)
          + f" {'sansUsage':>9s} {'sansInput':>9s} {'parseFail':>9s} {'lineFail':>8s}")
    parse_failed = False
    for day, per in results:
        tot = {k: sum(v[k] for v in per.values()) for k in
               ("n", "out", "in", "ctx", "cr", "ctx_ck", "n_ck",
                "no_input", "no_usage", "parse_fail", "line_fail")}
        # Loud, per lane: a lane whose usage could not be READ is not a lane
        # without usage, and the difference is the whole #414 defect.
        for g, row in per.items():
            if row["parse_fail"]:
                parse_failed = True
                print(f"[lane-out-trend] PARSE-FAIL {day} {g}: "
                      f"{row['parse_fail']} capture(s) contain \"usage\" but no "
                      f"block could be read — {g} is UNMEASURED for this day, "
                      f"not empty", file=sys.stderr)
        for g, row in per.items():
            if row["line_fail"]:
                print(f"[lane-out-trend] WARN {day} {g}: "
                      f"{row['line_fail']} usage-bearing data line(s) did not "
                      f"decode as JSON", file=sys.stderr)
        n_in = tot["n"] - tot["no_input"]  # responses WITH an input statement
        pct = (100.0 * tot["cr"] / tot["ctx_ck"]) if tot["ctx_ck"] else 0.0
        cells = " ".join(
            f"{per[g]['out']:>10,d}" if per[g]["n"] else f"{'':>10s}"
            for g in groups)
        print(f"{day:12s} {tot['n']:>7,d} {tot['ctx'] // max(n_in,1):>9,d} "
              f"{tot['in'] // max(n_in,1):>9,d} "
              f"{tot['cr'] // max(tot['n_ck'],1):>10,d} "
              f"{tot['out'] // max(tot['n'],1):>9,d} {pct:>6.1f}% "
              f"{tot['n_ck']:>7,d} {tot['out']:>12,d}  {cells} "
              f"{tot['no_usage']:>9,d} {tot['no_input']:>9,d} "
              f"{tot['parse_fail']:>9,d} {tot['line_fail']:>8,d}")
    if len(results) >= 2:
        (d0, p0), (d1, p1) = results[0], results[-1]
        t0 = {k: sum(v[k] for v in p0.values()) for k in
              ("n", "out", "in", "ctx", "cr", "ctx_ck", "no_input")}
        t1 = {k: sum(v[k] for v in p1.values()) for k in
              ("n", "out", "in", "ctx", "cr", "ctx_ck", "no_input")}

        def share(t):
            return f"{100.0 * t['cr'] / t['ctx_ck']:.1f}%" if t["ctx_ck"] else "n/a"

        print()
        print(f"delta {d0} -> {d1}: OUT total x{t1['out'] / max(t0['out'], 1):.2f}  "
              f"ctx total x{t1['ctx'] / max(t0['ctx'], 1):.2f}  "
              f"resp x{t1['n'] / max(t0['n'], 1):.2f}")
        n0 = t0["n"] - t0["no_input"]
        n1 = t1["n"] - t1["no_input"]
        print(f"  per response: ctx {t0['ctx'] // max(n0,1):,} -> "
              f"{t1['ctx'] // max(n1,1):,}   "
              f"IN {t0['in'] // max(n0,1):,} -> {t1['in'] // max(n1,1):,}   "
              f"OUT {t0['out'] // max(t0['n'],1):,} -> {t1['out'] // max(t1['n'],1):,}   "
              f"cache {share(t0)} -> {share(t1)} (over split-reporting responses)")
        for g in groups:
            if p0[g]["out"] and p1[g]["out"]:
                print(f"  {g:16s} OUT {p0[g]['out']:>10,d} -> {p1[g]['out']:>10,d}  "
                      f"(x{p1[g]['out'] / p0[g]['out']:.2f})")
    if parse_failed:
        # Refuse the verdict rather than print a table whose blind spot the
        # reader cannot see. Exit 2, distinct from "no capture at all" (1).
        print()
        print("REFUSING A VERDICT: at least one lane has captures carrying "
              "\"usage\" that this reader could not parse (see PARSE-FAIL "
              "lines above). Those captures are UNMEASURED — fix the reader "
              "before publishing any delta from this run.", file=sys.stderr)
    return verdict_exit_code(parse_failed)


if __name__ == "__main__":
    sys.exit(main())
