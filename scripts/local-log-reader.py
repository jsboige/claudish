#!/usr/bin/env python3
"""Read a Docker `local`-driver container.log, including past its zero-filled holes.

`docker logs` on a `local`-driver container stops at the first run of zero bytes in
the driver file and reports NOTHING for everything after it: exit 0, no warning.
Measured on po-2027, 2026-11-27 (#1231): a 21 461 496-byte file holding 174 366
records, `docker logs` returned 10 633 lines ending at the first hole
(2026-11-10T00:12:07Z) and `--since <anything later>` returned 0 lines -- a live
24 h window read as silence, in the direction that changes verdicts.

This reader parses the file itself and reports every break, so the answer is a
count with its bounds instead of an empty output.

Record format (measured, not documented upstream):
    [u32 BE len][protobuf entry][u32 BE len]
    entry fields: 1 (0a) source "stdout"|"stderr"; 2 (10) time_nano varint;
                  3 (1a) line bytes; 4+ optional flags (4 == 1: line continues)
A record with field 1 and 2 but NO field 3 is an EMPTY line (source + timestamp,
no text) -- counted as such, never a break: the po-2027 file holds 13 of them.
A break is bytes that yield no well-formed record; it is reported with its offset,
its length, how many of its bytes are zero, and the last/first good timestamps on
either side. Per break, `zero_bytes` against `end - start` separates a real
zero-fill (equal) from bytes a resync skipped (length larger). Resynchronisation
needs TWO consecutive well-formed records, so a false header inside a payload
cannot restart the read, and a candidate may have ANY length up to MAX_RECORD:
a frame of 128 bytes or more is as real as a short one. The first version capped
the candidate length below 128 bytes and swallowed every long record after a
hole (review 7231074433); the pins now carry frames of 120 to 421 bytes on both
sides of a hole.

What actually stops `docker logs` -- controlled probes on 2026-11-28, using an
image already on the host (no pull), one container per case:
  * a hole that INTERRUPTS a record truncates the read at that point on BOTH
    drivers: 10 lines before, 5 after, ending on the record just before the hole
    (`json-file` L1..L5, `local` L1..L5, file sizes 731 B and 301 B);
  * zeros appended exactly at a record boundary at end-of-file are skipped by the
    `local` reader (23 -> 27 lines while the file grew) but still stop
    `json-file` (stuck at 9 while the file held 15+ lines).
The po-2027 corpus matches NEITHER probe exactly, and that is stated rather than
forced. Its first hole is 75 bytes of pure zeros sitting BETWEEN two intact
records (the record before ends where the zeros begin, the next begins where
they end), with a 56 s gap in record timestamps across it (last good
2026-11-10T00:12:07.178Z, next good 00:13:03.392Z, no record in between) -- and
`docker logs` stops there for good. Zeros at a boundary in the MIDDLE of a file,
records written after them, were not reproduced under control (the end-of-file
probe above did not stop `local`); the difference is NOT established. What is
established: this reader skips no record there -- each hole of that file is
exactly its zeros (75/75 and 3 933/3 933) and the 24 h count is 10 805 lines
before and after the length fix.

Usage:
    python scripts/local-log-reader.py --path <container.log> [--hours N]
        [--since ISO] [--until ISO] [--tail N] [--emit] [--out FILE] [--json]

Default output is the summary (bounds, counts, every hole). --emit writes the
matching lines as TSV (ts, source, text) to stdout or --out; with --emit and no
--out the summary goes to stderr, so an empty window is never bare silence.

Exit: 0 = the file was read and the answer is a count (holes included);
      1 = the file is unreadable, empty, or larger than MAX_BYTES (named, never
          silent); 2 = bad arguments.

ASCII-only stdout/stderr (cp1252 seats). --out is UTF-8, errors="replace".
"""

import json
import os
import struct
import sys
from datetime import datetime, timedelta, timezone

MAX_BYTES = 256 * 1024 * 1024
MAX_RECORD = 16 * 1024 * 1024


def varint(b, i):
    """Decode a protobuf varint at b[i:]; -> (value, next_index)."""
    shift = 0
    val = 0
    while True:
        if i >= len(b):
            raise ValueError("varint runs past the end")
        c = b[i]
        i += 1
        val |= (c & 0x7F) << shift
        if not c & 0x80:
            return val, i
        shift += 7
        if shift > 70:
            raise ValueError("varint too long")


def parse_entry(frame):
    """-> (source, time_nano, line or None, flags) or None if malformed.

    `line is None` means the record carries no field 3 at all: an empty line.
    """
    i = 0
    source = None
    t = None
    line = None
    flags = []
    try:
        while i < len(frame):
            key, i = varint(frame, i)
            num, wt = key >> 3, key & 7
            if num == 0:
                raise ValueError("field 0")
            if wt == 0:
                v, i = varint(frame, i)
                if num == 2:
                    t = v
                else:
                    flags.append((num, v))
            elif wt == 2:
                ln, i = varint(frame, i)
                if i + ln > len(frame):
                    raise ValueError("bytes field runs past the end")
                payload = frame[i:i + ln]
                i += ln
                if num == 1:
                    source = payload.decode("ascii", "replace")
                elif num == 3:
                    line = payload
                else:
                    flags.append((num, ln))
            elif wt == 5:
                i += 4
            elif wt == 1:
                i += 8
            else:
                raise ValueError("wire type %d" % wt)
    except ValueError:
        return None
    if source is None or t is None:
        return None
    return source, t, line, flags


