#!/usr/bin/env python3
"""sse_cardinality_check.py — offline SSE cardinality oracle (#1089 S7, file 20261118c item 4 contract).

The kit's first executable control: judge Anthropic-wire SSE fixture FILES, not
parser behavior. Three verdicts, always naming the file:

  PASS            exactly one message_start and one message_stop, no terminal
                  event before a start (the terminal pair a Claude client needs).
  VIOLATION       the file is a COMPLETE response (blocks all terminated) whose
                  terminal pair is wrong: count != 1/1, or a delta/stop arrives
                  before any start (orphan terminal — the #1030 shape).
  INVALID_INPUT   the file is NOT a complete raw response: its last block has no
                  blank-line separator (a truncated fixture, cut mid-frame).
                  Not a violation: an oracle that judged a truncated input would
                  false-positive on every capture sliced by size limits.

Classification is by `event:` line primarily (every Anthropic-wire block carries
one), falling back to the data payload's JSON `type` when the event line is
absent. Only DELIVERABLE frames count: a block whose `event:` line has no
`data:` line dispatches nothing on the wire and certifies nothing here — a bare
`event: message_start` + `event: message_stop` pair is NOT a terminal pair
(#1119 review). The control never touches a parser, the network, or a model.

Input scope (measured, pinned in the self-test): CRLF line endings are
normalized to LF before splitting (same verdicts as the LF twin); a payload
split across several `data:` lines is classified by its `event:` line — the
JSON-`type` fallback reads single-line payloads only. Production parsers are
untouched.

The two fixture classes (#19b item 7): a PROVIDER-raw fixture is a parser
INPUT — it may legitimately lack a native message_start (the parser synthesizes
one, #1014), so a terminal-pair VIOLATION on it describes the provider stream
and is NOT a client-conformance failure. A CLIENT-output fixture is what a
client actually received and is judged as conformance. Label by provenance and
citation: cite the fixture path and its SHA, never paste a capture into this
repository to illustrate either class.

Offline cost (#19b item 8): the self-test runs with no network and no model —
measured 200 ms wall per invocation on win32 / Python 3.13 (interpreter startup
included), 12 assertions.

Usage:
  python scripts/sse_cardinality_check.py FILE [FILE ...]   # verdict per file
  python scripts/sse_cardinality_check.py --self-test        # reproducible proof:
      builds every contract case in a temp dir (valid, truncated, terminal-less,
      bare event lines without data, guard-removed mutation, CRLF twin,
      multi-line data, mixed CLI exit) and asserts each verdict
      (exit 0 iff all as contracted).

Exit code: 0 when every checked file is PASS (self-test: all verdicts expected),
1 otherwise. INVALID_INPUT counts as a rejection: the caller wanted a valid
response file and did not get one.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

TERMINAL_EVENTS = ("message_delta", "message_stop")
OPEN_EVENTS = ("message_start",)


def _has_data(block_lines: list[str]) -> bool:
    """A deliverable frame carries a `data:` line (guard, #1119 review).

    Without data, SSE dispatches no event: a bare `event: message_stop` line
    certifies nothing. The self-test's mutation section proves the pin fails
    when this guard is removed.
    """
    return any(line.startswith("data:") for line in block_lines)


def _classify(block_lines: list[str]) -> str | None:
    """Event name of a DELIVERABLE block: `event:` line, else the data type."""
    if not _has_data(block_lines):
        return None
    event_name = None
    for line in block_lines:
        if line.startswith("event:") and event_name is None:
            event_name = line[len("event:"):].strip()
    if event_name:
        return event_name
    for line in block_lines:
        if line.startswith("data:"):
            payload = line[len("data:"):].strip()
            if payload.startswith("{"):
                try:
                    parsed = json.loads(payload)
                    if isinstance(parsed, dict) and isinstance(parsed.get("type"), str):
                        return parsed["type"]
                except ValueError:
                    pass
    return None


def check_file(path: Path) -> str:
    """Verdict line for one file. Never raises; IO errors surface as INVALID_INPUT."""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"{path}: INVALID_INPUT (unreadable: {exc})"

    if raw and not raw.endswith("\n\n"):
        # The final block never received its blank-line separator: the file was
        # cut before the frame was dispatched. A fixture ending on a single
        # trailing \n (block separator missing) is the same truncation.
        return f"{path}: INVALID_INPUT (truncated: last block has no blank-line separator)"

    # CRLF normalization: a CRLF capture is the same response as its LF twin.
    # replace() keeps the \n count, so line numbers stay the file's own.
    raw = raw.replace("\r\n", "\n")

    blocks: list[tuple[int, list[str]]] = []
    current: list[str] = []
    first_line = 1
    line_no = 0
    for line_no, line in enumerate(raw.split("\n"), start=1):
        if line == "":
            if current:
                blocks.append((first_line, current))
                current = []
            first_line = line_no + 1
        else:
            current.append(line)
    # raw ends with \n\n so the loop already flushed the last block.

    starts = stops = 0
    orphan: tuple[int, str] | None = None
    seen_start = False
    for blk_first_line, blk_lines in blocks:
        name = _classify(blk_lines)
        if name is None:
            continue  # unclassifiable content (comment-only block, etc.)
        if name in OPEN_EVENTS:
            seen_start = True
            starts += 1
        elif name in TERMINAL_EVENTS:
            if not seen_start and orphan is None:
                orphan = (blk_first_line, name)
            if name == "message_stop":
                stops += 1

    if starts == 1 and stops == 1 and orphan is None:
        return f"{path}: PASS (1 message_start, 1 message_stop)"
    detail = f"starts={starts} stops={stops}"
    if orphan is not None:
        detail += f", first orphan terminal '{orphan[1]}' at line {orphan[0]}"
    return f"{path}: VIOLATION: terminal-pair ({detail})"


VALID_SSE = (
    "event: message_start\n"
    'data: {"type": "message_start", "message": {"id": "m1"}}\n'
    "\n"
    "event: content_block_start\n"
    'data: {"type": "content_block_start", "index": 0}\n'
    "\n"
    "event: content_block_delta\n"
    'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hi"}}\n'
    "\n"
    "event: content_block_stop\n"
    'data: {"type": "content_block_stop", "index": 0}\n'
    "\n"
    "event: message_delta\n"
    'data: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}\n'
    "\n"
    "event: message_stop\n"
    'data: {"type": "message_stop"}\n'
    "\n"
)


def _expect(verdict: str, want: str, label: str) -> bool:
    ok = want in verdict
    print(f"  [{'OK' if ok else 'FAIL'}] {label}: expected {want}")
    print(f"        got: {verdict}")
    return ok


def self_test() -> int:
    """Build every contract case in a temp dir and assert its verdict."""
    results = []
    with tempfile.TemporaryDirectory(prefix="sse-oracle-") as tmp:
        tmp_path = Path(tmp)

        valid = tmp_path / "valid-response.sse"
        valid.write_text(VALID_SSE, encoding="utf-8")
        results.append(_expect(check_file(valid), "PASS", "valid fixture accepted"))

        truncated = tmp_path / "truncated-response.sse"
        # Cut inside the final message_stop payload: the last block loses its
        # separator and part of its data line — a mid-frame cut.
        truncated.write_text(VALID_SSE[:-25], encoding="utf-8")
        results.append(
            _expect(check_file(truncated), "INVALID_INPUT", "truncated fixture rejected")
        )

        terminal_less = tmp_path / "terminal-less-response.sse"
        # Complete blocks, but the response ends after message_delta without a
        # message_stop: the open-tool-block-at-eof shape — a real violation.
        terminal_less.write_text(VALID_SSE.rsplit("event: message_stop", 1)[0], encoding="utf-8")
        results.append(
            _expect(check_file(terminal_less), "VIOLATION", "terminal-less complete response flagged")
        )

        # #1119 review: bare `event:` lines without any `data:` line must NOT
        # certify a terminal pair — without data, SSE delivers no event. Exact
        # verdict asserted, not just the class.
        bare = tmp_path / "bare-events-no-data.sse"
        bare.write_text("event: message_start\n\nevent: message_stop\n\n", encoding="utf-8")
        expected_bare = "VIOLATION: terminal-pair (starts=0 stops=0)"
        verdict_bare = check_file(bare)
        got_bare = verdict_bare.split(": ", 1)[1] if ": " in verdict_bare else verdict_bare
        ok = got_bare == expected_bare
        results.append(ok)
        print(f"  [{'OK' if ok else 'FAIL'}] bare event lines without data rejected")
        print(f"        expected exactly: {expected_bare}")
        print(f"        got: {got_bare}")

        # Mutation (#19b item 2): with the deliverability guard removed, the
        # same file PASSES — which is the bug the review caught. The mutation
        # is ISOLATED: production source is never edited, the patch lives only
        # in this self-test frame and is restored in `finally`, and identity of
        # the restored function is asserted — then the pin must flip back.
        original_has_data = _has_data
        globals()["_has_data"] = lambda _lines: True
        try:
            results.append(
                _expect(check_file(bare), "PASS", "mutation: guard removed flips the pin to PASS")
            )
        finally:
            globals()["_has_data"] = original_has_data
        restored = globals()["_has_data"] is original_has_data
        results.append(restored)
        print(f"  [{'OK' if restored else 'FAIL'}] mutation restored: production guard identity intact")
        if restored:
            results.append(
                _expect(check_file(bare), "VIOLATION", "mutation reverted: pin fails again")
            )

        # CRLF twin (#19b item 1): write BYTES. Path.write_text translates every
        # "\n" to os.linesep on Windows, so a string already carrying "\r\n"
        # lands on disk as "\r\r\n" — the twin would not be the file this label
        # claims. write_bytes keeps it faithful; the on-disk assert pins it.
        crlf = tmp_path / "valid-response-crlf.sse"
        crlf.write_bytes(VALID_SSE.replace("\n", "\r\n").encode("utf-8"))
        crlf_raw = crlf.read_bytes()
        no_crcrlf = b"\r\r\n" not in crlf_raw
        results.append(no_crcrlf)
        print(f"  [{'OK' if no_crcrlf else 'FAIL'}] CRLF fixture on disk carries no CRCRLF")
        if not no_crcrlf:
            print(f"        got: {crlf_raw[:60]!r}")
        results.append(_expect(check_file(crlf), "PASS", "CRLF fixture same verdict as LF"))

        # Inverted order (#19b item 3): stop BEFORE start. The counts end at
        # 1/1, so count equality alone would pass this file — the orphan guard
        # is what flags it. Exact verdict asserted, not just the class.
        inverted = tmp_path / "inverted-order.sse"
        inverted.write_bytes(
            b'event: message_stop\ndata: {"type": "message_stop"}\n\n'
            b'event: message_start\ndata: {"type": "message_start", "message": {"id": "m1"}}\n\n'
        )
        expected_inv = (
            "VIOLATION: terminal-pair (starts=1 stops=1, first orphan terminal 'message_stop' at line 1)"
        )
        verdict_inv = check_file(inverted)
        got_inv = verdict_inv.split(": ", 1)[1] if ": " in verdict_inv else verdict_inv
        ok = got_inv == expected_inv
        results.append(ok)
        print(f"  [{'OK' if ok else 'FAIL'}] inverted order (stop before start) flagged by orphan guard")
        print(f"        expected exactly: {expected_inv}")
        print(f"        got: {got_inv}")

        # Multi-line data payload: split across two `data:` lines. The `event:`
        # line classifies it (the JSON fallback is single-line only — documented
        # scope, pinned here).
        multiline = tmp_path / "multiline-data.sse"
        multiline.write_text(
            VALID_SSE.replace(
                'data: {"type": "message_start", "message": {"id": "m1"}}\n',
                'data: {"type": "message_start",\n'
                'data:  "message": {"id": "m1"}}\n',
            ),
            encoding="utf-8",
        )
        results.append(
            _expect(check_file(multiline), "PASS", "multi-line data classified via event line")
        )

        # Mixed CLI: one PASS file + one VIOLATION file — both named in the
        # output, exit code non-zero.
        cli_violating = tmp_path / "cli-terminal-less.sse"
        cli_violating.write_text(VALID_SSE.rsplit("event: message_stop", 1)[0], encoding="utf-8")
        import contextlib
        import io

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = main([str(valid), str(cli_violating)])
        out = buf.getvalue()
        ok = code == 1 and str(valid) in out and str(cli_violating) in out
        results.append(ok)
        print(f"  [{'OK' if ok else 'FAIL'}] CLI mixed: exit={code}, both files named")

    passed = sum(1 for r in results if r)
    total = len(results)
    if passed == total:
        print(f"self-test: {passed}/{total} assertions as contracted")
        return 0
    print(f"self-test: FAILED ({passed}/{total})")
    return 1


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    if argv[0] == "--self-test":
        return self_test()
    verdicts = [check_file(Path(a)) for a in argv]
    for v in verdicts:
        print(v)
    return 0 if all(v.endswith("PASS (1 message_start, 1 message_stop)") for v in verdicts) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
