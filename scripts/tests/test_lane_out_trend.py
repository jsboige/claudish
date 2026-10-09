#!/usr/bin/env python3
r"""Pins for lane-out-trend.py's usage aggregation (ai-01 review #414, 2026-10-09).

A resp capture carries SEVERAL usage objects (message_start states the
request context; the terminal message_delta repeats the three input counters
with the cache split applied — #179), and the two eras put the real numbers
in different slots. These pins hold the selection policy to its contract:

  1. the terminal VALID usage object wins, kept as a whole triple — mixing
     per-field maxima across objects doubles the context
     (start=(244812,0,0) + delta=(67,244800,0) -> 489612 instead of 244867);
  2. an incomplete stream falls back coherently to message_start's statement;
  3. a missing cache report is UNKNOWN, not zero — such responses are
     excluded from the cache share, never counted as cr=0;
  4. output is the TERMINAL cumulative value.

Every case calls the real stats() on a one-capture fixture directory — the
review measured the mutant exactly that way ("calling actual stats() on a
one-capture fixture returns ctx=489612 instead of coherent 244867, cache
50% instead of ~100%").

Fixture provenance: case 2 is the hub's resp-r11463 shape (2026-09-30),
measured independently by ai-01's review from the PR head; cases 1/3/4 are
the era measurements of 2026-10-08 (40 files/handler, both eras, table in
the script's docstring).

Run standalone:  python scripts/tests/test_lane_out_trend.py
Or under pytest: pytest scripts/tests/test_lane_out_trend.py
"""

import importlib.util
import json
import os
import re
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "lane_out_trend", os.path.join(_HERE, "..", "lane-out-trend.py"))
lt = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(lt)
lt.LANE_GROUPS, lt.group_of = lt.load_groups()

FAILS = []

# The mutant, kept live next to the pin that kills it (review #414, mutation 3):
# the exact regex the pre-fix reader used. It cannot match an object containing
# a nested one, which is EVERY native Anthropic usage object — so on the case-6
# fixture it returns 0 while the file plainly carries two usage objects.
MUTANT_RX = re.compile(r'"usage":\s*\{[^{}]*\}')


def raw_usage_blocks_with_flat_regex(text):
    return len(MUTANT_RX.findall(text))


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def write_fixture(events):
    """One resp-*.sse fixture in its own dir: each event contributes one
    usage object, in file order."""
    d = tempfile.mkdtemp(prefix="lane-out-pins-")
    name = "resp-1-r11463-2026-09-30T11-14-15-128Z-anthropic-minimax-m3.sse"
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        for ev, usage in events:
            f.write("event: %s\ndata: %s\n\n"
                    % (ev, json.dumps({"type": ev, "usage": usage})))
    return d


def write_raw_fixture(lines):
    """A resp-*.sse fixture written VERBATIM — the fixture must reproduce the
    wire, not the shape a regex author had in mind (review #414 point 2)."""
    d = tempfile.mkdtemp(prefix="lane-out-pins-")
    name = "resp-1-r20179-2026-10-09T11-42-00-000Z-native-claude-opus-5-5.sse"
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return d


def run_stats(d):
    """Collapse across lane groups — the pins are about aggregation, not
    lanes; the row totals are what the table prints."""
    per = lt.stats(d)
    keys = ("n", "out", "in", "ctx", "cr", "cc", "ctx_ck", "n_ck",
            "no_input", "no_usage", "parse_fail", "line_fail")
    return {k: sum(row[k] for row in per.values()) for k in keys}