def plausible_header(b, off):
    """A header at `off` is plausible when its trailer matches and the entry parses."""
    if off + 8 > len(b):
        return None
    n = struct.unpack(">I", b[off:off + 4])[0]
    if n == 0 or n > MAX_RECORD or off + 8 + n > len(b):
        return None
    if struct.unpack(">I", b[off + 4 + n:off + 8 + n])[0] != n:
        return None
    parsed = parse_entry(b[off + 4:off + 4 + n])
    return None if parsed is None else (n, parsed)


def iso(ns):
    """UTC ISO-8601 with milliseconds, from nanoseconds."""
    return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def parse_iso(text):
    """ISO-8601 -> epoch nanoseconds. A naive value is refused, never assumed UTC."""
    s = text.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        raise ValueError("naive datetime refused (give Z or an offset): %s" % text)
    return int(dt.timestamp() * 1e9)


class Corpus(object):
    """One decoded driver file: records, holes, and the counts that qualify them."""

    def __init__(self):
        self.records = []       # (offset, source, ts_ns, text)
        self.holes = []         # dict(start, end, zero_bytes, last_good_ns, next_good_ns)
        self.empty_records = 0
        self.partial_records = 0
        self.total_records = 0
        self.bytes = 0
        self.first_ts = None
        self.last_ts = None

    def window(self, since_ns=None, until_ns=None):
        """Records whose own timestamp is in [since, until); bounds echoed by the caller."""
        return [r for r in self.records
                if (since_ns is None or r[2] >= since_ns)
                and (until_ns is None or r[2] < until_ns)]

    def summary(self):
        return {
            "file_bytes": self.bytes,
            "records_well_formed": self.total_records,
            "empty_line_records": self.empty_records,
            "partial_flag_records": self.partial_records,
            "lines_emitted": len(self.records),
            "holes": len(self.holes),
            "break_bytes": sum(h["end"] - h["start"] for h in self.holes),
            "first_ts": iso(self.first_ts) if self.first_ts else None,
            "last_ts": iso(self.last_ts) if self.last_ts else None,
        }


def read_corpus(path):
    """Decode a `local`-driver container.log -> Corpus. Raises IOError when unusable."""
    size = os.path.getsize(path)
    if size == 0:
        raise IOError("empty file: %s" % path)
    if size > MAX_BYTES:
        raise IOError("file is %d bytes, above the %d-byte bound (refused, not read)"
                      % (size, MAX_BYTES))
    with open(path, "rb") as f:
        b = f.read()

    c = Corpus()
    c.bytes = len(b)
    pending = {}   # source -> (ts_ns, accumulated bytes): flag 4 == 1 continues
    last_emitted = None
    off = 0
    while off < len(b):
        h = plausible_header(b, off)
        if h is None:
            found = None
            scan = off + 1
            while scan + 8 <= len(b):
                # ANY length up to MAX_RECORD is a candidate. A frame of 128
                # bytes or more is a real record, not a suspect (a [ttft] line
                # with its model, machine and timings is well past 100 chars).
                # The first version capped the length at 128 bytes and swallowed
                # every long record after a hole (#1231, CR 7231074433). The
                # trailer check in plausible_header rejects false candidates.
                n_scan = struct.unpack(">I", b[scan:scan + 4])[0]
                if 0 < n_scan <= MAX_RECORD:
                    cand = plausible_header(b, scan)
                    if cand is not None:
                        n2 = cand[0]
                        nxt = scan + 8 + n2
                        # Two consecutive well-formed records, or one running to EOF.
                        if nxt >= len(b) or plausible_header(b, nxt) is not None:
                            found = (scan, cand)
                            break
                scan += 1
            if found is None:
                c.holes.append({"start": off, "end": len(b),
                                "zero_bytes": b[off:].count(0),
                                "last_good_ns": last_emitted, "next_good_ns": None})
                off = len(b)
                break
            scan, cand = found
            c.holes.append({"start": off, "end": scan,
                            "zero_bytes": b[off:scan].count(0),
                            "last_good_ns": last_emitted,
                            "next_good_ns": cand[1][1]})
            off = scan
            continue

        n, (source, t, line, flags) = h
        c.total_records += 1
        if c.first_ts is None:
            c.first_ts = t
        c.last_ts = t
        if line is None:
            # source + timestamp, no field 3: an EMPTY line, not a break.
            c.empty_records += 1
            last_emitted = t
            off += 8 + n
            continue
        is_partial = any(num == 4 and v == 1 for num, v in flags)
        if is_partial:
            c.partial_records += 1
        acc_ts, acc = pending.pop(source, (None, b""))
        merged = acc + line
        use_ts = acc_ts if acc_ts is not None else t
        if is_partial:
            pending[source] = (use_ts, merged)
        else:
            last_emitted = use_ts
            c.records.append((off, source, use_ts, merged))
        off += 8 + n
    for source, (use_ts, merged) in pending.items():
        # An unterminated line is emitted, marked -open, never dropped.
        c.records.append((off, source + "-open", use_ts, merged))
    return c


