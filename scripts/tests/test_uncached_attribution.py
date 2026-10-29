#!/usr/bin/env python3
"""Pins for uncached-attribution.py (#445(a) -- who reads the uncached volume).

The instrument answers one question: of the tokens the hub reports as READ,
how much belongs to each seat (machine) and each lane/model. The properties
below are load-bearing and each has a pin here:

  1. PAIRING is restart-aware, the turn-autopsy rule: the request counter
     RESTARTS with every container life, so a response is attributed to the
     LATEST request of its counter whose timestamp precedes it, within a
     20-minute window. Pin 3 proves two uptime windows sharing counter 1 do
     not merge their volumes.
  2. A CASCADE writes one response per upstream attempt; the attempt that
     SERVES the client is the LAST one. Pin 4 proves the later response wins.
  3. A request with no response is counted as unpaired and EXCLUDED from the
     totals -- never silently folded into a seat. Pin 5.
  4. THE DENOMINATOR. `input_tokens` alone excludes cache WRITES, so it is
     not the uncached volume. Pin 6 pins the definition
     uncached = cold + cache_creation, and pin 7 the nested
     `cache_creation` form some dialects emit.
  5. USAGE IS MERGED, NOT REPLACED. A terminal `message_delta` usually carries
     only `output_tokens`; assigning it wholesale would erase the input
     counters. Pin 8 pins a full delta followed by an output-only one.
  6. EVERY FILE LANDS IN ONE BUCKET. Orphans, unusable usage and unreadable
     envelopes are counted separately, and the buckets reconcile with the
     corpus: req = paired + usage_unusable + unpaired, resp = claimed +
     orphan. Pins 2, 9, 10, 11.
  7. AN UNREADABLE ARCHIVE IS LOUD. A missing extractor must raise, never
     present as an empty corpus. Pin 12.

Run standalone (no pytest needed):
  python scripts/tests/test_uncached_attribution.py
Or under pytest:
  pytest scripts/tests/test_uncached_attribution.py
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.environ.get(
    "UNCACHED_TARGET", os.path.join(os.path.dirname(_HERE), "uncached-attribution.py")
)

_spec = importlib.util.spec_from_file_location("uncached_attribution", _TARGET)
ua = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ua)


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def _req(dirpath, pid, counter, ts, machine, model):
    name = f"req-{pid}-{counter}-{ts}-direct.json"
    with open(os.path.join(dirpath, name), "w", encoding="utf-8") as fh:
        json.dump(
            {
                "ts": ts,
                "src": "direct",
                "machine": machine,
                "model": model,
                "pid": int(pid),
                "hops": [],
                "body": {"model": model},
            },
            fh,
        )
    return name


def _delta(inp=None, creation=None, cread=None, outp=None, nested=None):
    usage = {}
    if inp is not None:
        usage["input_tokens"] = inp
    if creation is not None:
        usage["cache_creation_input_tokens"] = creation
    if cread is not None:
        usage["cache_read_input_tokens"] = cread
    if outp is not None:
        usage["output_tokens"] = outp
    if nested is not None:
        usage["cache_creation"] = nested
    return (
        "data: "
        + json.dumps(
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": usage,
            }
        )
        + "\n\n"
    )


def _resp(
    dirpath,
    pid,
    counter,
    ts,
    lane_model,
    inp,
    cread,
    outp,
    creation=None,
    tail=None,
):
    """A response capture. `tail` replaces the terminal delta(s) verbatim."""
    name = f"resp-{pid}-r{counter}-{ts}-{lane_model}.sse"
    with open(os.path.join(dirpath, name), "w", encoding="utf-8") as fh:
        fh.write('event: message_start\ndata: {"type":"message_start"}\n\n')
        if tail is None:
            fh.write(_delta(inp, creation, cread, outp))
        else:
            fh.write(tail)
        fh.write("data: [DONE]\n\n")
    return name


def _run(dirpath):
    reqs, meta, resps, _files = ua.index_corpus(dirpath)
    return ua.attribute(reqs, meta, resps, dirpath)


def _fresh(tmp):
    shutil.rmtree(tmp)
    os.makedirs(tmp)


def _reconciles(counters, label):
    _check(
        counters["req"]
        == counters["paired"] + counters["usage_unusable"] + counters["unpaired"],
        f"{label}: req {counters['req']} != paired {counters['paired']}"
        f" + usage-unusable {counters['usage_unusable']}"
        f" + unpaired {counters['unpaired']}",
    )
    _check(
        counters["resp"] == counters["claimed_resp"] + counters["orphan_resp"],
        f"{label}: resp {counters['resp']} != claimed"
        f" {counters['claimed_resp']} + orphan {counters['orphan_resp']}",
    )


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="uncached-attr-")
    try:
        # --- pin 1: two seats, one lane each -----------------------------
        #   row layout: [turns, cold, cache_creation, cache_read, output]
        _req(tmp, 1, 1, "2026-10-28T10-00-00-000Z", "myia-po-2023", "openai/glm-5.3")
        _resp(
            tmp, 1, 1, "2026-10-28T10-00-05-000Z", "openai-glm-5.3", 1000, 4000, 50,
            creation=200,
        )
        _req(tmp, 1, 2, "2026-10-28T11-00-00-000Z", "myia-po-2024", "openai/swift-1.5-27b")
        _resp(tmp, 1, 2, "2026-10-28T11-00-05-000Z", "openai-swift-1.5-27b", 3000, 0, 70)

        by_machine, by_lane, counters = _run(tmp)
        _check(
            by_machine["myia-po-2023"][1] == 1000,
            f"pin 1a: po-2023 cold = {by_machine['myia-po-2023'][1]}, want 1000",
        )
        _check(
            by_machine["myia-po-2023"][2] == 200,
            f"pin 1b: po-2023 cache_creation = {by_machine['myia-po-2023'][2]}, want 200",
        )
        _check(
            by_machine["myia-po-2023"][3] == 4000,
            f"pin 1c: po-2023 cache_read = {by_machine['myia-po-2023'][3]}, want 4000",
        )
        _check(
            by_machine["myia-po-2024"][1] == 3000,
            f"pin 1d: po-2024 cold = {by_machine['myia-po-2024'][1]}, want 3000",
        )
        _check(
            by_machine["myia-po-2024"][3] == 0,
            "pin 1e: swift lane reports NO cache_read (openai wire) -- want 0",
        )
        _check(
            counters["total_cache_creation"] == 200,
            f"pin 1f: total cache_creation = {counters['total_cache_creation']}, want 200",
        )

        # --- pin 2: the views reconcile with the corpus ------------------
        total_machine = sum(a[1] for a in by_machine.values())
        total_lane = sum(a[1] for a in by_lane.values())
        _check(
            total_machine == counters["total_cold"] == total_lane == 4000,
            f"pin 2a: totals machine={total_machine} lane={total_lane}"
            f" counter={counters['total_cold']}, want 4000 everywhere",
        )
        creation_machine = sum(a[2] for a in by_machine.values())
        creation_lane = sum(a[2] for a in by_lane.values())
        _check(
            creation_machine
            == counters["total_cache_creation"]
            == creation_lane
            == 200,
            f"pin 2b: cache_creation totals machine={creation_machine}"
            f" lane={creation_lane}, want 200 everywhere",
        )
        _reconciles(counters, "pin 2c")

        # --- pin 3: a counter RESTARTED (two uptime windows) -------------
        _fresh(tmp)
        _req(tmp, 1, 1, "2026-10-28T10-00-00-000Z", "seat-A", "openai/glm-5.3")
        _resp(tmp, 1, 1, "2026-10-28T10-00-05-000Z", "openai-glm-5.3", 111, 0, 10)
        _req(tmp, 1, 1, "2026-10-28T12-00-00-000Z", "seat-B", "openai/glm-5.3")
        _resp(tmp, 1, 1, "2026-10-28T12-00-05-000Z", "openai-glm-5.3", 222, 0, 20)
        by_machine, _by_lane, counters = _run(tmp)
        _check(
            by_machine.get("seat-A", [0, 0])[1] == 111,
            f"pin 3a: seat-A got {by_machine.get('seat-A')}, want 111 (no cross-window merge)",
        )
        _check(
            by_machine.get("seat-B", [0, 0])[1] == 222,
            f"pin 3b: seat-B got {by_machine.get('seat-B')}, want 222",
        )
        _check(
            counters["unpaired"] == 0,
            f"pin 3c: unpaired = {counters['unpaired']}, want 0",
        )

        # --- pin 4: a CASCADE writes one response per attempt ------------
        _fresh(tmp)
        _req(tmp, 1, 1, "2026-10-28T10-00-00-000Z", "seat-A", "openai/glm-5.3")
        _resp(tmp, 1, 1, "2026-10-28T10-00-05-000Z", "openai-glm-5.3", 999, 0, 10)
        _resp(tmp, 1, 1, "2026-10-28T10-00-09-000Z", "openai-deepseek-flash", 55, 0, 20)
        by_machine, by_lane, _c = _run(tmp)
        _check(
            by_machine["seat-A"][1] == 55,
            f"pin 4a: the LAST attempt serves the client -- got {by_machine['seat-A'][1]}, want 55",
        )
        _check(
            by_lane[("openai", "deepseek-flash")][1] == 55,
            "pin 4b: the serving attempt's LANE is the one credited",
        )
        _check(
            by_lane[("openai", "glm-5.3")][1] == 0,
            "pin 4c: the earlier attempt is not counted as volume",
        )

        # --- pin 5: an unpaired request is reported, not folded in --------
        _fresh(tmp)
        _req(tmp, 1, 1, "2026-10-28T10-00-00-000Z", "seat-A", "openai/glm-5.3")
        _req(tmp, 1, 2, "2026-10-28T10-10-00-000Z", "seat-B", "openai/glm-5.3")
        _resp(tmp, 1, 2, "2026-10-28T10-10-05-000Z", "openai-glm-5.3", 400, 0, 30)
        by_machine, _by_lane, counters = _run(tmp)
        _check(
            counters["unpaired"] == 1,
            f"pin 5a: unpaired = {counters['unpaired']}, want 1",
        )
        _check(
            "seat-A" not in by_machine,
            f"pin 5b: an unpaired request must not create a seat row: {by_machine}",
        )
        _check(
            counters["total_cold"] == 400,
            f"pin 5c: total = {counters['total_cold']}, want 400 (unpaired excluded)",
        )
        _reconciles(counters, "pin 5d")

        # --- pin 6: THE DENOMINATOR — cold + cache writes ---------------
        # input_tokens alone excludes cache_creation, so a turn that wrote
        # 500 tokens into the cache is 500 MORE uncached tokens, not fewer.
        _fresh(tmp)
        _req(tmp, 1, 1, "2026-10-28T10-00-00-000Z", "seat-A", "anthropic/MiniMax-M3.1-Flash")
        _resp(
            tmp, 1, 1, "2026-10-28T10-00-05-000Z", "anthropic-MiniMax-M3.1-Flash",
            100, 9000, 40, creation=500,
        )
        by_machine, _by_lane, counters = _run(tmp)
        tot = ua._totals(counters)
        _check(
            counters["total_cold"] == 100 and counters["total_cache_creation"] == 500,
            f"pin 6a: cold/creation = {counters['total_cold']}/"
            f"{counters['total_cache_creation']}, want 100/500 separately",
        )
        _check(
            tot["uncached"] == 600,
            f"pin 6b: uncached = {tot['uncached']}, want 600 (cold 100 + writes 500)",
        )
        _check(
            tot["prompt"] == 9600,
            f"pin 6c: prompt = {tot['prompt']}, want 9600 (cold+writes+reads)",
        )
        _check(
            by_machine["seat-A"][2] == 500,
            "pin 6d: the seat row carries cache_creation, not only cold",
        )

        # --- pin 7: the NESTED cache_creation form -----------------------
        _fresh(tmp)
        _req(tmp, 1, 1, "2026-10-28T10-00-00-000Z", "seat-A", "anthropic/MiniMax-M3.1-Flash")
        _resp(
            tmp, 1, 1, "2026-10-28T10-00-05-000Z", "anthropic-MiniMax-M3.1-Flash",
            10, 0, 12,
            tail=_delta(10, None, 0, 12, nested={"ephemeral_5m_input_tokens": 300,
                                                 "ephemeral_1h_input_tokens": 200}),
        )
        _by_machine, _by_lane, counters = _run(tmp)
        _check(
            counters["total_cache_creation"] == 500,
            f"pin 7: nested cache_creation summed ="
            f" {counters['total_cache_creation']}, want 500",
        )

        # --- pin 8: usage is MERGED, not replaced -----------------------
        # A full delta (carrying the input counters) followed by the usual
        # output-only terminal delta. Wholesale assignment would erase the
        # input; the merge keeps both.
        _fresh(tmp)
        _req(tmp, 1, 1, "2026-10-28T10-00-00-000Z", "seat-A", "openai/glm-5.3")
        _resp(
            tmp, 1, 1, "2026-10-28T10-00-05-000Z", "openai-glm-5.3", None, None, None,
            tail=_delta(700, 30, 2500, 5) + _delta(outp=9),
        )
        _by_machine, _by_lane, counters = _run(tmp)
        _check(
            counters["total_cold"] == 700,
            f"pin 8a: cold = {counters['total_cold']}, want 700 (first delta survives"
            f" an output-only terminal delta)",
        )
        _check(
            counters["total_cache_creation"] == 30
            and counters["total_cache_read"] == 2500,
            f"pin 8b: writes/reads = {counters['total_cache_creation']}/"
            f"{counters['total_cache_read']}, want 30/2500",
        )
        _check(
            counters["total_output"] == 9,
            f"pin 8c: output = {counters['total_output']}, want 9 (last delta wins)",
        )

        # --- pin 9: an ORPHAN response is its own bucket -----------------
        _fresh(tmp)
        _req(tmp, 1, 1, "2026-10-28T10-00-00-000Z", "seat-A", "openai/glm-5.3")
        _resp(tmp, 1, 1, "2026-10-28T10-00-05-000Z", "openai-glm-5.3", 400, 0, 30)
        # A response whose request capture was never written.
        _resp(tmp, 1, 9, "2026-10-28T10-30-05-000Z", "openai-glm-5.3", 888, 0, 30)
        _by_machine, _by_lane, counters = _run(tmp)
        _check(
            counters["orphan_resp"] == 1,
            f"pin 9a: orphan_resp = {counters['orphan_resp']}, want 1",
        )
        _check(
            counters["unpaired"] == 0,
            f"pin 9b: an orphan resp is NOT an unpaired req (got {counters['unpaired']})",
        )
        _check(
            counters["total_cold"] == 400,
            f"pin 9c: an orphan's volume must not be attributed (total"
            f" {counters['total_cold']}, want 400)",
        )
        _reconciles(counters, "pin 9d")

        # --- pin 10: UNUSABLE usage is its own bucket --------------------
        _fresh(tmp)
        _req(tmp, 1, 1, "2026-10-28T10-00-00-000Z", "seat-A", "openai/glm-5.3")
        _req(tmp, 1, 2, "2026-10-28T10-10-00-000Z", "seat-B", "openai/glm-5.3")
        # paired but with no usage block at all
        _resp(tmp, 1, 1, "2026-10-28T10-00-05-000Z", "openai-glm-5.3", None, None, None,
              tail='data: {"type":"message_delta","delta":{}}\n\n')
        _resp(tmp, 1, 2, "2026-10-28T10-10-05-000Z", "openai-glm-5.3", 400, 0, 30)
        by_machine, _by_lane, counters = _run(tmp)
        _check(
            counters["usage_unusable"] == 1,
            f"pin 10a: usage_unusable = {counters['usage_unusable']}, want 1",
        )
        _check(
            counters["unpaired"] == 0,
            "pin 10b: a claimed-but-unusable response is NOT an unpaired request",
        )
        _check(
            "seat-A" not in by_machine,
            f"pin 10c: an unusable response creates no seat row: {by_machine}",
        )
        _reconciles(counters, "pin 10d")

        # --- pin 11: an UNREADABLE request is counted, not dropped ------
        _fresh(tmp)
        # A directory wearing a request filename: open() raises, the volume is
        # still reported under its own row instead of vanishing from the corpus.
        os.makedirs(os.path.join(tmp, "req-1-1-2026-10-28T10-00-00-000Z-direct.json"))
        _resp(tmp, 1, 1, "2026-10-28T10-00-05-000Z", "openai-glm-5.3", 123, 0, 7)
        by_machine, _by_lane, counters = _run(tmp)
        _check(
            counters["unreadable_req"] == 1,
            f"pin 11a: unreadable_req = {counters['unreadable_req']}, want 1",
        )
        _check(
            by_machine.get(ua.UNREADABLE, [0])[1] == 123,
            f"pin 11b: the volume is reported under {ua.UNREADABLE},"
            f" not dropped: {by_machine}",
        )
        _reconciles(counters, "pin 11c")

        # --- pin 12: an unreadable archive is LOUD ----------------------
        _fresh(tmp)
        saved = ua.find_extractor
        try:
            ua.find_extractor = lambda: None
            try:
                ua.extract_archive("whatever.7z", tmp)
            except ua.ArchiveError as exc:
                _check(
                    "extractor not found" in str(exc),
                    f"pin 12a: unexpected ArchiveError message: {exc}",
                )
            else:
                raise AssertionError(
                    "pin 12a: a missing extractor must raise, never yield an empty corpus"
                )

            # An extractor that RUNS but fails is just as loud: the exit code
            # and its output reach the operator instead of an empty corpus.
            ua.find_extractor = lambda: sys.executable
            try:
                ua.extract_archive("whatever.7z", tmp)
            except ua.ArchiveError as exc:
                _check(
                    "extractor exit" in str(exc),
                    f"pin 12b: non-zero exit not surfaced: {exc}",
                )
            else:
                raise AssertionError(
                    "pin 12b: a failing extractor must raise, never yield an empty corpus"
                )
        finally:
            ua.find_extractor = saved

        # --- pin 13: the CLI refuses an empty extraction loudly ---------
        _fresh(tmp)
        rc = ua.main(["--dir", tmp])
        _check(rc == 1, f"pin 13: an empty corpus exits 1, got {rc}")

        print("uncached-attribution: all pins green")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
