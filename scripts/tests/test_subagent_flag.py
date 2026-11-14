#!/usr/bin/env python3
r"""Pins for lib/subagent_flag.py — the ONE `cc_is_subagent` predicate (#1051).

Why a shared pin: the same signature was read by three predicates that had
drifted apart, and two of them were wrong in opposite directions.

  * `"cc_is_subagent" in raw` (origin) — always TRUE: the literal is quoted in
    this repo's CLAUDE.md, so it rides the system prompt of every claudish
    session (trap T4, docs/reference/ops-scripts.md);
  * `"cc_is_subagent":\s*true` (commit f9695305, the "fix") — always FALSE:
    `metadata` never carries the flag (measured on 60 req-* captures, #334 B1);
  * `cc_is_subagent(?:"\s*:\s*|=)true` (#953) — always TRUE again, for the
    first reason. That is the `sub=165/165` of 14/11: 100 % is the signature
    of a constant, not of a sub-agent.

The predicate must be able to say "no evidence" — that is the state the two
wrong versions lacked. Fixtures are ANONYMISED EXTRACTS of real captures
(13/11 hub corpus, device 0b9b0d8c): the billing header line is quoted
verbatim from the capture, and the echo is quoted from this repo's CLAUDE.md,
which is what a claudish system prompt actually contains.

Run standalone:  python scripts/tests/test_subagent_flag.py
Or under pytest: pytest scripts/tests/test_subagent_flag.py
"""

import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "subagent_flag", os.path.join(_HERE, "..", "lib", "subagent_flag.py"))
sf = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(sf)

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


# The header line as it really appears (13/11, device 0b9b0d8c).
MAIN_HDR = ("x-anthropic-billing-header: cc_version=2.1.322.245; "
            "cc_entrypoint=claude-vscode; cc_workload=cron;")
SUB_HDR = ("x-anthropic-billing-header: cc_version=2.1.322.245; "
           "cc_entrypoint=claude-vscode; cc_is_subagent=true;")
# The echo: this repo's CLAUDE.md line, carried in the system prompt.
ECHO = "`cc_is_subagent=true` is the leak signature, and it lives in the request body"


def main():
    # --- the three states of the real form -------------------------------
    check("header without the flag -> False (main turn)",
          sf.subagent_flag(MAIN_HDR) is False, sf.subagent_flag(MAIN_HDR))
    check("header with the flag -> True (sub-agent)",
          sf.subagent_flag(SUB_HDR) is True, sf.subagent_flag(SUB_HDR))
    check("no marker at all -> None (unknown, never guessed)",
          sf.subagent_flag('{"messages": []}') is None)

    # --- the two FORMS the issue names, both pinned ----------------------
    check("form 1: billing-header text -> True",
          sf.subagent_flag(SUB_HDR) is True)
    check("form 2: JSON key -> True (fallback, no header present)",
          sf.subagent_flag('{"metadata": {"cc_is_subagent": true}}') is True)

    # --- the NEITHER case, and the bug it caused -------------------------
    check("neither: a prose echo alone -> None, NOT True (#1051)",
          sf.subagent_flag(ECHO) is None, sf.subagent_flag(ECHO))
    check("neither: empty text -> None", sf.subagent_flag("") is None)

    # A claudish system prompt carries BOTH the echo and the real header:
    # the header must win, whichever order they are serialized in.
    check("echo + main header -> False (header decides)",
          sf.subagent_flag(ECHO + " ... " + MAIN_HDR) is False)
    check("main header + echo -> False (echo cannot flip it)",
          sf.subagent_flag(MAIN_HDR + " ... " + ECHO) is False)

    # --- the header is AUTHORITATIVE over the JSON fallback --------------
    check("header without the flag + JSON key -> False (header wins)",
          sf.subagent_flag(MAIN_HDR + ' "cc_is_subagent": true') is False)

    # --- LAST segment wins (the real system block is serialized after
    #     messages; a quoted header inside the conversation comes first).
    #     Each header is its OWN JSON string — that is what bounds the
    #     segment, and what stops two headers from blending into one run. ---
    check("two segments: the last one decides",
          sf.subagent_flag(f'"{SUB_HDR}" ... "{MAIN_HDR}"') is False)
    check("two segments, reversed order",
          sf.subagent_flag(f'"{MAIN_HDR}" ... "{SUB_HDR}"') is True)

    # --- a header line with no k=v run is not evidence -------------------
    check("bare marker with no fields -> None",
          sf.subagent_flag("x-anthropic-billing-header: ") is None)

    # --- the workload rides the same segment (live-consumption reuses it) -
    got = sf.billing_fields_of(SUB_HDR)
    check("billing_fields_of still yields workload for live-consumption",
          got == {"sub": True, "workload": None}, got)

    if FAILS:
        print(f"\n{len(FAILS)} FAILED: {FAILS}")
        raise SystemExit(1)
    print("\nall pins green")


if __name__ == "__main__":
    main()