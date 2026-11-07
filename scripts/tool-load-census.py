"""#23 L5 — loaded vs mobilized, plus the schema cost of never-mobilized tools.

Corpus: local Claude Code transcripts (<projects dir>/<workspace>/**.jsonl), by
default ~/.claude/projects.

POPULATION RULE (the one that matters): a session's calls are compared to the
shapes that same session carried. A workspace aggregate that pools "loaded from
sessions with shapes" against "calls from every session" inflates `mobilized`
above `loaded` (measured 01/11: roo-extensions 46 called vs 45 loaded, and a
same-session re-run gives 45/45) — the two sides must come from the same session
or the ratio is meaningless.

  loaded    = union of `shape.tools[]` over the session's `api-request-shape` records
  mobilized = assistant `tool_use` names inside those same sessions
  never     = loaded tools no shaped session called; `med_never_chars` is the
              median, over distinct shapes, of the schema chars a shape carries
              for never-called tools (what dropping them would save per request)

Seat-specific skips (e.g. huge transcript trees owned by other lanes) are a
flag, not a default: --skip takes comma-separated workspace dir names.
"""
import argparse
import json
import os
import statistics
import sys


def sessions(projects, skip=()):
    """Yield (workspace, path, is_subagent) for every transcript file."""
    for name in sorted(os.listdir(projects)):
        d = os.path.join(projects, name)
        if not os.path.isdir(d) or name in skip:
            continue
        for dirpath, _, files in os.walk(d):
            for fn in files:
                if fn.endswith(".jsonl"):
                    p = os.path.join(dirpath, fn)
                    yield name, p, (os.sep + "subagents" + os.sep in p)


def scan_session(path):
    """One transcript file -> shape sets, per-tool schema chars, tool calls."""
    s = {"shape_sets": {}, "tool_chars": {}, "calls": {}, "call_total": 0,
         "ts_min": None, "ts_max": None, "parse_fail": 0, "lines": 0}
    try:
        fh = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        return None
    with fh:
        for line in fh:
            s["lines"] += 1
            if "api-request-shape" not in line and '"tool_use"' not in line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                s["parse_fail"] += 1
                continue
            ts = rec.get("timestamp")
            if ts:
                if s["ts_min"] is None or ts < s["ts_min"]:
                    s["ts_min"] = ts
                if s["ts_max"] is None or ts > s["ts_max"]:
                    s["ts_max"] = ts
            if "api-request-shape" in line:
                tools = (rec.get("shape") or {}).get("tools") or []
                if tools:
                    names = []
                    for t in tools:
                        n = t.get("name")
                        if not n:
                            continue
                        names.append(n)
                        c = len(json.dumps(t, ensure_ascii=False))
                        if c > s["tool_chars"].get(n, 0):
                            s["tool_chars"][n] = c
                    key = tuple(sorted(set(names)))
                    s["shape_sets"][key] = s["shape_sets"].get(key, 0) + 1
            if '"tool_use"' in line:
                content = (rec.get("message") or {}).get("content")
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            n = b.get("name") or "?"
                            s["calls"][n] = s["calls"].get(n, 0) + 1
                            s["call_total"] += 1
    return s


