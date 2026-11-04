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
  7. SESSION, THREE SHAPES -- the capture is an ENVELOPE (`{"body": {…}}`) but
     pre-envelope captures are bare bodies; `user_id` is JSON (CC >= 2.1) or the
     flat `user_<h>_account_<uuid>_session_<uuid>`. All three must yield the
     session id; a body with no metadata must yield None, not a fake bucket.
  8. PAIRING BY REQUEST NUMBER AS WRITTEN -- `req-1-0001-…` pairs with
     `resp-1-r0001-…` and `req-1-10000-…` with `resp-1-r10000-…`: the number
     keeps its rendering (zero-padded on older builds), and the response
     timestamp is NOT part of the pairing.
  9. USAGE IS MAX, NEVER SUMMED -- `message_start` carries the real input and
     the terminal delta the output; summing frames would multiply input by
     frame count (#179). A mid-stream smaller input must not win either.
  10. TOURS COUNT DISTINCT SESSIONS PER DAY -- two requests of one session are
     one tour; a session without an id stays out of the tour count but keeps
     its workspace row.
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


def pin_session_three_shapes():
    env = (b'{"body":{"metadata":{"user_id":"{\\"device_id\\":\\"d\\",\\"session_id\\":\\"'
           b'65230986-1c2d-4e3f-aabb-ccddeeff0011\\"}"}}}')
    _check(wsattr.session_key(env) == "65230986-1c2d-4e3f-aabb-ccddeeff0011",
           "envelope + JSON user_id -> session_id, got %r" % wsattr.session_key(env))
    flat = (b'{"body":{"metadata":{"user_id":'
            b'"user_ab12_account_c2608888-1234-4abc-9def-001122334455_session_99887766-aaaa-bbbb-cccc-111122223333"}}}')
    _check(wsattr.session_key(flat) == "99887766-aaaa-bbbb-cccc-111122223333",
           "envelope + flat user_id -> the uuid after `_session_`, got %r" % wsattr.session_key(flat))
    bare = (b'{"metadata":{"user_id":"{\\"session_id\\":\\"fedcba98-7654-3210-9876-543210fedcba\\"}"},'
            b'"model":"claude-sonnet-5-5"}')
    _check(wsattr.session_key(bare) == "fedcba98-7654-3210-9876-543210fedcba",
           "a pre-envelope bare body reads its top-level metadata, got %r" % wsattr.session_key(bare))


def pin_session_absent_is_none():
    _check(wsattr.session_key(b'{"body":{"messages":[]}}') is None,
           "no metadata -> None, never a fake session bucket")
    _check(wsattr.session_key(b'{"body":{"metadata":{"user_id":"opaque-not-a-session"}}}') is None,
           "a user_id carrying no session fragment -> None")


def pin_pairing_keeps_the_number_as_written():
    _check(wsattr.resp_prefix_for("req-1-0001-2026-11-03T00-32-58-676Z-direct.json") == "resp-1-r0001-",
           "zero-padded request number must keep its rendering in the resp prefix")
    _check(wsattr.resp_prefix_for("req-1-10000-2026-11-04T00-05-26-123Z-direct.json") == "resp-1-r10000-",
           "natural (unpadded) request number pairs with the natural resp prefix")
    _check(wsattr.resp_prefix_for("resp-1-r0001-2026-11-03T00-33-00-176Z-native-claude-opus-5-5") is None,
           "a resp name is not a request and must not pair with anything")


def pin_usage_is_max_never_summed():
    sse = (b'data: {"type":"message_start","message":{"usage":{"input_tokens":41200,"output_tokens":1}}}\n'
           b'data: {"type":"content_block_delta","usage":{"input_tokens":12,"output_tokens":40}}\n'
           b'data: {"type":"message_delta","usage":{"input_tokens":41200,"output_tokens":631}}\n')
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".sse", delete=False) as f:
        f.write(sse)
        p = f.name
    try:
        got = wsattr.usage_from_resp(p)
        _check(got == (41200, 631),
               "max of each axis across frames (41200, 631), got %r — a sum would read ~82k input" % (got,))
    finally:
        os.remove(p)
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w") as f:
        f.write('{"usage":{"input_tokens":900,"output_tokens":45},"type":"message"}')
        q = f.name
    try:
        _check(wsattr.usage_from_resp(q) == (900, 45), "a stream:false JSON response reads its top-level usage")
    finally:
        os.remove(q)


def pin_usage_nested_input_tokens_details():
    sse = b'data: {"usage":{"input_tokens_details":{"input_tokens":777},"output_tokens":12}}\n'
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".sse", delete=False) as f:
        f.write(sse)
        p = f.name
    try:
        _check(wsattr.usage_from_resp(p) == (777, 12),
               "input_tokens_details.input_tokens is the input when the flat field is absent")
    finally:
        os.remove(p)


def pin_tours_count_distinct_sessions():
    rows = [
        {"ws": "coursia", "session": "s1", "in": 100, "out": 10, "paired": True},
        {"ws": "coursia", "session": "s1", "in": 50, "out": 5, "paired": True},
        {"ws": "coursia", "session": "s2", "in": 25, "out": 2, "paired": False},
        {"ws": "claudish", "session": "s9", "in": 1, "out": 1, "paired": True},
        {"ws": "claudish", "session": None, "in": 2, "out": 0, "paired": True},
    ]
    agg = wsattr.aggregate_tours(rows, 0.5)
    w = agg["workspaces"]
    _check(w["coursia"]["tours"] == 2, "two distinct sessions -> 2 tours, got %r" % w["coursia"]["tours"])
    _check(w["coursia"]["reqs"] == 3 and w["coursia"]["in_tok"] == 175, "reqs and tokens aggregate linearly")
    _check(w["claudish"]["tours"] == 1, "a session-less request never mints a tour")
    _check(agg["no_session"] == 1, "the session-less request is counted as no_session, not dropped")
    _check(w["coursia"]["tours_hi"] == 4 and w["coursia"]["est_in_tok"] == 350,
           "tours_hi and est tokens divide by the sample fraction (0.5 here) — a BOUND, not an estimate")
    _check(w["coursia"]["paired"] == 2, "paired counts rows with a usage-bearing response")


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
    pin_session_three_shapes,
    pin_session_absent_is_none,
    pin_pairing_keeps_the_number_as_written,
    pin_usage_is_max_never_summed,
    pin_usage_nested_input_tokens_details,
    pin_tours_count_distinct_sessions,
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