def render_summary(c, since_ns=None, until_ns=None, matched=None):
    s = c.summary()
    lines = [
        "file bytes: %d" % s["file_bytes"],
        "records well-formed: %d (empty-line: %d, partial-flag: %d)"
        % (s["records_well_formed"], s["empty_line_records"], s["partial_flag_records"]),
        "lines emitted: %d" % s["lines_emitted"],
        "first ts: %s" % s["first_ts"],
        "last ts: %s" % s["last_ts"],
        "holes: %d (%d bytes inside breaks)" % (s["holes"], s["break_bytes"]),
    ]
    for h in c.holes:
        lines.append("  HOLE off %d..%d (%d bytes, %d zero) last-good=%s next-good=%s" % (
            h["start"], h["end"], h["end"] - h["start"], h["zero_bytes"],
            iso(h["last_good_ns"]) if h["last_good_ns"] else None,
            iso(h["next_good_ns"]) if h["next_good_ns"] else None))
    if since_ns is not None or until_ns is not None:
        lines.append("window: [%s, %s)" % (
            iso(since_ns) if since_ns is not None else None,
            iso(until_ns) if until_ns is not None else None))
        lines.append("lines in window: %d" % (len(matched) if matched is not None else 0))
    return "\n".join(lines)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    path = None
    hours = None
    since_s = until_s = None
    tail = None
    emit = False
    out = None
    as_json = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--path":
            i += 1
            path = argv[i] if i < len(argv) else None
        elif a == "--hours":
            i += 1
            hours = float(argv[i])
        elif a == "--since":
            i += 1
            since_s = argv[i]
        elif a == "--until":
            i += 1
            until_s = argv[i]
        elif a == "--tail":
            i += 1
            tail = int(argv[i])
        elif a == "--out":
            i += 1
            out = argv[i]
        elif a == "--emit":
            emit = True
        elif a == "--json":
            as_json = True
        else:
            sys.stderr.write("unknown argument: %s\n" % a)
            return 2
        i += 1
    if not path:
        sys.stderr.write("--path is required (the container.log to read)\n")
        return 2

    try:
        c = read_corpus(path)
    except (IOError, OSError) as exc:
        sys.stderr.write("unreadable: %s\n" % exc)
        return 1

    # --hours is relative to the LAST RECORD, not to now: a corpus may be older
    # than the wall clock, and "the last 24 h of this file" must say which end.
    until_ns = None
    since_ns = None
    if hours is not None:
        if c.last_ts is None:
            sys.stderr.write("--hours needs a corpus with at least one record\n")
            return 1
        until_ns = c.last_ts + 1
        since_ns = c.last_ts - int(hours * 3600 * 1e9)
    if since_s:
        since_ns = parse_iso(since_s)
    if until_s:
        until_ns = parse_iso(until_s)

    matched = c.window(since_ns, until_ns)
    if tail is not None and tail >= 0:
        matched = matched[-tail:] if tail else []

    summary = render_summary(c, since_ns, until_ns, matched)
    if as_json:
        payload = c.summary()
        payload["window"] = {
            "since": iso(since_ns) if since_ns is not None else None,
            "until": iso(until_ns) if until_ns is not None else None,
            "lines": len(matched),
        }
        payload["hole_detail"] = [
            {"start": h["start"], "end": h["end"], "zero_bytes": h["zero_bytes"],
             "last_good": iso(h["last_good_ns"]) if h["last_good_ns"] else None,
             "next_good": iso(h["next_good_ns"]) if h["next_good_ns"] else None}
            for h in c.holes]
        if emit:
            payload["lines"] = [
                {"ts": iso(ts), "source": src, "text": txt.decode("utf-8", "replace")}
                for (_off, src, ts, txt) in matched]
        sys.stdout.buffer.write(
            (json.dumps(payload, ensure_ascii=True) + "\n").encode("ascii"))
        return 0

    if not emit:
        sys.stdout.buffer.write((summary + "\n").encode("ascii", "replace"))
        return 0

    # --emit: lines to --out (or stdout), summary to stderr so it is never lost.
    dst = open(out, "w", encoding="utf-8", errors="replace", newline="\n") if out else None
    for (_off, src, ts, txt) in matched:
        line = "%s\t%s\t%s\n" % (iso(ts), src, txt.decode("utf-8", "replace").rstrip("\r\n"))
        if dst:
            dst.write(line)
        else:
            sys.stdout.buffer.write(line.encode("utf-8", "replace"))
    if dst:
        dst.close()
    sys.stderr.buffer.write((summary + "\n").encode("ascii", "replace"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
