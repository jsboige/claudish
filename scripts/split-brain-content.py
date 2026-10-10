#!/usr/bin/env python3
"""Content-level split-brain discriminator over hub request captures.

Complements `split-brain-scan.ps1` (which is host-level: live transcripts,
processes, scheduled tasks). This one answers the question a host scan cannot:
*inside one session_id, are two message sequences cohabiting?* — read from the
captured request bodies, not from the machine.

WHY CONTENT. The user directive (2026-10-09): when metadata cannot separate two
sequences under one lane, the content can. In Claude Code a conversation is
append-only, so a request's user-message history EXTENDS the previous one.

METHOD
  1. HARNESS = user-segment hashes whose DOCUMENT FREQUENCY over a broad sample
     exceeds a threshold. The harness (CLAUDE.md, memory, system-reminders) is
     re-injected into EVERY request; conversation turns are not.
  2. core(request) = its user-segment hashes with the harness set removed,
     ORDER PRESERVED (removal is positional, not by contiguous head).
  3. PARTITION the session's requests by `cc_is_subagent` — read from the
     cc_version metadata line, never from a bare grep of the file (see trap 4).
  4. CHAIN by containment within each partition: B extends A iff A.core is a
     prefix of B.core (append-only). Compaction restarts a chain (history is
     replaced); that is a SEQUENTIAL break, not a fork.
  5. A fork = two chains inside the SAME partition whose time ranges OVERLAP.

SIX MEASURED TRAPS (each produced a wrong answer before being fixed)
  T1  Chaining on ALL user segments: every request opens with the SAME harness
      head, so the containment test compares harness to harness and NO request
      ever extends another — every chain has depth 1.
  T2  Stripping a CONTIGUOUS head only: the harness injects a VARIABLE number
      of blocks and their POSITION shifts between requests, so harness blocks
      survive in the residual core; two consecutive requests of one thread then
      diverge on harness content and land in different chains. Every 'fork'
      this produced was same-machine / same-client — the tell that it was an
      artifact. Hence the document-frequency removal (step 1).
  T3  Short, recurring task prompts (a cron lane re-sends the same opening
      prompt each epoch) bucket unrelated epochs into one chain that spans
      hours. Require a DEEP residual core (default >= 8 segments).
  T4  `cc_is_subagent` appears as PLAIN TEXT in the fleet's own CLAUDE.md (it
      documents the 2026-08-10 leak), so `'cc_is_subagent' in raw` is true for
      almost every request. The real flag lives on the `cc_version=...` metadata
      line. Read THAT line, not the file.
  T5  THE one that matters: a Task sub-agent carries the PARENT's
      `metadata.user_id.session_id`. One session_id therefore legitimately holds
      the main conversation PLUS one disjoint conversation per concurrent
      sub-agent. Diffing raw content, that is indistinguishable from a fork —
      and a coordinator session with parallel sub-agents shows dozens of
      concurrent sub-chains. Partitioning by cc_is_subagent (step 3) is what
      separates them; without it the method cries split-brain on every
      coordinator lane.
  T6  The session id itself must be read by PARSING `body.metadata.user_id`
      (a nested JSON string), never by a raw regex over the file: an analysis
      session that CITES other sessions' ids in its message bodies (traffic
      work does, constantly) gets its own requests attributed to the cited
      id by a first-match regex — and a monotone chain from a second machine
      then reads as a cross-machine fork. Measured 2026-10-09: the instrument's
      only "SPLIT-BRAIN?" flag on a 43k-capture day was exactly this artifact.

Read-only. Exits 0 always (this is an observation instrument, not a gate).
"""
import argparse
import collections
import datetime
import glob
import hashlib
import json
import os
import re
import sys

CCVER_RE = re.compile(r"cc_version=[^\"\\]{0,240}")
SUB_RE = re.compile(r"cc_is_subagent=true")
DEFAULT_CAPTURES = r"D:\claudish-captures"
DEFAULT_HARNESS_DF = 0.10   # a hash in >=10% of sampled requests is harness
DEFAULT_MIN_CORE = 8        # a real conversation has deep residual history


