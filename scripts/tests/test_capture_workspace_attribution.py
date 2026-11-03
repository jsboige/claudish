#!/usr/bin/env python3
"""Pins for capture-workspace-attribution.py (#328 M1 / #445).

Each pin defends a reading that a plausible implementation gets WRONG, and that
would silently manufacture a conclusion about WHERE the fleet's responses go:

  1. PREVIOUS-DIRECTORY SUFFIX -- from ~2026-09-08 the environment preamble reads
     `d:\\dev\\CoursIA (was c:\\dev\\CoursIA)`. Splitting on the separator without
     dropping the suffix yields `coursia)`; measured on one day of that week, 38
     of 300 sampled bodies landed in `coursia)`, 33 in `coursia-2)`, 13 in
     `roo-extensions)`. Every workspace was split in two.
  2. PATH SEGMENT ENDING IN `n` -- the escaped newline is `\\n` and a literal
     separator is also a backslash, so a naive search cuts `d:\\dev\\new` at `d:`.
     That artefact produced a `d:` workspace bucket in the first run.
  3. LAST MARKER WINS -- a body may quote another preamble in a tool_result or a
     compaction summary; the request's own directory is the last one.
  4. ABSENCE OF THE MARKER IS A CLASS, NOT A GAP -- the preamble is Claude Code's,
     so a body without it is non-CC traffic. It must stay in the denominator
     under `(non-cc)`: that population can never produce a PR, and dropping it is
     exactly what makes a per-PR ratio read as a productivity regression.
  5. A REAL WORKSPACE NAMED WITH PARENTHESES SURVIVES -- only a `(was …)` /
     `(previously …)` group is removed; a leaf that merely ends in `)` keeps it,
     so the fix cannot degenerate into "strip any trailing punctuation".
  6. WEEK GROUPING -- `--week` is Monday-based, so a Wednesday argument measures
     the Monday..Sunday week that contains it rather than a rolling 7 days.
"""

import importlib.util
import os
import sys
from datetime import date, timedelta

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.environ.get(
    "WORKSPACE_ATTRIBUTION_TARGET",
    os.path.join(os.path.dirname(_HERE), "capture-workspace-attribution.py"),
)

_spec = importlib.util.spec_from_file_location("wsattr", _TARGET)
wsattr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wsattr)


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def _body(escaped_marker: bytes, prefix: bytes = b"") -> bytes:
    """A body carrying one environment preamble, JSON-escaped like a capture body."""
    return (
        prefix
        + b'{"messages":[{"role":"user","content":"<env>\\nPrimary working directory: '
        + escaped_marker
        + b'\\n - Is a git repository: true\\n - Platform: win32\\n</env>"}]}'
    )


def pin_plain_path():
    key, cc = wsattr.workspace_key(_body(b"d:\\\\dev\\\\CoursIA"))
    _check(cc is True, "a body carrying the preamble is Claude Code traffic")
    _check(key == "coursia", "plain path -> 'coursia', got %r" % key)


def pin_previous_directory_suffix():
    key, _ = wsattr.workspace_key(_body(b"d:\\\\dev\\\\CoursIA (was c:\\\\dev\\\\CoursIA)"))
    _check(key == "coursia", "the `(was …)` suffix must be dropped, got %r" % key)
    _check(key != "coursia)", "regression: `coursia)` splits one workspace into two buckets")

    key2, _ = wsattr.workspace_key(_body(b"c:\\\\dev\\\\CoursIA-2 (previously d:\\\\CoursIA-2)"))
    _check(key2 == "coursia-2", "`(previously …)` is the same trap, got %r" % key2)


def pin_path_truncated_before_a_segment_starting_with_n():
    leaf = b"d:\\\\dev\\\\newproject"
    key, _ = wsattr.workspace_key(_body(leaf))
    _check(key == "newproject", "a segment starting with `n` must survive, got %r" % key)
    cut = leaf.find(b"\\n")
    _check(cut == 8, "the naive `\\n` search really does cut inside the separator: %d" % cut)
    _check(leaf[:cut].decode().endswith("dev\\") and "newproject" not in leaf[:cut].decode(),
           "the naive cut truncates the leaf to the PREVIOUS segment: %r" % leaf[:cut].decode())


def pin_last_marker_wins():
    quoted = b'{"messages":[{"role":"tool_result","content":"Primary working directory: d:\\\\dev\\\\old"}]}'
    body = _body(b"d:\\\\dev\\\\claudish", prefix=quoted)
    key, _ = wsattr.workspace_key(body)
    _check(key == "claudish", "the request's own (last) preamble wins, got %r" % key)


def pin_no_marker_is_its_own_class():
    key, cc = wsattr.workspace_key(b'{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"hi"}]}')
    _check(cc is False, "a body without the preamble is not Claude Code traffic")
    _check(key == wsattr.NON_CC, "it must be bucketed %r, got %r" % (wsattr.NON_CC, key))


def pin_quoted_code_is_not_a_workspace():
    # The marker string also appears in source code that talks ABOUT the marker
    # (this very file, a docstring quoted into a prompt). Measured on 2026-09-08:
    # one body in 301 produced the key `n]+)') {` out of a regex line.
    key, cc = wsattr.workspace_key(_body(b"n]+)') {"))
    _check(key == wsattr.UNPARSED, "a non-path fragment must be bucketed visibly, got %r" % key)
    _check(cc is True, "it is still Claude Code traffic — only the directory is unreadable")


def pin_parenthesised_workspace_survives():
    key, _ = wsattr.workspace_key(_body(b"d:\\\\dev\\\\stage-2 (bis)"))
    _check(key == "stage-2 (bis)", "a real parenthesised leaf must be kept, got %r" % key)


def pin_trailing_separator_and_case():
    key, _ = wsattr.workspace_key(_body(b"D:\\\\Dev\\\\Claudish\\\\"))
    _check(key == "claudish", "trailing separator + case, got %r" % key)


def pin_week_grouping_is_monday_based():
    wednesday = date(2026, 9, 9)
    monday = wednesday - timedelta(days=wednesday.weekday())
    _check(monday == date(2026, 9, 7), "a Wednesday belongs to the Monday 07/09 week")
    weeks = wsattr.periods(monday, monday + timedelta(days=6), weekly=True)
    _check(len(weeks) == 1, "a Monday..Sunday span is ONE week, got %d" % len(weeks))
    _check(weeks[0][0] == "2026-09-07" and weeks[0][-1] == "2026-09-13",
           "the week runs Monday..Sunday: %r" % (weeks[0],))


PINS = [
    pin_plain_path,
    pin_previous_directory_suffix,
    pin_path_truncated_before_a_segment_starting_with_n,
    pin_last_marker_wins,
    pin_no_marker_is_its_own_class,
    pin_quoted_code_is_not_a_workspace,
    pin_parenthesised_workspace_survives,
    pin_trailing_separator_and_case,
    pin_week_grouping_is_monday_based,
]


def main():
    failed = 0
    for p in PINS:
        try:
            p()
            print("PASS %s" % p.__name__)
        except AssertionError as exc:
            failed += 1
            print("FAIL %s: %s" % (p.__name__, exc))
    print("%d/%d pins pass" % (len(PINS) - failed, len(PINS)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