def summarize(rows_by_ws):
    """Per-workspace rows; only shaped sessions feed loaded/mobilized (the
    population rule), so mobilized can never exceed loaded."""
    out = []
    for wname, sessions_ in sorted(rows_by_ws.items()):
        with_shape = [s for s in sessions_ if s["shape_sets"]]
        if not with_shape:
            out.append({"workspace": wname, "files_total": len(sessions_),
                        "sessions_with_shapes": 0, "note": "no api-request-shape record"})
            continue
        shape_sets, tool_chars, calls = {}, {}, {}
        calls_total = calls_inshape = 0
        ts_min = ts_max = None
        for s in with_shape:
            for k, v in s["shape_sets"].items():
                shape_sets[k] = shape_sets.get(k, 0) + v
            for n, c in s["tool_chars"].items():
                tool_chars[n] = max(tool_chars.get(n, 0), c)
            for n, c in s["calls"].items():
                calls[n] = calls.get(n, 0) + c
                calls_inshape += c
            if s["ts_min"] and (ts_min is None or s["ts_min"] < ts_min):
                ts_min = s["ts_min"]
            if s["ts_max"] and (ts_max is None or s["ts_max"] > ts_max):
                ts_max = s["ts_max"]
        for s in sessions_:
            calls_total += s["call_total"]
        loaded = set(tool_chars)
        called = set(calls)
        never = sorted(loaded - called)
        mcp_loaded = sorted(n for n in loaded if n.startswith("mcp__"))
        per_shape_never, per_shape_total = [], []
        for key in shape_sets:
            per_shape_total.append(sum(tool_chars.get(n, 0) for n in key))
            per_shape_never.append(sum(tool_chars.get(n, 0) for n in key if n not in called))
        out.append({
            "workspace": wname,
            "files_total": len(sessions_),
            "sessions_with_shapes": len(with_shape),
            "distinct_shapes": len(shape_sets),
            "loaded": len(loaded),
            "loaded_mcp": len(mcp_loaded),
            "mobilized": len(called),
            "mobilized_mcp": len([n for n in mcp_loaded if n in called]),
            "calls_in_shaped_sessions": calls_inshape,
            "calls_all_sessions": calls_total,
            "never_count": len(never),
            "never": [(n, tool_chars[n]) for n in never],
            "top_calls": sorted(calls.items(), key=lambda kv: -kv[1])[:12],
            "med_never_chars": int(statistics.median(per_shape_never)) if per_shape_never else 0,
            "med_total_chars": int(statistics.median(per_shape_total)) if per_shape_total else 0,
            "ts_min": ts_min, "ts_max": ts_max,
            "parse_fail": sum(s["parse_fail"] for s in sessions_),
            "lines": sum(s["lines"] for s in sessions_),
        })
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--projects", default=os.path.expanduser("~/.claude/projects"),
                    help="transcripts root (default ~/.claude/projects)")
    ap.add_argument("--skip", default="",
                    help="comma-separated workspace dir names to skip")
    ap.add_argument("--out", default="",
                    help="optional path for the JSON rows (default: none)")
    args = ap.parse_args(argv)
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}

    acc = {}
    for wname, path, is_sub in sessions(args.projects, skip):
        s = scan_session(path)
        if s is None:
            continue
        s["subagent"] = is_sub
        acc.setdefault(wname, []).append(s)
    rows = summarize(acc)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=1)

    print(f"{'workspace':32s} {'ses':>4s} {'shapes':>6s} {'load':>4s} {'mcpL':>4s} {'mob':>4s} "
          f"{'mcpM':>4s} {'calls':>7s} {'never':>5s} {'medNever':>8s} {'medShape':>8s}")
    for r in rows:
        if not r.get("sessions_with_shapes"):
            print(f"{r['workspace']:32s}  (no api-request-shape record "
                  f"in {r['files_total']} file(s))")
            continue
        print(f"{r['workspace']:32s} {r['sessions_with_shapes']:4d} {r['distinct_shapes']:6d} "
              f"{r['loaded']:4d} {r['loaded_mcp']:4d} {r['mobilized']:4d} {r['mobilized_mcp']:4d} "
              f"{r['calls_in_shaped_sessions']:7d} {r['never_count']:5d} "
              f"{r['med_never_chars']:8d} {r['med_total_chars']:8d}")
    stamped = [r for r in rows if r.get("ts_min")]
    if stamped:
        print("window:", min(r["ts_min"] for r in stamped),
              "->", max(r["ts_max"] or "" for r in stamped))
    return 0


if __name__ == "__main__":
    sys.exit(main())
