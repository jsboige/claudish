#!/usr/bin/env python3
"""Pins for scripts/local-log-reader.py (#1231).

`docker logs` on a `local`-driver container stops at the first run of zero bytes
in the driver file: exit 0, no warning, everything after the hole invisible
(measured on po-2027, 2026-11-27: 10 633 lines of a 21 461 496-byte / 174 366
record file, ending at the first hole of 2026-11-10T00:12:07Z).

The pin that matters is the one a mutant breaks: a reader that stops at the
first hole yields ZERO lines after it. `test_past_the_hole_is_mandatory` fails
on exactly that mutant, and `test_a_false_resync_candidate_is_swallowed` pins the
two-consecutive-records rule that keeps a decoy header inside a payload from
restarting the read.

Run: python scripts/tests/test_local_log_reader.py
"""

import importlib.util
import json
import os
import struct
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.join(_HERE, "..", "local-log-reader.py")


def _load():
    spec = importlib.util.spec_from_file_location("local_log_reader", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


reader = _load()

FAILS = []
CHECKS = [0]


def check(name, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print("ok   %s" % name)
    else:
        print("FAIL %s %s" % (name, detail))
        FAILS.append(name)


def ts(*args):
    return int(datetime(*args, tzinfo=timezone.utc).timestamp() * 1e9)


T0 = ts(2026, 11, 27, 0, 0, 0)
MIN = 60 * 10 ** 9


def _varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def rec(source=b"stdout", ts_ns=T0, line=b"x", with_line=True, partial=False):
    """One driver record: [u32 len][protobuf: 1 source, 2 time_nano, 3 line, 4 flags][u32 len]."""
    entry = bytearray()
    entry += b"\x0a" + bytes([len(source)]) + source
    entry += b"\x10" + _varint(ts_ns)
    if with_line:
        assert len(line) < 128, "fixture lines must fit a one-byte length"
        entry += b"\x1a" + bytes([len(line)]) + line
    if partial:
        entry += b"\x20\x01"   # field 4, varint 1: "the line continues"
    frame = bytes(entry)
    return struct.pack(">I", len(frame)) + frame + struct.pack(">I", len(frame))


def fixture_with_hole():
    """A, B, [75 zero bytes], C, D, empty-line E, partial F+G, H."""
    empty = rec(ts_ns=T0 + 4 * MIN, with_line=False)
    return b"".join([
        rec(line=b"before-hole-1", ts_ns=T0),
        rec(source=b"stderr", line=b"before-hole-2", ts_ns=T0 + MIN),
        b"\x00" * 75,
        rec(line=b"after-hole-1", ts_ns=T0 + 2 * MIN),
        rec(line=b"after-hole-2", ts_ns=T0 + 3 * MIN),
        empty,
        rec(line=b"partial-", ts_ns=T0 + 5 * MIN, partial=True),
        rec(line=b"merged", ts_ns=T0 + 6 * MIN),
        rec(line=b"last", ts_ns=T0 + 7 * MIN),
    ])


def _corpus_from(data):
    fd, path = tempfile.mkstemp(suffix=".log")
    os.close(fd)
    with open(path, "wb") as f:
        f.write(data)
    try:
        return reader.read_corpus(path), path
    finally:
        os.unlink(path)


def texts(c):
    return [txt.decode("utf-8") for (_o, _s, _t, txt) in c.records]


def main():
    data = fixture_with_hole()
    c, _ = _corpus_from(data)

    # 1. Both sides of the hole are read, in order, with the empty line skipped.
    check("reads both sides of the zero hole",
          texts(c) == ["before-hole-1", "before-hole-2", "after-hole-1",
                       "after-hole-2", "partial-merged", "last"],
          repr(texts(c)))
    check("one hole, 75 zero bytes",
          len(c.holes) == 1 and c.holes[0]["end"] - c.holes[0]["start"] == 75
          and c.holes[0]["zero_bytes"] == 75, repr(c.holes))

    # 2. THE PIN: a reader that stops at the first hole emits nothing after it.
    after = [txt for (_o, _s, t, txt) in c.records if t > T0 + MIN]
    check("past the hole is mandatory (mutant: stop at first hole -> 0 here)",
          len(after) == 4, "got %d" % len(after))
    check("hole names the record that resumes it",
          c.holes[0]["next_good_ns"] == T0 + 2 * MIN,
          repr(c.holes[0]["next_good_ns"]))

    # 3. An empty-line record (source + timestamp, no line) is a record, not a break.
    check("empty-line record counted, not a hole",
          c.empty_records == 1 and len(c.holes) == 1, repr(c.summary()))

    # 4. Partial records merge per source, keeping the FIRST timestamp.
    merged = [(t, txt) for (_o, _s, t, txt) in c.records if txt == b"partial-merged"]
    check("partial records merged", len(merged) == 1, repr(merged))
    check("merged line keeps the first timestamp",
          merged and merged[0][0] == T0 + 5 * MIN, repr(merged[:1]))

    # 5. A decoy header inside the break is swallowed: two consecutive records
    #    are required to resynchronise.
    decoy = rec(line=b"decoy-that-must-not-resync", ts_ns=T0 + 30 * MIN)
    data2 = b"".join([
        rec(line=b"one", ts_ns=T0),
        b"\x00" * 20,
        decoy,
        b"\xff" * 16,
        rec(line=b"two", ts_ns=T0 + MIN),
        rec(line=b"three", ts_ns=T0 + 2 * MIN),
    ])
    c2, _ = _corpus_from(data2)
    check("a false resync candidate is swallowed",
          texts(c2) == ["one", "two", "three"], repr(texts(c2)))
    check("the break covers the decoy",
          len(c2.holes) == 1
          and c2.holes[0]["end"] - c2.holes[0]["start"] > len(decoy),
          repr(c2.holes))

    # 6. A header truncated at EOF is reported, never dropped silently.
    data3 = rec(line=b"only", ts_ns=T0) + b"\x00\x00\x00\x10" + b"\x00" * 4
    c3, _ = _corpus_from(data3)
    check("truncated tail reported as a hole to EOF",
          texts(c3) == ["only"] and len(c3.holes) == 1
          and c3.holes[0]["end"] == len(data3), repr(c3.holes))

    # 7. The window filters on record timestamps, bounds echoed.
    fd, path = tempfile.mkstemp(suffix=".log")
    os.close(fd)
    try:
        with open(path, "wb") as f:
            f.write(data)
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "win.tsv")
            proc = subprocess.run(
                [sys.executable, _SCRIPT, "--path", path, "--emit", "--out", out,
                 "--since", "2026-11-27T00:02:00Z",
                 "--until", "2026-11-27T00:04:00Z"],
                capture_output=True, text=True, encoding="utf-8", errors="replace")
            body = open(out, "r", encoding="utf-8", errors="replace").read()
            check("window keeps only in-bounds records",
                  proc.returncode == 0
                  and [ln.split("\t")[2] for ln in body.strip().splitlines()]
                  == ["after-hole-1", "after-hole-2"], repr(body))
            check("window bounds are echoed on stderr",
                  "window: [2026-11-27T00:02:00.000Z, 2026-11-27T00:04:00.000Z)" in proc.stderr
                  and "lines in window: 2" in proc.stderr, repr(proc.stderr[-300:]))

        # 8. An empty window is an explicit answer, never bare silence.
        proc = subprocess.run(
            [sys.executable, _SCRIPT, "--path", path, "--json",
             "--since", "2026-11-27T05:00:00Z"],
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        payload = json.loads(proc.stdout)
        check("empty window is named, not silent",
              proc.returncode == 0 and payload["window"]["lines"] == 0
              and payload["window"]["since"] == "2026-11-27T05:00:00.000Z"
              and payload["last_ts"] == "2026-11-27T00:07:00.000Z", repr(payload.get("window")))

        # 9. CLI envelope: counts, holes and emitted lines agree with the module.
        proc = subprocess.run(
            [sys.executable, _SCRIPT, "--path", path, "--json", "--emit"],
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        payload = json.loads(proc.stdout)
        check("json envelope counts",
              payload["records_well_formed"] == 8
              and payload["empty_line_records"] == 1
              and payload["partial_flag_records"] == 1
              and payload["holes"] == 1
              and payload["break_bytes"] == 75
              and len(payload["lines"]) == 6, repr({k: payload[k] for k in (
                  "records_well_formed", "empty_line_records",
                  "partial_flag_records", "holes", "break_bytes")}))
        check("json lines carry ts/source/text",
              [ln["text"] for ln in payload["lines"]][:2] == ["before-hole-1", "before-hole-2"]
              and payload["lines"][1]["source"] == "stderr"
              and payload["lines"][0]["ts"] == "2026-11-27T00:00:00.000Z",
              repr(payload["lines"][:2]))
    finally:
        os.unlink(path)

    # 10. A hole that INTERRUPTS a record (the shape of the real corpus: zeros
    #     overwrite the middle of a frame) truncates docker logs on both drivers;
    #     the reader must resynchronise on the next record and say so.
    a = rec(line=b"alpha", ts_ns=T0)
    victim = rec(line=b"victim-line-to-be-zeroed", ts_ns=T0 + MIN)
    tail_rec = rec(line=b"omega", ts_ns=T0 + 2 * MIN)
    v0 = len(a) + 8            # victim's entry starts after its 4-byte header
    broken = bytearray(a + victim + tail_rec)
    broken[v0 + 4:v0 + 24] = b"\x00" * 20
    c4, _ = _corpus_from(bytes(broken))
    check("a record-interrupting hole resynchronises on the next record",
          texts(c4) == ["alpha", "omega"], repr(texts(c4)))
    check("the interrupting hole is reported with its bytes",
          len(c4.holes) == 1 and c4.holes[0]["zero_bytes"] >= 20,
          repr(c4.holes))

    # 11. A naive datetime is refused, never assumed UTC.
    try:
        reader.parse_iso("2026-11-27T00:00:00")
        raised = False
    except ValueError:
        raised = True
    check("naive datetime refused", raised)

    print("\n%d checks, %d failed" % (CHECKS[0], len(FAILS)))
    if FAILS:
        print("failed: %s" % ", ".join(FAILS))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
