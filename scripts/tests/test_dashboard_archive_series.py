#!/usr/bin/env python3
"""Self-executing pins for dashboard-archive-series.py (#328 G13, review #426).

One pin per review point, each backed by a mutation that reddens it:
  (a) system/condensation messages are excluded BY AUTHOR — the old
      tag-based filter never matched (**CONDENSATION** carries no bracket),
      inflating October asymmetrically (bloquant 1);
  (b) a cross-posted message counts ONCE in uniques and ONCE PER DASHBOARD
      in per-key attribution, whatever the file order (bloquant 2);
  (c) DM mailbox copies (sent + inbox + " (1)" clone) collapse to one;
  (d) a frontmatter/parsed count disagreement is reported as count-mismatch.

Run: python -I scripts/tests/test_dashboard_archive_series.py   (or pytest)
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.join(_HERE, "..", "dashboard-archive-series.py")

spec = importlib.util.spec_from_file_location("dashboard_archive_series", _SCRIPT)
das = importlib.util.module_from_spec(spec)
spec.loader.exec_module(das)

FAILS = []


def check(name, cond, detail=""):
    print("%s %s%s" % ("ok  " if cond else "FAIL", name, (" — " + detail) if detail else ""))
    if not cond:
        FAILS.append(name)


# ---------------------------------------------------------------- fixtures

DATE_A = "2026-07-05"
DATE_B = "2026-10-05"


def dash_md(key, msgs, declared=None):
    """msgs: (ts, machine, ws, content). declared: frontmatter messageCount."""
    n = declared if declared is not None else len(msgs)
    out = ["---", "title: %s" % key, "messageCount: %d" % n, "---"]
    for ts, m, w, c in msgs:
        out.append("")
        out.append("### [%s] %s|%s" % (ts, m, w))
        out.append("")
        out.append(c)
    return "\n".join(out) + "\n"


DONE_MSG = ("2026-10-05T10:00:00.000Z", "myia-po-2025", "claudish",
            "## [DONE] cycle — one delivered thing")
CROSS_SAME_LEN = ("2026-10-05T10:05:00.000Z", "myia-po-2025", "claudish",
                  "[TASK] identical escalation body, byte for byte")


def build_store(root):
    """A minimal RooSync store: live dashboards + message mailboxes.

    - workspace-claudish: 1 DONE + 2 system condensation messages (bloquant 1
      fixture, exactly the reviewer's) + the cross-post copy.
    - global: the cross-post original (same ts/author/len).
    - mismatch: declares 5 messages but holds 2 (point d).
    - messages/: the same DM in sent/, inbox/ and a " (1)" clone (point c).
    """
    dd = os.path.join(root, "dashboards")
    os.makedirs(dd, exist_ok=True)
    ws_msgs = [
        ("2026-10-05T09:00:00.000Z", "system", "system",
         "**CONDENSATION-SUMMARY** - 2026-10-05T09:00:00.000Z"),
        DONE_MSG,
        CROSS_SAME_LEN,
        ("2026-10-05T11:00:00.000Z", "system", "system",
         "**CONDENSATION** - 2026-10-05T11:00:00.000Z"),
    ]
    with open(os.path.join(dd, "workspace-claudish.md"), "w", encoding="utf-8") as f:
        f.write(dash_md("workspace-claudish", ws_msgs))
    with open(os.path.join(dd, "global.md"), "w", encoding="utf-8") as f:
        f.write(dash_md("global", [CROSS_SAME_LEN]))
    # July side: one message so era A is non-empty and cross-post-era works.
    os.makedirs(os.path.join(dd, "archive"), exist_ok=True)
    with open(os.path.join(dd, "archive", "workspace-claudish-2026-07-05T00-00-00.md"),
              "w", encoding="utf-8") as f:
        f.write(dash_md("workspace-claudish", [
            ("2026-07-05T10:00:00.000Z", "myia-po-2025", "claudish", "[DONE] july message")]))
    with open(os.path.join(dd, "machine-mismatch.md"), "w", encoding="utf-8") as f:
        f.write(dash_md("machine-mismatch", [
            ("2026-10-05T12:00:00.000Z", "myia-po-2025", "claudish", "[INFO] one"),
            ("2026-10-05T12:01:00.000Z", "myia-po-2025", "claudish", "[INFO] two")],
            declared=5))

    dm = {"timestamp": "2026-10-05T10:30:00Z", "from": "myia-po-2025:claudish",
          "to": "myia-ai-01:claudish", "priority": "MEDIUM",
          "subject": "s", "body": "b"}
    for store, fn in (("sent", "m1.json"), ("inbox", "m1.json"), ("archive", "m1 (1).json")):
        d = os.path.join(root, "messages", store)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, fn), "w", encoding="utf-8") as f:
            json.dump(dm, f)


def run_collect_summarize(root, era_a="2026-07-05:2026-07-05", era_b="2026-10-05:2026-10-05"):
    series = os.path.join(root, "series.jsonl")
    r1 = subprocess.run(
        [sys.executable, "-I", _SCRIPT, "collect", "--store", root, "--out", series],
        capture_output=True, text=True, timeout=120)
    r2 = subprocess.run(
        [sys.executable, "-I", _SCRIPT, "summarize", "--series", series,
         "--era-a", era_a, "--era-b", era_b],
        capture_output=True, text=True, timeout=120)
    return r1, r2


# ---------------------------------------------------------------- unit pins

def test_tag_of_bold_system_message_is_empty():
    # The root of bloquant 1: **CONDENSATION** is not a bracketed token, so a
    # tag-based filter can never exclude it. Pinned so the fact survives.
    check("tag: **CONDENSATION** header yields empty tag",
          das.first_tag("**CONDENSATION-SUMMARY** - 2026-10-05T09:00:00.000Z") == "")


# ------------------------------------------------------- end-to-end pins

def test_end_to_end():
    with tempfile.TemporaryDirectory() as tmp:
        build_store(tmp)
        r1, r2 = run_collect_summarize(tmp)
        out = r2.stdout
        check("e2e: collect exit 0", r1.returncode == 0,
              "rc=%d stderr=%s" % (r1.returncode, r1.stderr[:200]))
        check("e2e: summarize exit 0", r2.returncode == 0,
              "rc=%d stderr=%s" % (r2.returncode, r2.stderr[:200]))

        # (a) system condensation excluded by author. Era B holds 7 messages
        # raw (2 system + DONE + cross-post x2 dashboards + INFO x2); only
        # the 2 system lines are excluded -> 5 counted, and the excluded
        # counter names them.
        b_block = out.split("===== ERA B")[1] if "===== ERA B" in out else ""
        head = next((l for l in b_block.splitlines() if l.startswith("dashboard messages:")), "")
        check("(a) era B dashboard messages = 5 (2 system msgs excluded)",
              "dashboard messages: 5 " in head + " ", head)
        check("(a) excluded counter names the 2 system messages",
              "excluded from counts: 2" in b_block, next(
                  (l for l in b_block.splitlines() if "excluded from counts" in l), ""))

        # (b) cross-post: unique collapses it to 1, per-dashboard keeps both.
        check("(b) cross-posts: 1 reported",
              "cross-posts: 1" in head, head)
        check("(b) unique (cross-posts collapsed): 4",
              "unique (cross-posts collapsed): 4" in head, head)
        keys_line = next((l for l in b_block.splitlines() if l.startswith("top dashboards:")), "")
        check("(b) per-dashboard attribution keeps BOTH dashboards",
              "('global', 1)" in keys_line and "('workspace-claudish', 2)" in keys_line
              and "('machine-mismatch', 2)" in keys_line, keys_line)

        # (c) DM mailbox copies collapse to one unique message.
        check("(c) DMs: 1 unique across sent/inbox/clone",
              "DMs: 1 (" in head, head)

        # (d) count-mismatch reported by collect.
        check("(d) count_mismatches: 1 (declared 5, parsed 2)",
              '"count_mismatches": 1' in r1.stdout, r1.stdout.strip())


if __name__ == "__main__":
    for fn in [test_tag_of_bold_system_message_is_empty, test_end_to_end]:
        print("## %s" % fn.__name__)
        fn()
    print()
    if FAILS:
        print("FAILED: %d — %s" % (len(FAILS), ", ".join(FAILS)))
        sys.exit(1)
    print("all pins ok")