def _block_hash(b):
    # cache_control (point 4, re-review #432): Claude Code re-anchors the cache
    # breakpoint at every request, so the SAME block carries a different
    # cache_control from one request to the next — hashed as-is it fragments
    # chains. Strip the key before hashing (measured 67/73 -> 72/73 consecutive
    # extensions on a 4.5k-request session; no effect on chain semantics).
    if isinstance(b, dict):
        b = {k: v for k, v in b.items() if k != "cache_control"}
    return hashlib.sha1(str(b)[:300].encode("utf-8", "replace")).hexdigest()[:10]


def segments_of(d):
    """Ordered hashes of a PARSED request's user-message segments."""
    msgs = (d.get("body") or {}).get("messages") or []
    out = []
    for m in msgs:
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            out.append(hashlib.sha1(("s" + c[:400]).encode("utf-8", "replace")).hexdigest()[:10])
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, dict):
                    out.append(_block_hash(b))
    return out


def user_segments(path):
    """Parse-and-extract wrapper (harness sampling reads files on its own;
    callers there hold it under try — the main loop uses segments_of on the
    dict it already parsed so a bad capture can never drop the run)."""
    with open(path, encoding="utf-8", errors="strict") as fh:
        return segments_of(json.load(fh))


def is_subagent(raw):
    """T4 — the flag lives on the cc_version metadata line, not anywhere in the file."""
    flag = False
    for m in CCVER_RE.finditer(raw):
        flag = bool(SUB_RE.search(m.group(0)))
    return flag


def secs(ts):
    t = ts[11:19].replace("-", ":")
    h, m, s = (int(x) for x in t.split(":"))
    return h * 3600 + m * 60 + s


