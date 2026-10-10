#!/usr/bin/env python3
"""Self-executing pins for split-brain-content.py (#41).

The 2026-10-09 full run produced only a 0 — a verdict that exercises the
happy path but never proves the instrument can actually FIRE. This suite
embeds the missing positive control: a synthetic corpus where one session_id
genuinely hosts two concurrently-alive MAIN chains must be flagged
SPLIT-BRAIN?, and a sequential compaction restart in the same corpus must
stay clean (a sequential break is not a fork). Unit pins cover the
primitives each trap taught (T1/T2 harness removal is exercised end-to-end
by the corpus itself; T3/T4/T5/T6 have unit-level pins below).

Run: python scripts/tests/test_split_brain_content.py   (or under pytest)
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.join(_HERE, "..", "split-brain-content.py")

spec = importlib.util.spec_from_file_location("split_brain_content", _SCRIPT)
sbc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sbc)

FAILS = []


def check(name, cond, detail=""):
    print("%s %s%s" % ("ok  " if cond else "FAIL", name, (" — " + detail) if detail else ""))
    if not cond:
        FAILS.append(name)


# ---------------------------------------------------------------- fixtures

# Harness text shared by EVERY request (df=100% -> removed by document
# frequency). It carries a cc_version line WITHOUT the subagent flag, like
# the real fleet preamble.
HARNESS = "fleet preamble cc_version=2.1.300 (cli) x-init=1 injected every request"
DATE = "2026-10-10"
SID_FORK = "aaaaaaaa-1111-2222-3333-444444444444"
SID_CLEAN = "bbbbbbbb-1111-2222-3333-444444444444"


def req_json(sid, ts, segs, sub=False):
    """A capture-shaped request: harness + user segments, nested user_id."""
    harness = HARNESS
    if sub:
        harness += " cc_is_subagent=true"
    msgs = [{"role": "user", "content": harness},
            {"role": "assistant", "content": "ok"}]
    for s in segs:
        msgs.append({"role": "user", "content": s})
        msgs.append({"role": "assistant", "content": "ok"})
    return {
        "ts": ts,
        "body": {
            "model": "claude-sonnet-5-5",
            "messages": msgs,
            "metadata": {"user_id": json.dumps({"session_id": sid})},
        },
    }


def fname(ts):
    # must match the script's glob: req-*-YYYYMMDD*.json
    return "req-%s-10.0.0.1-%s-direct.json" % (ts.replace("-", "").replace(":", ""), DATE)


def build_corpus(root):
    """Two sessions under one roof:
    - SID_FORK: MAIN chain A (10:00->10:40) + disjoint MAIN chain B
      (10:05->10:25) under the SAME session id = the real split-brain shape.
    - SID_CLEAN: chain A' (12:00->12:40) then a compaction restart chain C
      (13:00->13:20) — sequential, must NOT flag.
    """
    paths = []

    def emit(sid, t, segs):
        p = os.path.join(root, fname(t))
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(req_json(sid, t, segs), fh)
        paths.append(p)

    def thread(base, tag, n):
        # cumulative: request i carries base + extras 0..i (append-only history)
        return [base + ["%s-extra %d" % (tag, k) for k in range(i + 1)] for i in range(n)]

    a_base = ["turn a %d" % i for i in range(8)]
    b_base = ["turn b %d" % i for i in range(8)]
    c_base = ["post-compact %d" % i for i in range(8)]

    for i, segs in enumerate(thread(a_base, "a", 8)):  # chain A: 10:00 -> 10:35
        emit(SID_FORK, "%sT10:%02d:00Z" % (DATE, i * 5), segs)
    # chain B: 10:03 -> 10:23, disjoint, INSIDE A's span (minutes offset so the
    # capture filenames — one per distinct ts — never collide with A's)
    for j, segs in enumerate(thread(b_base, "b", 5)):
        emit(SID_FORK, "%sT10:%02d:00Z" % (DATE, 3 + j * 5), segs)

    for i, segs in enumerate(thread(a_base, "a2", 8)):  # chain A': 12:00 -> 12:35
        emit(SID_CLEAN, "%sT12:%02d:00Z" % (DATE, i * 5), segs)
    for j, segs in enumerate(thread(c_base, "c", 5)):  # compaction C: 13:00 -> 13:20
        emit(SID_CLEAN, "%sT13:%02d:00Z" % (DATE, j * 5), segs)
    return paths


# ---------------------------------------------------------------- unit pins

def test_chain_append_only():
    cores = [[str(i) for i in range(8)],
             [str(i) for i in range(9)],
             [str(i) for i in range(11)]]
    chains = sbc.chain([("%sT10:0%d:00Z" % (DATE, i), c) for i, c in enumerate(cores)], 8)
    check("chain: append-only sequence yields ONE chain", len(chains) == 1 and len(chains[0]) == 3,
          "chains=%d" % len(chains))


def test_chain_disjoint_opens_second():
    a = [str(i) for i in range(8)]
    b = ["x%d" % i for i in range(8)]
    chains = sbc.chain([("%sT10:00:00Z" % DATE, a),
                        ("%sT10:05:00Z" % DATE, b),
                        ("%sT10:10:00Z" % DATE, a + ["more"]),
                        ("%sT10:15:00Z" % DATE, b + ["more"])], 8)
    check("chain: disjoint core opens a SECOND chain", len(chains) == 2,
          "chains=%d" % len(chains))


def test_chain_min_core_floor():
    shallow = [[str(i) for i in range(3)], [str(i) for i in range(4)]]
    chains = sbc.chain([("%sT10:0%d:00Z" % (DATE, i), c) for i, c in enumerate(shallow)], 8)
    check("chain: shallow cores (T3) are not chains", chains == [], "chains=%r" % (chains,))


def test_concurrent_overlap_vs_sequential():
    mk = lambda h, m: "%sT%s:%02d:00Z" % (DATE, h, m)
    live = [[(mk(10, 0), None), (mk(10, 40), None)],
            [(mk(10, 5), None), (mk(10, 25), None)]]
    seq = [[(mk(10, 0), None), (mk(10, 40), None)],
           [(mk(13, 0), None), (mk(13, 20), None)]]
    check("concurrent: overlapping spans pair", len(sbc.concurrent(live)) == 1)
    check("concurrent: sequential (compaction) does NOT pair", sbc.concurrent(seq) == [])


def test_is_subagent_line_scoped():
    main = 'preamble "cc_version=2.1.300 (cli) x-init=1" tail'
    sub = 'preamble "cc_version=2.1.300 (cli) cc_is_subagent=true" tail'
    quoted = 'CLAUDE.md says cc_is_subagent=true documents the leak; "cc_version=2.1.300 (cli)" line'
    check("T4: flag on the cc_version line -> sub", sbc.is_subagent(sub) is True)
    check("T4: no flag on the line -> main", sbc.is_subagent(main) is False)
    check("T4: bare mention OUTSIDE the line stays main", sbc.is_subagent(quoted) is False)


def test_user_segments_order():
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "x.json")
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(req_json(SID_FORK, "%sT10:00:00Z" % DATE, ["one", "two"]), fh)
        segs = sbc.user_segments(p)
        check("user_segments: harness + turns in order, assistant skipped",
              len(segs) == 3, "segs=%d" % len(segs))


# ------------------------------------------------- end-to-end positive control

def test_end_to_end_fork_fires_and_sequential_stays_clean():
    with tempfile.TemporaryDirectory() as tmp:
        build_corpus(tmp)
        r = subprocess.run(
            [sys.executable, _SCRIPT, "--date", DATE, "--captures", tmp,
             # df=1.0 on purpose: at 26 requests the default 10% threshold would
             # classify the conversation's OWN history as harness (a segment
             # recurs in every later request of its thread — 13/26 = 50%). The
             # default presumes a full-day corpus where no single conversation
             # dominates the sample.
             "--harness-df", "1.0",
             "--session", SID_FORK[:8], "--session", SID_CLEAN[:8]],
            capture_output=True, text=True, timeout=300)
        out = r.stdout
        check("e2e: exit 0", r.returncode == 0, "rc=%d stderr=%s" % (r.returncode, r.stderr[:200]))
        check("e2e: corpus read whole (26 captures)", "corpus: 26 captures" in out,
              out.splitlines()[0] if out else "")
        fork_line = [l for l in out.splitlines() if l.startswith(SID_FORK[:13])]
        clean_line = [l for l in out.splitlines() if l.startswith(SID_CLEAN[:13])]
        check("e2e: POSITIVE CONTROL — concurrent disjoint MAIN chains => SPLIT-BRAIN?",
              bool(fork_line) and fork_line[0].rstrip().endswith("SPLIT-BRAIN?"),
              fork_line[0] if fork_line else "line absent")
        check("e2e: compaction restart (sequential) stays clean",
              bool(clean_line) and clean_line[0].rstrip().endswith("clean"),
              clean_line[0] if clean_line else "line absent")
        check("e2e: exactly ONE flagged session", "verdict: 1 session(s)" in out)


if __name__ == "__main__":
    for fn in [test_chain_append_only, test_chain_disjoint_opens_second,
               test_chain_min_core_floor, test_concurrent_overlap_vs_sequential,
               test_is_subagent_line_scoped, test_user_segments_order,
               test_end_to_end_fork_fires_and_sequential_stays_clean]:
        print("## %s" % fn.__name__)
        fn()
    print()
    if FAILS:
        print("FAILED: %d — %s" % (len(FAILS), ", ".join(FAILS)))
        sys.exit(1)
    print("all pins ok")
