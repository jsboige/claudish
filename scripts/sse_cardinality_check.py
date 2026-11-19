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
absent. The control never touches a parser, the network, or a model.

Usage:
  python scripts/sse_cardinality_check.py FILE [FILE ...]   # verdict per file
  python scripts/sse_cardinality_check.py --self-test        # reproducible proof:
      builds a valid, a truncated and a terminal-less response in a temp dir and
      asserts the three verdicts (exit 0 iff all as contracted).

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


def _classify(block_lines: list[str]) -> str | None:
    """Event name of a block: the `event:` line, else the data payload's type."""
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
    """Build the three contract cases in a temp dir and assert their verdicts."""
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

    if all(results):
        print("self-test: 3/3 verdicts as contracted")
        return 0
    print("self-test: FAILED")
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
