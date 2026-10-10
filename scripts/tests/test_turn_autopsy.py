#!/usr/bin/env python3
"""Pins for turn-autopsy.py (#328 G12, CR #424 -- ai-01 review).

The review's two blockers, pinned:

  1. PAIRING -- `index_members` assigned `dict[counter] = name`, so a counter
     reused after a container restart (10 498 resp files for 7 114 distinct
     counters on captures-2026-07-05) silently overwrote its homonym and
     mispaired a request of one uptime window with a response of another.
     Fixed as: counter -> LIST of (ts, name); a resp belongs to the LATEST req
     of its counter whose ts it follows within PAIR_WINDOW_MS (20 min);
     several in-window resps on one req are a CASCADE ATTEMPT CHAIN (measured
     2026-07-05: 2 598 counters, resps seconds apart on different lanes) --
     the LAST attempt serves the client, earlier ones are counted as attempts,
     and `unpaired` is reported as its own status.
  2. TRIGGER ORDER -- `classify_trigger` ran the harness-phrase regexes over
     `_text_of(last)`, which concatenates tool_result content, so the agent's
     own Bash result quoting "Command running in background with ID:" was
     classified `bg-notification`. Fixed as: tool-result FIRST, and the regex
     scan reads text blocks only.

Plus the non-blocking fixes pinned: turn_id = full name without extension,
`--no-copy`/extraction path uses the local `archive` variable, and the
`cmd_stats` percentage no longer prints the literal "if n else 0".

Mutation proofs (run before pushing; each named mutation must turn its pin red
-- AUTOPSY_TARGET points at a mutated copy to red-proof without touching main):
  A. index_members back to `dict[counter] = base`            -> pin 3, pin 4a
  B. classify_trigger back to regexes-before-tool_result     -> pin 5a
  C. _ts_ms as digit concatenation (no calendar arithmetic)  -> pin 4d
  D. pair without the window bound (any ts >=)               -> pin 4c
  E. cmd_stats percentage back inside the f-string literal   -> pin 7b

Run standalone (no pytest needed):
  python scripts/tests/test_turn_autopsy.py
Or under pytest:
  pytest scripts/tests/test_turn_autopsy.py
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.environ.get(
    "AUTOPSY_TARGET", os.path.join(os.path.dirname(_HERE), "turn-autopsy.py")
)

_spec = importlib.util.spec_from_file_location("taut", _TARGET)
taut = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(taut)


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


# --- filename grammar --------------------------------------------------------

def pin_req_re_ip_chain_and_direct():
    m = taut.REQ_RE.match(
        "req-1-0001-2026-07-05T02-00-04-064Z-192.168.0.254__192.168.0.254_57617.json")
    _check(m is not None, "REQ_RE must match the proxied IP-chain form")
    _check(m.group(3) == "192.168.0.254" and m.group(4) == "192.168.0.254"
           and m.group(5) == "57617", "IP chain groups: %r" % (m.groups(),))
    m = taut.REQ_RE.match("req-1-0002-2026-07-05T02-00-06-902Z-direct.json")
    _check(m is not None and m.group(6) == "direct",
           "REQ_RE must match the direct form with group(6)=direct")


def pin_resp_re_lane():
    m = taut.RESP_RE.match("resp-1-r0001-2026-07-05T02-00-06-569Z-openai-glm-5.2.sse")
    _check(m is not None, "RESP_RE must match")
    # the timestamp must NOT be eaten by the lane group
    _check(m.group(1) == "0001" and m.group(2) == "2026-07-05T02-00-06-569Z",
           "resp counter/ts groups: %r" % (m.groups(),))


# --- index + pairing ---------------------------------------------------------

def _members(*names):
    return [(n, 1) for n in names]


def pin_index_members_keeps_homonyms():
    reqs, resps = taut.index_members(_members(
        "req-1-0005-2026-07-05T02-00-00-000Z-direct.json",
        "req-1-0005-2026-07-05T09-00-00-000Z-direct.json",
        "resp-1-r5-2026-07-05T02-00-02-000Z-openai-glm-5.2.sse",
        "resp-1-r5-2026-07-05T09-00-02-000Z-anthropic-MiniMax-M3.sse",
    ))
    _check(len(reqs[5]) == 2, "counter 5 must hold BOTH requests, got %d" % len(reqs[5]))
    _check(len(resps[5]) == 2, "counter 5 must hold BOTH responses, got %d" % len(resps[5]))
    lanes = {e[2] for e in resps[5]}
    _check(lanes == {"openai/glm-5.2", "anthropic/MiniMax-M3"},
           "both lanes indexed: %r" % lanes)


def pin_pair_two_windows_same_counter():
    """4a -- THE homonym case: two uptime windows reuse counter 5 five hours
    apart. Each request must pair with ITS OWN response, not the dict
    overwrite's survivor."""
    reqs, resps = taut.index_members(_members(
        "req-1-0005-2026-07-05T02-00-00-000Z-direct.json",
        "req-1-0005-2026-07-05T09-00-00-000Z-direct.json",
        "resp-1-r5-2026-07-05T02-00-02-000Z-openai-glm-5.2.sse",
        "resp-1-r5-2026-07-05T09-00-02-000Z-anthropic-MiniMax-M3.sse",
    ))
    out = taut.pair_all(reqs, resps)
    early = out[(5, "2026-07-05T02-00-00-000Z", "req-1-0005-2026-07-05T02-00-00-000Z-direct.json")]
    late = out[(5, "2026-07-05T09-00-00-000Z", "req-1-0005-2026-07-05T09-00-00-000Z-direct.json")]
    _check(early[0] == "paired" and "glm-5.2" in early[1][2],
           "early req must pair with the glm resp, got %r" % (early,))
    _check(late[0] == "paired" and "MiniMax" in late[1][2],
           "late req must pair with the MiniMax resp, got %r" % (late,))


