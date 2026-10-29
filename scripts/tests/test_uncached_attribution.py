#!/usr/bin/env python3
"""Pins for uncached-attribution.py (#445(a) -- who reads the uncached volume).

The instrument answers one question: of the tokens the hub reports as READ,
how much belongs to each seat (machine) and each lane/model. Three properties
are load-bearing and each has a pin here:

  1. PAIRING is restart-aware, the turn-autopsy rule: the request counter
     RESTARTS with every container life, so a response is attributed to the
     LATEST request of its counter whose timestamp precedes it, within a
     20-minute window. Pin 3 proves two uptime windows sharing counter 1 do
     not merge their volumes.
  2. A CASCADE writes one response per upstream attempt; the attempt that
     SERVES the client is the LAST one. Pin 4 proves the later response wins.
  3. A request with no response is counted as unpaired and EXCLUDED from the
     totals -- never silently folded into a seat. Pin 5.

Plus the headline pin 2: the per-machine shares must add up to the corpus
total (no volume lost between the lane view and the machine view).

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
                "ts": ts.replace("-", "-"),
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


def _resp(dirpath, pid, counter, ts, lane_model, inp, cread, outp):
    name = f"resp-{pid}-r{counter}-{ts}-{lane_model}.sse"
    with open(os.path.join(dirpath, name), "w", encoding="utf-8") as fh:
        fh.write('event: message_start\ndata: {"type":"message_start"}\n\n')
        fh.write(
            "data: "
            + json.dumps(
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn"},
                    "usage": {
                        "input_tokens": inp,
                        "cache_read_input_tokens": cread,
                        "output_tokens": outp,
                    },
                }
            )
            + "\n\n"
        )
        fh.write("data: [DONE]\n\n")
    return name


def _run(dirpath):
    reqs, meta, resps = ua.index_corpus(dirpath)
    return ua.attribute(reqs, meta, resps, dirpath)


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="uncached-attr-")
    try:
        # --- pin 1: two seats, one lane each -----------------------------
        _req(tmp, 1, 1, "2026-10-28T10-00-00-000Z", "myia-po-2023", "openai/glm-5.3")
        _resp(tmp, 1, 1, "2026-10-28T10-00-05-000Z", "openai-glm-5.3", 1000, 4000, 50)
        _req(tmp, 1, 2, "2026-10-28T11-00-00-000Z", "myia-po-2024", "openai/swift-1.5-27b")
        _resp(tmp, 1, 2, "2026-10-28T11-00-05-000Z", "openai-swift-1.5-27b", 3000, 0, 70)

        by_machine, by_lane, counters = _run(tmp)
        _check(
            by_machine["myia-po-2023"][1] == 1000,
            f"pin 1a: po-2023 input = {by_machine['myia-po-2023'][1]}, want 1000",
        )
        _check(
            by_machine["myia-po-2023"][2] == 4000,
            f"pin 1b: po-2023 cache_read = {by_machine['myia-po-2023'][2]}, want 4000",
        )
        _check(
            by_machine["myia-po-2024"][1] == 3000,
            f"pin 1c: po-2024 input = {by_machine['myia-po-2024'][1]}, want 3000",
        )
        _check(
            by_machine["myia-po-2024"][2] == 0,
            "pin 1d: swift lane reports NO cache_read (openai wire) -- want 0",
        )

        # --- pin 2: machine shares must add up to the corpus total --------
        total_machine = sum(a[1] for a in by_machine.values())
        total_lane = sum(a[1] for a in by_lane.values())
        _check(
            total_machine == counters["total_input"] == total_lane == 4000,
            f"pin 2: totals machine={total_machine} lane={total_lane} "
            f"counter={counters['total_input']}, want 4000 everywhere",
        )

        # --- pin 3: a counter RESTARTED (two uptime windows) -------------
        shutil.rmtree(tmp)
        os.makedirs(tmp)
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
        shutil.rmtree(tmp)
        os.makedirs(tmp)
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
        shutil.rmtree(tmp)
        os.makedirs(tmp)
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
            counters["total_input"] == 400,
            f"pin 5c: total = {counters['total_input']}, want 400 (unpaired excluded)",
        )

        print("uncached-attribution: all pins green")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
