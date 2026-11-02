#!/usr/bin/env python3
"""Pins for tool-load-census.py (#23 L5).

Each pin defends a reading a plausible-looking implementation gets WRONG and
that would silently manufacture a conclusion:

  1. POPULATION RULE -- mobilized counts calls from SHAPED sessions only. A
     tool called solely in a session without an api-request-shape record is
     NOT mobilized; pooling both sides measured 46 called vs 45 loaded
     (roo-extensions, 01/11) and read as over-mobilization that never happened.
  2. MAX-PER-TOOL SCHEMA CHARS -- a tool carried by two shape records counts
     its LARGEST schema once, never the sum; a sum double-bills every repeat
     request shape.
  3. DISTINCT-SHAPE DEDUP -- two identical tool sets are one distinct shape.
  4. NEVER -- a loaded tool called in the same session leaves the never list;
     med_never_chars is the median per distinct shape of never-called chars.
  5. SUBAGENT -- a transcript under a subagents/ directory is flagged by path,
     so the census can split main-loop from sub-agent load later.
  6. EMPTY WORKSPACE -- a workspace with no shape record yields a noted row,
     not a crash and not a zero that reads as "everything mobilized".
  7. MALFORMED LINE -- a line that matches the fast-path substring but fails
     to parse increments parse_fail and never stops the scan.
  8. SKIP -- the skip set drops whole workspace dirs, by exact name.

Run standalone (no pytest needed):
  python scripts/tests/test_tool_load_census.py
Or under pytest:
  pytest scripts/tests/test_tool_load_census.py
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.environ.get(
    "CENSUS_TARGET", os.path.join(os.path.dirname(_HERE), "tool-load-census.py")
)

_spec = importlib.util.spec_from_file_location("tlc", _TARGET)
tlc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tlc)


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def _shape(tools, ts):
    return json.dumps({"type": "api-request-shape", "timestamp": ts,
                       "shape": {"tools": tools}})


def _tool(name, pad=0):
    return {"name": name, "description": "x" * pad,
            "schema": {"type": "object", "properties": {}}}


def _calls(names, ts):
    return json.dumps({"type": "assistant", "timestamp": ts,
                       "message": {"content": [
                           {"type": "tool_use", "name": n, "input": {}} for n in names]}})


def _census_rows():
    """Fixture: three workspaces exercising the pins; returns (root, rows)."""
    root = tempfile.mkdtemp()
    a = os.path.join(root, "d--dev-alpha")
    b = os.path.join(root, "d--dev-beta")
    g = os.path.join(root, "d--dev-gamma")
    sub = os.path.join(root, "d--dev-delta", "subagents")  # own workspace: a shaped
    for d in (a, b, g, sub):                                # sub transcript must not
        os.makedirs(d)                                      # widen alpha's population

    small_read, big_read = _tool("Read", pad=10), _tool("Read", pad=90)
    shape_a1 = [small_read, _tool("Bash", pad=20), _tool("Workflow", pad=50)]
    shape_a2 = [big_read, _tool("Bash", pad=20), _tool("Workflow", pad=50)]  # same set
    with open(os.path.join(a, "s1.jsonl"), "w", encoding="utf-8") as fh:
        fh.write(_shape(shape_a1, "2026-11-01T10:00:00Z") + "\n")
        fh.write(_calls(["Read", "Bash"], "2026-11-01T10:01:00Z") + "\n")
    with open(os.path.join(a, "s2.jsonl"), "w", encoding="utf-8") as fh:
        fh.write(_shape(shape_a2, "2026-11-01T11:00:00Z") + "\n")
        fh.write(_calls(["Read"], "2026-11-01T11:01:00Z") + "\n")
    with open(os.path.join(sub, "sub1.jsonl"), "w", encoding="utf-8") as fh:
        fh.write(_shape([_tool("Task")], "2026-11-01T12:00:00Z") + "\n")

    with open(os.path.join(b, "s3.jsonl"), "w", encoding="utf-8") as fh:
        fh.write(_calls(["Grep"] * 5, "2026-11-01T09:00:00Z") + "\n")  # no shape record
    with open(os.path.join(b, "s4.jsonl"), "w", encoding="utf-8") as fh:
        fh.write(_shape([_tool("Grep", pad=5), _tool("Glob", pad=7)],
                        "2026-11-01T09:30:00Z") + "\n")

    with open(os.path.join(g, "s5.jsonl"), "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "user", "timestamp": "2026-11-01T08:00:00Z",
                             "message": {"content": "hi"}}) + "\n")

    acc = {}
    for wname, path, is_sub in tlc.sessions(root):
        s = tlc.scan_session(path)
        if s is None:
            continue
        s["subagent"] = is_sub
        acc.setdefault(wname, []).append(s)
    return root, {r["workspace"]: r for r in tlc.summarize(acc)}


def pin_population_rule_shapeless_calls_do_not_mobilize():
    _, rows = _census_rows()
    beta = rows["d--dev-beta"]
    # Grep is called 5x -- but only in a session with no shape record. The
    # shaped session carries [Grep, Glob] and makes no call.
    _check(beta["loaded"] == 2, "beta loaded=%r" % beta["loaded"])
    _check(beta["mobilized"] == 0,
           "a call from a shape-less session must not count as mobilized (got %r)"
           % beta["mobilized"])
    _check(beta["mobilized"] <= beta["loaded"], "mobilized exceeds loaded")


def pin_schema_chars_are_max_per_tool_not_summed():
    _, rows = _census_rows()
    alpha = rows["d--dev-alpha"]
    by_name = dict(alpha["never"])
    _check(alpha["loaded"] == 3, "alpha loaded=%r" % alpha["loaded"])
    # Workflow is never called; its chars are pinned by the never list.
    wf = len(json.dumps(_tool("Workflow", pad=50), ensure_ascii=False))
    _check(by_name.get("Workflow") == wf,
           "never chars=%r, expected the one schema size %d" % (by_name.get("Workflow"), wf))
    # Read appears twice with pad=10 then pad=90; the bigger one must win once
    # (the sum would be visible in the medians below, and in tool_chars).
    big = len(json.dumps(_tool("Read", pad=90), ensure_ascii=False))
    small = len(json.dumps(_tool("Read", pad=10), ensure_ascii=False))
    _check(big > small and alpha["med_total_chars"] == big + alpha["med_never_chars"]
           + len(json.dumps(_tool("Bash", pad=20), ensure_ascii=False)),
           "med_total=%r is not max-per-tool (big Read=%d)" % (alpha["med_total_chars"], big))


def pin_identical_tool_sets_are_one_distinct_shape():
    _, rows = _census_rows()
    _check(rows["d--dev-alpha"]["distinct_shapes"] == 1,
           "two identical shape sets must dedup to one (got %r)"
           % rows["d--dev-alpha"]["distinct_shapes"])


def pin_never_list_and_median_follow_same_session_calls():
    _, rows = _census_rows()
    alpha = rows["d--dev-alpha"]
    _check([n for n, _ in alpha["never"]] == ["Workflow"],
           "never=%r, expected only Workflow" % alpha["never"])
    wf = len(json.dumps(_tool("Workflow", pad=50), ensure_ascii=False))
    _check(alpha["med_never_chars"] == wf,
           "one distinct shape -> med_never is exactly its never-called chars "
           "(got %r, expected %d)" % (alpha["med_never_chars"], wf))


def pin_subagent_flagged_by_path():
    root, _ = _census_rows()
    seen = {os.path.basename(p): is_sub for _, p, is_sub in tlc.sessions(root)}
    _check(seen.get("sub1.jsonl") is True, "subagents/sub1.jsonl must be flagged")
    _check(all(v is False for k, v in seen.items() if k != "sub1.jsonl"),
           "top-level transcripts must not be flagged")


def pin_workspace_without_shapes_yields_a_noted_row():
    _, rows = _census_rows()
    gamma = rows["d--dev-gamma"]
    _check(gamma.get("sessions_with_shapes") == 0 and "note" in gamma,
           "empty workspace must carry a note row, got %r" % gamma)


def pin_malformed_line_counts_and_continues():
    d = tempfile.mkdtemp()
    try:
        p = os.path.join(d, "broken.jsonl")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write('{"api-request-shape": not json\n')
            fh.write(_shape([_tool("Read")], "2026-11-01T10:00:00Z") + "\n")
        s = tlc.scan_session(p)
        _check(s["parse_fail"] == 1, "parse_fail=%r" % s["parse_fail"])
        _check(s["tool_chars"].get("Read"), "scan must continue past the broken line")
    finally:
        shutil.rmtree(d)


def pin_skip_drops_workspace_dirs_by_name():
    root, _ = _census_rows()
    names = {w for w, _, _ in tlc.sessions(root, skip={"d--dev-beta"})}
    _check("d--dev-beta" not in names and "d--dev-alpha" in names,
           "skip must drop exactly the named dir (got %r)" % sorted(names))


PINS = [
    pin_population_rule_shapeless_calls_do_not_mobilize,
    pin_schema_chars_are_max_per_tool_not_summed,
    pin_identical_tool_sets_are_one_distinct_shape,
    pin_never_list_and_median_follow_same_session_calls,
    pin_subagent_flagged_by_path,
    pin_workspace_without_shapes_yields_a_noted_row,
    pin_malformed_line_counts_and_continues,
    pin_skip_drops_workspace_dirs_by_name,
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