def build_harness(paths, limit, df_threshold):
    df = collections.Counter()
    seen = 0
    # limit <= 0 = sample every path (same escape hatch as --max-samples 0;
    # a naive `len // limit` would ZeroDivisionError there).
    step = max(1, len(paths) // limit) if limit > 0 else 1
    sample = paths[::step][:limit] if limit > 0 else paths[::step]
    for p in sample:
        if not os.path.exists(p):
            continue
        try:
            seg = set(user_segments(p))
        except Exception:
            continue
        seen += 1
        for h in seg:
            df[h] += 1
    if not seen:
        return set(), 0
    return {h for h, c in df.items() if c >= df_threshold * seen}, seen


def chain(part, min_core):
    """T3 — chain by prefix containment; return deep chains only."""
    chains = []
    for ts, core in part:
        placed = False
        for ch in chains:
            last = ch[-1][1]
            if len(core) >= len(last) and core[:len(last)] == last:
                ch.append((ts, core))
                placed = True
                break
        if not placed:
            chains.append([(ts, core)])
    merged = []
    for ch in sorted(chains, key=lambda c: (c[0][0], -len(c))):
        if not any(len(ch[-1][1]) <= len(m[-1][1]) and
                   m[-1][1][:len(ch[-1][1])] == ch[-1][1] for m in merged):
            merged.append(ch)
    return [c for c in merged if len(c) >= 2 and len(c[-1][1]) >= min_core]


def concurrent(chains):
    """Pairs whose time ranges overlap."""
    spans = [{"s0": secs(c[0][0]), "s1": secs(c[-1][0]), "ch": c} for c in chains]
    out = []
    for i in range(len(spans)):
        for j in range(i + 1, len(spans)):
            a, b = spans[i], spans[j]
            if min(a["s1"], b["s1"]) > max(a["s0"], b["s0"]):
                ov = min(a["s1"], b["s1"]) - max(a["s0"], b["s0"])
                out.append((a["ch"], b["ch"], ov))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", required=True, help="UTC day, YYYY-MM-DD (capture filename day)")
    ap.add_argument("--captures", default=DEFAULT_CAPTURES)
    ap.add_argument("--session", action="append", default=[],
                    help="session_id prefix to analyse (repeatable). Default: all sessions found.")
    ap.add_argument("--harness-sample", type=int, default=1200,
                    help="captures sampled for the harness set (0 = every capture)")
    ap.add_argument("--harness-df", type=float, default=DEFAULT_HARNESS_DF)
    ap.add_argument("--min-core", type=int, default=DEFAULT_MIN_CORE)
    ap.add_argument("--max-samples", type=int, default=150,
                    help="samples per session (0 = read every request)")
    args = ap.parse_args()

    paths = sorted(glob.glob(os.path.join(args.captures, "req-*-%s*.json" % args.date)))
    if not paths:
        print("no captures for %s under %s" % (args.date, args.captures))
        return 0

    harness, nseen = build_harness(paths, args.harness_sample, args.harness_df)
    print("corpus: %d captures | harness: %d hashes over %d sampled requests (df>=%.0f%%)"
          % (len(paths), len(harness), nseen, args.harness_df * 100))

    # One pass to group by session. T6: the session id is read by PARSING
    # body.metadata.user_id (a nested JSON *string*), never by a raw regex
    # over the file — a first-match regex grabs a session id QUOTED inside a
    # message body (an analysis session that cites other sessions' ids gets
    # its own requests attributed to them, and a same-id chain from a second
    # machine then reads as a cross-machine fork — measured 2026-10-09: the
    # one flagged session was exactly this artifact, from this instrument's
    # own predecessor).
    by = collections.defaultdict(list)
    for p in paths:
        try:
            with open(p, encoding="utf-8", errors="strict") as fh:
                d = json.load(fh)
        except Exception:
            continue
        uid = ((d.get("body") or {}).get("metadata") or {}).get("user_id")
        if not isinstance(uid, str):
            continue
        try:
            sid = json.loads(uid).get("session_id")
        except Exception:
            continue
        if isinstance(sid, str) and len(sid) == 36:
            by[sid].append(p)

    targets = []
    if args.session:
        for pref in args.session:
            hits = sorted([k for k in by if k.startswith(pref)], key=lambda k: -len(by[k]))
            if hits:
                targets.append(hits[0])
            else:
                print("session inconnue: %s" % pref)
    else:
        targets = sorted(by, key=lambda k: -len(by[k]))

    fork_count = 0
    print()
    print("%-14s %6s %6s %6s %9s %6s %9s %5s %6s  %s"
          % ("session", "req", "main", "mchain", "mconcur", "sub", "sconcur",
             "step", "floor", "verdict"))
    for sess in targets:
        files = sorted(by[sess])
        # 0 = read every request (point 2, re-review #432: the sampling floor
        # documented in ops-scripts.md needs its escape hatch to exist).
        full = args.max_samples <= 0
        step = 1 if full else max(1, len(files) // args.max_samples)
        sample = files[::step] if full else files[::step][:args.max_samples]
        floor = 2 * step  # a chain needs >=2 sampled points with deep cores
        recs = []
        for p in sample:
            try:
                with open(p, encoding="utf-8", errors="replace") as fh:
                    raw = fh.read()
                d = json.loads(raw)
            except Exception:
                continue
            ts = d.get("ts")
            if not ts:
                continue  # every fleet capture carries ts; no filename fallback
            core = [h for h in segments_of(d) if h not in harness]
            recs.append((ts, core, is_subagent(raw)))
        if not recs:
            continue
        recs.sort(key=lambda r: r[0])
        res = {}
        for flag in (False, True):
            part = [(t, c) for t, c, s in recs if s is flag]
            chains = chain(part, args.min_core)
            res[flag] = (len(part), len(chains), concurrent(chains))
        main_pts, main_chains, main_conc = res[False]
        sub_pts, sub_chains, sub_conc = res[True]
        verdict = "SPLIT-BRAIN?" if main_conc else ("clean" if main_pts else "no-main")
        if main_conc:
            fork_count += 1
        print("%-14s %6d %6d %6d %9d %6d %9d %5d %6d  %s"
              % (sess[:13], len(files), main_pts, main_chains, len(main_conc),
                 sub_pts, len(sub_conc), step, floor, verdict))
        for a, b, ov in main_conc[:5]:
            print("      MAIN overlap %ds : %s-%s vs %s-%s"
                  % (ov, a[0][0][11:19], a[-1][0][11:19], b[0][0][11:19], b[-1][0][11:19]))

    print()
    print("verdict: %d session(s) with concurrent MAIN-agent chains (split-brain candidates)"
          % fork_count)
    print("note: concurrent SUB-agent chains are EXPECTED (parallel Task calls share the "
          "parent session_id) and are not split-brain.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