def pin_pair_window_bound():
    """4c -- a resp 25 min after its req is OUTSIDE the 20-min bound: the
    counter homonym belongs to another window, pairing it would be the bug."""
    reqs, resps = taut.index_members(_members(
        "req-1-0009-2026-07-05T02-00-00-000Z-direct.json",
        "resp-1-r9-2026-07-05T02-25-00-000Z-openai-glm-5.2.sse",
    ))
    out = taut.pair_all(reqs, resps)
    st = out[(9, "2026-07-05T02-00-00-000Z", "req-1-0009-2026-07-05T02-00-00-000Z-direct.json")]
    _check(st[0] == "unpaired", "25-min-late resp must be unpaired, got %r" % (st,))


def pin_pair_hour_boundary():
    """4d -- 02:59:59.999 -> 03:00:00.000 is 1 ms. Naive digit concatenation
    reads it as ~4e7 units and would call it out-of-window."""
    reqs, resps = taut.index_members(_members(
        "req-1-0011-2026-07-05T02-59-59-999Z-direct.json",
        "resp-1-r11-2026-07-05T03-00-00-000Z-openai-glm-5.2.sse",
    ))
    out = taut.pair_all(reqs, resps)
    st = out[(11, "2026-07-05T02-59-59-999Z", "req-1-0011-2026-07-05T02-59-59-999Z-direct.json")]
    _check(st[0] == "paired", "1-ms-across-the-hour resp must pair, got %r" % (st,))


def pin_pair_resp_before_req_and_attempt_chain():
    # resp BEFORE its counter's req: never a pairing (ts must be >= the req's)
    reqs, resps = taut.index_members(_members(
        "req-1-0013-2026-07-05T04-00-05-000Z-direct.json",
        "resp-1-r13-2026-07-05T04-00-00-000Z-openai-glm-5.2.sse",
    ))
    out = taut.pair_all(reqs, resps)
    st = out[(13, "2026-07-05T04-00-05-000Z", "req-1-0013-2026-07-05T04-00-05-000Z-direct.json")]
    _check(st[0] == "unpaired", "resp before req must be unpaired, got %r" % (st,))
    # TWO resps within the window of the same req = a CASCADE ATTEMPT CHAIN
    # (measured 2026-07-05: 2 598 such counters, resps seconds apart on
    # different lanes). The LAST attempt serves the client -> that is the
    # pair; the earlier one is counted, not guessed at.
    reqs, resps = taut.index_members(_members(
        "req-1-0017-2026-07-05T05-00-00-000Z-direct.json",
        "resp-1-r17-2026-07-05T05-00-01-000Z-openai-glm-5.2.sse",
        "resp-1-r17-2026-07-05T05-00-03-000Z-anthropic-MiniMax-M3.sse",
    ))
    out = taut.pair_all(reqs, resps)
    st = out[(17, "2026-07-05T05-00-00-000Z", "req-1-0017-2026-07-05T05-00-00-000Z-direct.json")]
    _check(st[0] == "paired" and "MiniMax" in st[1][2] and st[2] == 1,
           "attempt chain: pair the LAST attempt, count the earlier one, got %r" % (st,))


# --- trigger classification --------------------------------------------------

def pin_trigger_tool_result_first():
    """5a -- the agent's own Bash result quoting the bg-notification phrase is
    a TOOL-RESULT turn, not a harness notification."""
    msgs = [{"role": "user", "content": [
        {"type": "tool_result",
         "content": "Command running in background with ID: bg-01a7\n"
                    "Output will be written to a log file."},
    ]}]
    _check(taut.classify_trigger(msgs) == "tool-result",
           "tool_result block quoting the phrase must classify tool-result, got %r"
           % taut.classify_trigger(msgs))


def pin_trigger_text_blocks_still_fire():
    msgs = [{"role": "user", "content": [
        {"type": "text",
         "text": "The TodoWrite tool hasn't been used recently. "
                 "Use it to track your progress."},
    ]}]
    _check(taut.classify_trigger(msgs) == "todo-nudge",
           "text-block nudge must still fire, got %r" % taut.classify_trigger(msgs))
    _check(taut.classify_trigger([]) == "empty", "no messages -> empty")