def main():
    print("case 1 — July zero-seed: start all-zero, terminal delta carries "
          "the real triple (positional [0] read ZERO here)")
    t = run_stats(write_fixture([
        ("message_start", {"input_tokens": 0, "cache_read_input_tokens": 0,
                           "cache_creation_input_tokens": 0,
                           "output_tokens": 3}),
        ("message_delta", {"input_tokens": 50000,
                           "cache_read_input_tokens": 12000,
                           "cache_creation_input_tokens": 800,
                           "output_tokens": 42}),
    ]))
    check("n counted", t["n"] == 1, t)
    check("IN from the DELTA triple (not the zero seed)",
          t["in"] == 50000, t)
    check("ctx = in+cr+cc of the chosen block",
          t["ctx"] == 62800, t)
    check("cache split known", t["cr"] == 12000 and t["n_ck"] == 1, t)
    check("OUT terminal cumulative", t["out"] == 42, t)
    check("no unknown-input bucket", t["no_input"] == 0, t)

    print("case 2 — Sept full-seed->cache-split (hub resp-r11463 shape, the "
          "mutant killer: start=(244812,0,0), delta=(67,244800,0))")
    t = run_stats(write_fixture([
        ("message_start", {"input_tokens": 244812,
                           "cache_read_input_tokens": 0,
                           "cache_creation_input_tokens": 0,
                           "output_tokens": 3}),
        ("message_delta", {"input_tokens": 67,
                           "cache_read_input_tokens": 244800,
                           "cache_creation_input_tokens": 0,
                           "output_tokens": 180}),
    ]))
    check("terminal triple kept WHOLE (per-field maxima would read 489612)",
          t["ctx"] == 244867, t)
    check("mutant documented: independent maxima = 489612 != 244867",
          max(244812, 67) + max(0, 244800) + 0 == 489612
          and 489612 != 244867)
    check("IN is the terminal split's fresh share", t["in"] == 67, t)
    check("cache share ~100%, not 50%",
          t["cr"] == 244800 and t["ctx_ck"] == 244867
          and abs(100.0 * t["cr"] / t["ctx_ck"] - 100.0) < 0.5, t)
    check("OUT terminal", t["out"] == 180, t)

    print("case 3 — incomplete stream: start only, coherent fallback, cache "
          "split UNKNOWN (excluded from the share, not cr=0)")
    t = run_stats(write_fixture([
        ("message_start", {"input_tokens": 244812,
                           "cache_read_input_tokens": 0,
                           "cache_creation_input_tokens": 0,
                           "output_tokens": 3}),
    ]))
    check("fallback triple = message_start's own statement",
          t["in"] == 244812 and t["ctx"] == 244812, t)
    check("cache UNKNOWN: not in the share denominator",
          t["n_ck"] == 0 and t["ctx_ck"] == 0 and t["cr"] == 0, t)
    check("still counted as a response", t["n"] == 1 and t["no_input"] == 0, t)

    print("case 4 — all blocks zero-seeded (July stream cut before the "
          "delta): input UNKNOWN, never zero")
    t = run_stats(write_fixture([
        ("message_start", {"input_tokens": 0, "output_tokens": 7}),
    ]))
    check("no input statement -> sansInput, not ctx=0",
          t["no_input"] == 1 and t["ctx"] == 0 and t["in"] == 0, t)
    check("OUT still counted", t["out"] == 7 and t["no_usage"] == 0, t)

    print("case 5 — output progression: cumulative, the terminal value wins")
    t = run_stats(write_fixture([
        ("message_start", {"input_tokens": 100, "cache_read_input_tokens": 0,
                           "cache_creation_input_tokens": 0,
                           "output_tokens": 5}),
        ("message_delta", {"input_tokens": 100, "cache_read_input_tokens": 0,
                           "cache_creation_input_tokens": 0,
                           "output_tokens": 17}),
        ("message_delta", {"input_tokens": 100, "cache_read_input_tokens": 0,
                           "cache_creation_input_tokens": 0,
                           "output_tokens": 42}),
    ]))
    check("OUT = last cumulative (42), not first (5)",
          t["out"] == 42, t)
    check("chosen input = terminal non-empty block", t["in"] == 100, t)

    print("case 6 — VERBATIM native wire (hub resp-1-r20179-…-native-claude-"
          "opus-5-5.sse, 09/10 11:42Z): usage objects carry NESTED siblings "
          "(cache_creation / output_tokens_details / iterations[]) — the "
          "`[^{}]*` mutant read 0 of 123 native captures")
    raw = write_raw_fixture([
        # message_start — the real shape: usage lives at .message.usage, and
        # cache_creation is a nested object.
        'event: message_start',
        'data: ' + json.dumps({
            "type": "message_start",
            "message": {
                "id": "msg_01r20179", "type": "message", "role": "assistant",
                "model": "claude-opus-5-5", "content": [], "stop_reason": None,
                "usage": {
                    "input_tokens": 2,
                    "cache_creation_input_tokens": 1909,
                    "cache_read_input_tokens": 133633,
                    "cache_creation": {"ephemeral_5m_input_tokens": 0,
                                       "ephemeral_1h_input_tokens": 1909},
                    "output_tokens": 24,
                    "service_tier": "standard",
                },
            },
        }),
        '',
        # terminal message_delta — nested output_tokens_details AND an
        # iterations[] entry carrying its OWN input_tokens (4400). That
        # number belongs to the iteration, never to the request's triple.
        'event: message_delta',
        'data: ' + json.dumps({
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {
                "input_tokens": 4500,
                "cache_creation_input_tokens": 1909,
                "cache_read_input_tokens": 133633,
                "output_tokens": 377,
                "output_tokens_details": {"thinking_tokens": 0},
                "iterations": [
                    {"type": "message", "input_tokens": 4400,
                     "output_tokens": 100}
                ],
            },
        }),
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
    ])
    t = run_stats(raw)
    check("native capture is MEASURED, not sansUsage (the mutant read it as "
          "no usage at all)", t["no_usage"] == 0 and t["n"] == 1, t)
    check("no parse failure on a well-formed native capture",
          t["parse_fail"] == 0 and t["line_fail"] == 0, t)
    check("terminal triple kept WHOLE from the top-level usage object",
          t["ctx"] == 4500 + 133633 + 1909, t)
    check("IN is the top-level statement, NOT the iteration's (4400 is a "
          "different object)", t["in"] == 4500, t)
    check("cache split measured (delta sits after the start)",
          t["cr"] == 133633 and t["cc"] == 1909 and t["n_ck"] == 1, t)
    check("OUT is the terminal cumulative value", t["out"] == 377, t)
    check("the mutant could not have produced these blocks: a brace-delimited "
          "regex stops at the first nested `{`",
          raw_usage_blocks_with_flat_regex(raw) == 0)

    print("case 7 — a capture that TALKS about usage but does not decode is a "
          "parse FAILURE, not an absence (review #414 point 3)")
    d = write_raw_fixture([
        'event: message_delta',
        # truncated mid-number: not valid JSON, but unmistakably a usage line
        'data: {"type":"message_delta","usage":{"output_tokens":',
        '',
    ])
    t = run_stats(d)
    check("counted as parse_fail, never folded into sansUsage",
          t["parse_fail"] == 1 and t["no_usage"] == 0, t)
    check("the undecodable line is counted too", t["line_fail"] == 1, t)
    check("still a response (it was read, it was not understood)",
          t["n"] == 1, t)
    check("verdict refuses: exit code non-zero when a lane is unmeasured",
          lt.verdict_exit_code(True) != 0 and lt.verdict_exit_code(False) == 0)

    print("case 8 — a capture WITHOUT any usage statement stays sansUsage (the "
          "parseFail counter must not swallow the honest absence)")
    d = write_raw_fixture([
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"m","content":[]}}',
        '',
    ])
    t = run_stats(d)
    check("no usage at all -> sansUsage, not parseFail",
          t["no_usage"] == 1 and t["parse_fail"] == 0, t)

    print()
    if FAILS:
        print("FAILED: %d pin(s): %s" % (len(FAILS), ", ".join(FAILS)))
        return 1
    print("all pins ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
