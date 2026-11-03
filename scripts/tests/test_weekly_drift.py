#!/usr/bin/env python3
"""Pins for weekly-drift.py (#445 D4, PR of 2026-11-03).

The instrument exists because two prior series disagreed by ~4x on the LEVEL of
responses/PR, and the disagreement was a denominator defect: the October lean
audit's "big six" omitted jsboige/CoursIA, the fleet's largest PR source
(~1 000 merged PRs/week in July). The pins below keep the corrections that made
this table trustworthy:

  1. BUCKET — `deepseek-flash` (the PAYG lane, exactly) must never collapse
     into `deepseek-other` (plan-lane models): the %PAYG column is the money
     column, a mis-bucket silently moves it.
  2. WEEK_MONDAY — ISO weeks, Monday start; a Tuesday must fold into Monday.
  3. AGGREGATE DAYS — days with zero traffic must not dilute the day-average
     (an archive-less day is "no signal", not "a quiet day").
  4. AGGREGATE CASCADE — several resp files on one counter stay several
     responses on purpose (cascade attempts are part of the cost); the counter
     itself is NOT deduplicated here.
  5. QUERY — the PR query must use the search API's issueCount with a merged
     window, whole-owner scopes, and never REST pagination (Grain-1 lesson:
     `updated desc` windows never reach July on active repos).
  6. CACHE — one jsonl line per day, last record wins (resumable series).

Run standalone (no pytest needed):
  python scripts/tests/test_weekly_drift.py
Or under pytest:
  pytest scripts/tests/test_weekly_drift.py
"""

import importlib.util
import json
import os
import sys
import tempfile
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "..", "weekly-drift.py")

spec = importlib.util.spec_from_file_location("weekly_drift", TARGET)
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)

FAILURES = []


def pin(name, cond, detail=""):
    print(f"  [{'PASS' if cond else 'RED'}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


print("pin 1 — bucket: the PAYG lane is exactly deepseek-flash")
pin("1a deepseek-flash -> payg-deepseek", wd.bucket("deepseek-flash") == "payg-deepseek")
pin("1b deepseek-v4.1-flash -> deepseek-other", wd.bucket("deepseek-v4.1-flash") == "deepseek-other")
pin("1c glm-5.3 -> zai-glm", wd.bucket("glm-5.3") == "zai-glm")
pin("1d zai-glm-5-3 -> zai-glm", wd.bucket("zai-glm-5-3") == "zai-glm")
pin("1e swift-1.5-27b -> local-vllm", wd.bucket("swift-1.5-27b") == "local-vllm")
pin("1f k3.1-pro -> kimi", wd.bucket("k3.1-pro") == "kimi")
pin("1g MiniMax-M3.1-Flash -> minimax", wd.bucket("MiniMax-M3.1-Flash") == "minimax")
pin("1h openai_gpt-5.6-sol -> openai", wd.bucket("openai_gpt-5.6-sol") == "openai")

print("pin 2 — week_monday: ISO Monday start")
pin("2a tuesday folds to monday",
   wd.week_monday(date(2026, 11, 3)) == date(2026, 11, 2))
pin("2b sunday folds to the previous monday",
   wd.week_monday(date(2026, 11, 1)) == date(2026, 10, 26))

print("pin 3/4 — aggregate: traffic-less days never dilute; resp files count as served")
cache = {
    "2026-11-02": {"day": "2026-11-02", "req": 100, "resp": 100, "models": {"deepseek-flash": 60}},
    "2026-11-03": {"day": "2026-11-03", "req": 50, "resp": 50, "models": {"deepseek-flash": 30}},
    "2026-11-04": {"day": "2026-11-04", "req": 0, "resp": 0, "models": {}},  # no archive
}
agg = wd.aggregate(cache)
w = agg["2026-11-02"]
pin("3a days = 2, not 3", w["days"] == 2, f"got {w['days']}")
pin("3b resp/d = 75", w["resp"] / w["days"] == 75)
pin("4a two resp files on one counter stay two", w["resp"] == 150)
pin("4b payg bucket sums the model", w["b"]["payg-deepseek"] == 90)

print("pin 5 — PR query: search issueCount, merged window, whole-owner scopes")
pin("5a scopes are whole owners + coursia",
   set(wd.PR_SCOPES) == {"all", "coursia"}
   and "user:jsboige" in wd.PR_SCOPES["all"] and "org:ArgumentumGames" in wd.PR_SCOPES["all"])

print("pin 6 — cache: jsonl, last record wins")
with tempfile.TemporaryDirectory() as tmp:
    c = os.path.join(tmp, "c.jsonl")
    with open(c, "w", encoding="utf-8") as f:
        f.write(json.dumps({"day": "2026-11-02", "req": 1, "resp": 1, "models": {}}) + "\n")
        f.write(json.dumps({"day": "2026-11-02", "req": 9, "resp": 9, "models": {}}) + "\n")
    loaded = wd.load_cache(c)
    pin("6a one day, recount wins", len(loaded) == 1 and loaded["2026-11-02"]["resp"] == 9)

print()
if FAILURES:
    print(f"RED: {len(FAILURES)} pin(s) failed: {', '.join(FAILURES)}")
    sys.exit(1)
print("all pins green")