# --- bounded sampling --------------------------------------------------------

def _cand(i, lane_ts, lane="openai/glm-5.2"):
    name = "req-1-%04d-2026-07-05T0%d-00-00-000Z-direct.json" % (i, lane_ts)
    return {"counter": i, "req_ts": "2026-07-05T0%d-00-00-000Z" % lane_ts,
            "req_name": name, "pair": "paired",
            "resp": ("2026-07-05T0%d-00-01-000Z" % lane_ts,
                     "resp-1-r%d-2026-07-05T0%d-00-01-000Z-x.sse" % (i, lane_ts), lane)}


def pin_pick_sample_bounded():
    cands = [_cand(i, i % 9 + 1, "lane%d/x" % (i % 9)) for i in range(1, 41)]
    picked = taut.pick_sample(cands, 3, 328, True)
    _check(len(picked) == 3, "10 lanes, n=3 -> exactly 3, got %d" % len(picked))
    _check(all(p["pair"] == "paired" for p in picked), "picked must be candidate dicts")
    keys = [(p["req_ts"], p["req_name"]) for p in picked]
    _check(keys == sorted(keys), "output must be ts-sorted")
    picked = taut.pick_sample(cands, 1000, 328, False)
    _check(len(picked) == len(cands), "n > population -> all, got %d" % len(picked))


# --- end to end (sample --dir + stats) ---------------------------------------

def _req_body(text):
    return json.dumps({"ts": "2026-07-05T02-00-00-000Z", "machine": "po-test",
                       "model": "glm-5.2", "body": {
                           "messages": [{"role": "user", "content": text}]}})


def _resp_sse():
    return ('data: {"type":"message_delta","usage":{"output_tokens":3},'
            '"delta":{"stop_reason":"end_turn"}}\n\ndata: [DONE]\n')


def pin_e2e_sample_and_stats():
    tmp = tempfile.mkdtemp(prefix="taut-e2e-")
    try:
        for nm, body in [
            ("req-1-0005-2026-07-05T02-59-59-999Z-direct.json", _req_body("hello july")),
            ("req-1-0005-2026-07-05T09-00-00-000Z-direct.json", _req_body("hello again")),
            ("resp-1-r5-2026-07-05T03-00-00-000Z-openai-glm-5.2.sse", _resp_sse()),
            ("resp-1-r5-2026-07-05T09-00-02-000Z-anthropic-MiniMax-M3.sse", _resp_sse()),
        ]:
            with open(os.path.join(tmp, nm), "w", encoding="utf-8") as fh:
                fh.write(body)
        work = os.path.join(tmp, "work")
        out = os.path.join(tmp, "wl.jsonl")
        r = subprocess.run([sys.executable, _TARGET, "sample", "--dir", tmp,
                            "--era", "t", "--n", "10", "--seed", "328",
                            "--stratify", "none", "--workdir", work,
                            "--out", out],
                           capture_output=True, text=True)
        _check(r.returncode == 0, "e2e sample rc=%d stderr=%s" % (r.returncode, r.stderr[:400]))
        rows = [json.loads(l) for l in open(out, encoding="utf-8") if l.strip()]
        _check(len(rows) == 2, "both same-counter turns must appear, got %d" % len(rows))
        by_ts = {row["req"]["last_text"]["head"] if isinstance(row["req"].get("last_text"), dict) else "": row for row in rows}
        for row in rows:
            _check(row["pair_status"] == "paired",
                   "e2e turn must be paired, got %r" % row.get("pair_status"))
            _check(row["turn_id"].endswith("Z-direct") and "." not in row["turn_id"].split("Z-")[-1],
                   "turn_id must be the full name without extension, got %r" % row["turn_id"])
        lanes = sorted(row["lane"] for row in rows)
        _check(lanes == ["anthropic/MiniMax-M3", "openai/glm-5.2"],
               "each turn pairs with ITS OWN window's lane, got %r" % lanes)
        # stats: no literal "if n else 0", and a pairing block exists
        r2 = subprocess.run([sys.executable, _TARGET, "stats", "--worklist", out],
                            capture_output=True, text=True)
        _check(r2.returncode == 0, "e2e stats rc=%d" % r2.returncode)
        _check("if n else 0" not in r2.stdout,
               "cmd_stats must not print the literal 'if n else 0'")
        _check("== pairing ==" in r2.stdout, "stats must carry the pairing block")
        _check("paired" in r2.stdout, "pairing block must show paired counts")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    pin_req_re_ip_chain_and_direct()
    pin_resp_re_lane()
    pin_index_members_keeps_homonyms()
    pin_pair_two_windows_same_counter()
    pin_pair_window_bound()
    pin_pair_hour_boundary()
    pin_pair_resp_before_req_and_attempt_chain()
    pin_trigger_tool_result_first()
    pin_trigger_text_blocks_still_fire()
    pin_pick_sample_bounded()
    pin_e2e_sample_and_stats()
    print("test_turn_autopsy: 11 pins OK (target: %s)" % _TARGET)


if __name__ == "__main__":
    main()
