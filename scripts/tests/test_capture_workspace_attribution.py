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
  11. HISTORY REPLAY (#328 C4) -- a tool_use block rides EVERY later request
     of its session (~151k occurrences over 2 077 sampled requests, 29/10);
     a write class per tour is decided over DISTINCT tool_use ids, never over
     occurrences.
  12. QUOTED TRANSCRIPTS -- a pasted conversation inside a USER message
     carries tool_use-shaped JSON; only assistant messages are walked.
  13. THE REHEARSAL -- `gh pr merge --dry-run` and `git push --dry-run` are
     measured corpus shapes, and a compound can hold rehearsal and real merge
     back to back; the veto is per command segment (`;` `&&` `||` newline),
     never per whole command.
  14. TOOLSEARCH IS NOT A WRITE -- a ToolSearch input selecting
     `roosync_dashboard` mentions the tool by name; only the dashboard tool
     itself with a write action writes.
  15. COMPACTION HIDES EARLY WRITES -- a tour whose history starts past a
     compaction fold is flagged, never folded silently into zero-write.
"""

import importlib.util
import json
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


def _tub(prefix, use_id, tool, inp):
    """One assistant tool_use block inside a request body."""
    return (b'{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"' + prefix
            + use_id + b'","name":"' + tool + b'","input":' + inp + b'}]}]}')


def pin_history_replay_dedupes_by_id():
    # ONE `gh pr create` seen on 3 requests (later requests replay the block)
    rows = [
        {"day": "2026-10-29", "ws": "coursia", "session": "s1", "compacted": False,
         "uses": [(b"toolu_1", "Bash") + wsattr.classify_tool_use(
             "Bash", {"command": "gh pr create --title x --body-file b.md"}),
             (b"toolu_read", "Read") + (None, False)]},
        {"day": "2026-10-30", "ws": "coursia", "session": "s1", "compacted": False,
         "uses": [(b"toolu_1", "Bash") + wsattr.classify_tool_use(
             "Bash", {"command": "gh pr create --title x --body-file b.md"})]},
        {"day": "2026-10-31", "ws": "coursia", "session": "s1", "compacted": False,
         "uses": [(b"toolu_1", "Bash") + wsattr.classify_tool_use(
             "Bash", {"command": "gh pr create --title x --body-file b.md"})]},
    ]
    agg = wsattr.aggregate_writes(rows, {"2026-10-29": 3, "2026-10-30": 3, "2026-10-31": 3})
    w = agg["workspaces"]["coursia"]
    _check(w["tours"] == 3, "a session on 3 days is 3 per-day tours (as --tours), got %r" % w["tours"])
    _check(w["classes"].get("pr") == 3, "each day's tour carries the write (history), got %r" % w["classes"])
    _check(w["pr_create_counted"] == 1, "one creation counted despite 3 occurrences, got %r"
           % w["pr_create_counted"])
    _check(w["pr_create_scaled"] == 3, "the SCALED creation also dedupes: 1 id at first-seen day,"
           " fraction 1/3 -> 3.0 — occurrence-counting reads 9.0, got %r" % w["pr_create_scaled"])


def pin_quoted_transcript_is_not_a_write():
    _check(wsattr.assistant_tool_uses({"messages": [
        {"role": "user", "content": [{"type": "tool_use", "id": "t", "name": "Bash",
                                      "input": {"command": "gh pr merge 1"}}]}]}) == [],
           "a tool_use shape inside a USER message is never a write")


def pin_dry_run_is_not_a_write():
    cls, _ = wsattr.classify_tool_use("Bash", {"command": "gh pr merge 108 --squash --dry-run"})
    _check(cls is None, "a --dry-run merge is a rehearsal, got %r" % cls)
    cls2, _ = wsattr.classify_tool_use("Bash", {"command": "git push --dry-run origin main"})
    _check(cls2 is None, "a --dry-run push is a rehearsal, got %r" % cls2)
    # the corpus holds rehearsal and real merge in ONE compound
    cls3, _ = wsattr.classify_tool_use("Bash", {
        "command": "gh pr merge 108 --squash --dry-run | head -20; gh pr merge 108 --squash"})
    _check(cls3 == "pr", "the real merge in the SAME compound still writes, got %r" % cls3)


def pin_toolsearch_is_not_a_dashboard_write():
    cls, _ = wsattr.classify_tool_use("ToolSearch", {
        "query": "select:mcp__roo-state-manager__roosync_dashboard"})
    _check(cls is None, "naming a tool in a ToolSearch query is not a write, got %r" % cls)
    cls2, _ = wsattr.classify_tool_use("mcp__roo-state-manager__roosync_dashboard",
                                       {"action": "read", "type": "workspace"})
    _check(cls2 is None, "a dashboard READ is not a write, got %r" % cls2)
    cls3, _ = wsattr.classify_tool_use("mcp__roo-state-manager__roosync_dashboard",
                                       {"action": "append", "content": "[DONE]"})
    _check(cls3 == "dash", "a dashboard append IS the dash class, got %r" % cls3)


def pin_compaction_flags_the_tour():
    _check(wsattr.compaction_flagged({
        "messages": [{"role": "user", "content": "This session is being continued from a "
                     "previous conversation that ran out of context. The summary below "
                     "covers the earlier portion of the conversation."}]}) is True,
           "the continuation marker flags the tour compacted")
    _check(wsattr.compaction_flagged({
        "messages": [{"role": "user", "content": "fix the build"}]}) is False,
           "an ordinary first message is not compacted")


def pin_fleet_push_forms_and_quoted_words():
    # The forms the fleet rules MANDATE since #4243 — a `\bgit\s+push\b` regex
    # reads None on all three (measured by the #857 review on this corpus).
    cls, pc = wsattr.classify_tool_use("Bash", {
        "command": 'git -C D:/claudish/.tmp/wt-854 push origin HEAD'})
    _check(cls == "pr", "`git -C <path> push` is the mandated push form, got %r" % cls)
    _check(pc is False, "a push is not a pr CREATION, got %r" % pc)
    cls2, _ = wsattr.classify_tool_use("Bash", {
        "command": 'git -c credential.helper= -c "credential.helper=!gh auth git-credential"'
                   ' push -q origin HEAD'})
    _check(cls2 == "pr", "the ai-01 push form (two -c globals) writes, got %r" % cls2)
    cls3, pc3 = wsattr.classify_tool_use("Bash", {
        "command": "gh -R jsboige/claudish pr create --title x"})
    _check(cls3 == "pr" and pc3 is True, "a global -R before `pr create` still counts"
           " (and is a CREATION), got %r/%r" % (cls3, pc3))
    # the same walk refuses the words when they are not the act (TRAP W7):
    # quoted argument, grepped text, and git's OTHER subcommands.
    for cmd in ('git commit -m "then git push"',
                'grep "gh pr create" scripts/lib/log.txt',
                "git log --oneline -5",
                "gh auth token -u jsboige",
                "gh pr list --limit 5"):
        got, _ = wsattr.classify_tool_use("Bash", {"command": cmd})
        _check(got is None, "%r carries the words, not the act — None, got %r" % (cmd, got))


def pin_dm_send_is_a_write():
    m = wsattr.MSGS_TOOL
    cls, _ = wsattr.classify_tool_use(m, {"action": "send", "to": "myia-ai-01:claudish",
                                          "subject": "[TASK] file v41"})
    _check(cls == "dm", "a dispatch DM is the tour's output for a coordinator, got %r" % cls)
    cls2, _ = wsattr.classify_tool_use(m, {"action": "reply", "message_id": "x", "body": "ACK"})
    _check(cls2 == "dm", "a reply writes, got %r" % cls2)
    for ro in ("inbox", "message", "mark_read", "archive", "stats"):
        got, _ = wsattr.classify_tool_use(m, {"action": ro})
        _check(got is None, "%s is bookkeeping, not a write, got %r" % (ro, got))
    # a tour whose only external output is the dispatch DM is NOT zero-write
    rows = [{"day": "2026-10-29", "ws": "claudish", "session": "s2", "compacted": False,
             "uses": [(b"m1", m) + wsattr.classify_tool_use(
                 m, {"action": "send", "subject": "file v41"})]}]
    agg = wsattr.aggregate_writes(rows, {"2026-10-29": 1})
    _check(agg["workspaces"]["claudish"]["classes"].get("dm") == 1,
           "the dm class keeps a dispatch-only tour out of zero-write, got %r"
           % agg["workspaces"]["claudish"]["classes"])


def pin_cron_stamp_is_per_request_and_header_confined():
    # post-#98: the capture ENVELOPE's workload decides, and it decides for
    # BOTH values — a header saying cron must not override "interactive".
    _check(wsattr.cron_flagged({"workload": "cron"}, {}) is True,
           "an envelope workload=cron is a fire")
    _check(wsattr.cron_flagged({"workload": "interactive"},
                               {"system": "cc_workload=cron"}) is False,
           "the envelope arbitrates; a stray header never overrides it")
    # pre-#98 fallback: the billing header inside `system`
    _check(wsattr.cron_flagged({}, {"system": [{"type": "text",
                                               "text": "x-anthropic-billing-header: cc_workload=cron;"
                                                       " cc_entrypoint=cli"}]}) is True,
           "the pre-#98 header in system[0] stamps the request")
    _check(wsattr.cron_flagged({}, {"system": "cc_workload=cron"}) is True,
           "system as a bare string is read too")
    # CONFINEMENT: a transcript pasted in `messages` quotes the marker and must
    # not stamp the request (the W2/W7 trap, avoided by not grepping the file)
    _check(wsattr.cron_flagged({}, {"messages": [{"role": "user", "content":
                                                 "look: cc_workload=cron is what we grep"}]}) is False,
           "a quoted marker in the conversation is not a stamp")
    _check(wsattr.cron_flagged({}, {"system": "cc_workload=interactive"}) is False,
           "another workload value is not cron")


def pin_cadence_separates_cron_from_human():
    dash = wsattr.classify_tool_use(wsattr.DASH_TOOL, {"action": "append", "content": "[DONE]"})
    rows = [
        # tour s1 is cron-driven (one marked row suffices — TRAP C1), 3 sampled
        # requests of which 2 carry the stamp, and it writes once
        {"day": "2026-10-29", "ws": "claudish", "session": "s1", "compacted": False,
         "cron": False, "uses": [(b"a1", "Bash") + (None, False)]},
        {"day": "2026-10-29", "ws": "claudish", "session": "s1", "compacted": False,
         "cron": True, "uses": [(b"a1", "Bash") + (None, False)]},
        {"day": "2026-10-29", "ws": "claudish", "session": "s1", "compacted": False,
         "cron": True, "uses": [(b"a1", "Bash") + (None, False),
                                (b"d1", wsattr.DASH_TOOL) + dash]},
        # tour s2 is human-driven and writes nothing
        {"day": "2026-10-29", "ws": "claudish", "session": "s2", "compacted": False,
         "cron": False, "uses": [(b"a2", "Read") + (None, False)]},
    ]
    agg = wsattr.aggregate_writes(rows, {"2026-10-29": 8})
    c = agg["workspaces"]["claudish"]["cadence"]["cron"]
    h = agg["workspaces"]["claudish"]["cadence"]["human"]
    _check(c["tours"] == 1 and h["tours"] == 1, "one cron tour, one human, got %r/%r"
           % (c["tours"], h["tours"]))
    _check(c["pct_zero"] == 0.0 and h["pct_zero"] == 100.0,
           "the writing tour is the cron one, got cron=%r human=%r" % (c["pct_zero"], h["pct_zero"]))
    _check(c["classes"] == {"dash": 1}, "cron class breakdown, got %r" % (c["classes"],))
    _check(c["writes_per_tour"] == 1.0 and c["reqs_per_write"] == 3.0,
           "one write over 3 reqs, got %r/%r" % (c["writes_per_tour"], c["reqs_per_write"]))
    # a marked row is a REQUEST inside the fire, never a fire: 2 marked rows in
    # 1 tour stays 2.0 — unscaled, even though the stride sampled only half the
    # day (scaling it would read 4.0 and invent fires out of turn depth)
    _check(c["marked_rows_per_tour"] == 2.0,
           "marked rows count inside the tour, unscaled, got %r"
           % c["marked_rows_per_tour"])


def pin_gh_write_class_and_precedence():
    cls, pc = wsattr.classify_tool_use("Bash", {"command": "git push origin feature/x"})
    _check(cls == "pr", "git push is the pr class, got %r" % cls)
    _check(pc is False, "a push is not a pr CREATION, got %r" % pc)
    cls2, _ = wsattr.classify_tool_use("PowerShell", {
        "command": "GH_TOKEN=$(gh auth token) gh issue comment 18770 --body \"[CLAIMED]\""})
    _check(cls2 == "gh-write", "gh issue comment (the [CLAIMED] convention) is gh-write, got %r" % cls2)
    cls3, _ = wsattr.classify_tool_use("Bash", {"command": "gh pr review 42 --approve"})
    _check(cls3 == "gh-write", "gh pr review is gh-write, got %r" % cls3)
    # a Bash tool that carries no command input (read-only tool) writes nothing
    cls4, _ = wsattr.classify_tool_use("Read", {"file_path": "x.md"})
    _check(cls4 is None, "a file read is zero-write, got %r" % cls4)
    # strongest class wins a tour: dash + pr in one tour -> pr
    rows = [{"day": "2026-10-29", "ws": "claudish", "session": "s7", "compacted": False,
             "uses": [(b"d1", "mcp__roo-state-manager__roosync_dashboard")
                      + wsattr.classify_tool_use("mcp__roo-state-manager__roosync_dashboard",
                                                 {"action": "append", "content": "[DONE]"}),
                      (b"p1", "Bash") + wsattr.classify_tool_use(
                          "Bash", {"command": "gh pr create --title x"})]}]
    agg = wsattr.aggregate_writes(rows, {"2026-10-29": 1})
    _check(agg["workspaces"]["claudish"]["classes"] == {"pr": 1},
           "pr outranks dash within one tour, got %r" % agg["workspaces"]["claudish"]["classes"])


def pin_served_model_from_resp_name():
    # Shapes copied from real captures (06/22 archive and the live 11/05 dir).
    sse = wsattr.served_model("resp-1-r0003-2026-06-22T06-55-49-811Z-openai-qwen3.6-35b-a3b.sse")
    _check(sse == "openai-qwen3.6-35b-a3b", "the served id is everything after the timestamp, got %r" % sse)
    nat = wsattr.served_model("resp-1-r0001-2026-06-22T06-55-46-500Z-native-claude-opus-4-8.sse")
    _check(nat == "native-claude-opus-4-8", "the wire prefix is kept, got %r" % nat)
    js = wsattr.served_model("resp-2-r17-2026-11-05T08-19-50-009Z-openai-swift-1.5-27b.json")
    _check(js == "openai-swift-1.5-27b", "a buffered (.json) response names its model too, got %r" % js)
    _check(wsattr.served_model("req-1-0001-2026-06-22T06-55-46-378Z-direct.json") is None,
           "a request name is not a response name")


def pin_model_family_mapping():
    cases = {
        "openai-glm-5.2": "glm",
        "anthropic-glm-5.3": "glm",
        "openai-swift-1.5-27b": "swift",
        "openai-qwen3.6-35b-a3b": "qwen",
        "native-claude-opus-4-8": "claude",
        "anthropic-MiniMax-M3.1-Flash": "minimax",
        "openai-deepseek-v4.1-flash-1017": "deepseek",
        "openai-k3": "kimi",
        "openai-gpt-6-luna": "openai",
        "openai-something-new": "other",
    }
    for served, fam in cases.items():
        got = wsattr.model_family(served)
        _check(got == fam, "%s -> %s expected, got %r" % (served, fam, got))
    _check(wsattr.model_family(None) == wsattr.NO_RESP, "no paired response is its own class, never 'other'")


def pin_families_aggregate_per_workspace():
    rows = [
        {"ws": "coursia", "session": "s1", "in": 1, "out": 1, "paired": True, "model": "anthropic-glm-5.2"},
        {"ws": "coursia", "session": "s1", "in": 1, "out": 1, "paired": True, "model": "openai-glm-5.3"},
        {"ws": "coursia", "session": "s2", "in": 1, "out": 1, "paired": True, "model": "native-claude-opus-4-8"},
        {"ws": "claudish", "session": "s9", "in": 0, "out": 0, "paired": False, "model": None},
    ]
    w = wsattr.aggregate_tours(rows, None)["workspaces"]
    _check(w["coursia"]["families"] == {"glm": 2, "claude": 1},
           "families count served responses per workspace, got %r" % w["coursia"]["families"])
    _check(w["coursia"]["models"]["anthropic-glm-5.2"] == 1 and w["coursia"]["models"]["openai-glm-5.3"] == 1,
           "the served id keeps the GLM version apart (the C3 discriminant)")
    _check(w["claudish"]["families"] == {wsattr.NO_RESP: 1}, "an unpaired request lands in (no-resp)")


def _hermes_env(system) -> bytes:
    """A non-CC envelope whose system prompt opens like the live Hermes one (05/11)."""
    return json.dumps({"machine": "myia-ai-01", "body": {
        "model": "claude-sonnet-5-5", "system": system,
        "messages": [{"role": "user", "content": "état du cluster ?"}]}}).encode()


def pin_split_noncc_is_opt_in_and_reads_the_system_start():
    hermes = _hermes_env([{"type": "text", "text": "# Hermes — Orchestrateur du Cluster Myia AI\n"
                                                     "Tu es Hermes, l'orchestrateur"}])
    old = wsattr.SPLIT_NONCC
    try:
        wsattr.SPLIT_NONCC = False
        _check(wsattr.workspace_key(hermes) == (wsattr.NON_CC, False),
               "off by default: (non-cc) keeps its meaning for every existing caller")
        wsattr.SPLIT_NONCC = True
        _check(wsattr.workspace_key(hermes) == ("(non-cc:hermes)", False),
               "the Hermes system prompt gets its own bucket, got %r" % (wsattr.workspace_key(hermes),))
        # string-form system and OpenAI-ingress leading system message: same key
        _check(wsattr.workspace_key(_hermes_env("Tu es Hermes, l'orchestrateur"))[0] == "(non-cc:hermes)",
               "a string `system` is read too")
        oai = json.dumps({"body": {"messages": [{"role": "system", "content": "Tu es Hermes."},
                                                {"role": "user", "content": "hi"}]}}).encode()
        _check(wsattr.workspace_key(oai)[0] == "(non-cc:hermes)", "a leading system-role message is read too")
        # the name in the CONVERSATION, not the system prompt, is not a signature
        talk = json.dumps({"body": {"system": "You are a code review assistant.",
                                    "messages": [{"role": "user", "content": "Tu es Hermes ?"}]}}).encode()
        _check(wsattr.workspace_key(talk)[0] == wsattr.NON_CC, "a mention in messages must not match")
        # a Claude Code body is never re-bucketed, whatever its system prompt says
        cc = _body(b"d:\\\\dev\\\\claudish")
        _check(wsattr.workspace_key(cc) == ("claudish", True), "CC traffic keeps its workspace key")
        _check(wsattr.workspace_key(b"not json")[0] == wsattr.NON_CC, "an unparseable body stays (non-cc)")
    finally:
        wsattr.SPLIT_NONCC = old


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
    pin_history_replay_dedupes_by_id,
    pin_quoted_transcript_is_not_a_write,
    pin_dry_run_is_not_a_write,
    pin_toolsearch_is_not_a_dashboard_write,
    pin_compaction_flags_the_tour,
    pin_gh_write_class_and_precedence,
    pin_fleet_push_forms_and_quoted_words,
    pin_dm_send_is_a_write,
    pin_cron_stamp_is_per_request_and_header_confined,
    pin_cadence_separates_cron_from_human,
    pin_served_model_from_resp_name,
    pin_model_family_mapping,
    pin_families_aggregate_per_workspace,
    pin_split_noncc_is_opt_in_and_reads_the_system_start,
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
