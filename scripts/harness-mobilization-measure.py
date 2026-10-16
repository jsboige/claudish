#!/usr/bin/env python3
"""Harness mobilization measure (#23 "charge vs mobilise", mobilise side).

Scans hub capture req-*.json files for one machine and one day, then reports
which harness-injected files the agents ever CONSULT in-flight: a tool_use
(Read/Grep/Glob/LS) whose input path matches a file cited by a "Contents of
<path>" marker in that conversation's history. The charge side (injected
chars per request) is harness-injection-measure.py's job; this script answers
the complementary question — after injection, does anyone ever re-open the
source file?

Usage:
    python -I scripts/harness-mobilization-measure.py \
        --share //192.168.0.50/d$/claudish-captures \
        --day 2026-10-15 --machine myia-po-2024

Traps baked into the design (all hit during the first run, 16/10):
  - UNC paths from python: FORWARD SLASHES ONLY ("//host/d$/dir"). Backslash
    forms die as WinError 3 because every shell/heredoc layer between here
    and python eats one doubling; // survives everywhere (SMB and Win32 both
    normalize it).
  - Lane attribution is the project "Contents of <path>" marker path, NEVER a
    raw "WorkspaceName in messages" string gate: the string also matches other
    lanes whose memory prose mentions the workspace (measured: a raw gate let
    the roo-extensions lane in through its MEMORY.md).
  - model in the capture envelope is the CLIENT-REQUESTED id, pre-remap. An
    opus-requesting lane on a machine with no Anthropic credential is cascade
    input, not an Anthropic-billed serve.
  - A request's history carries only PAST turns: per-request mobilization
    undercounts the first turn of each conversation (same bias every lane).
  - Filename sort is lexicographic: req-1-10000-* sorts BEFORE req-1-9999-*.
    Parse timestamps from the name; never trust sorted()[-1] as "latest".
"""

import argparse
import collections
import json
import os
import re
import sys

TOOL_NAMES = {"Read", "Grep", "Glob", "LS"}
CONTENTS_RE = re.compile(r"Contents of ([^\s(]+)\s*\(")
MACHINE_RE = re.compile(r'"machine":"([^"]*)"')
TS_RE = re.compile(r'"ts":"([^"]*)"')
MODEL_RE = re.compile(r'"model":"([^"]*)"')
NAME_TS_RE = re.compile(r"-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})")


def lane_of(cited):
    """Lane label from the cited-path set: the project CLAUDE.md parent dir,
    else the component before '.claude', else the memory-project hash."""
    for c in cited:
        low = c.replace("\\", "/").lower()
        if low.endswith("claude.md"):
            ws = low[: -len("claude.md")].rstrip("/").split("/")[-1]
            if ws != ".claude":  # bare ~/.claude/CLAUDE.md is machine-level, not a lane
                return ws
    for c in cited:
        low = c.replace("\\", "/").lower()
        if "/.claude/" in low:
            return low.split("/.claude/")[0].split("/")[-1]
    for c in cited:
        low = c.replace("\\", "/").lower()
        if "/projects/" in low and "/memory/" in low:
            return low.split("/projects/")[1].split("/")[0]
    return "(machine-level only)"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--share", required=True, help="capture dir, forward slashes: //host/d$/claudish-captures")
    ap.add_argument("--day", required=True, help="capture day as it appears in filenames: 2026-10-15")
    ap.add_argument("--machine", required=True, help="x-claudish-machine value to keep")
    ap.add_argument("--limit", type=int, default=0, help="stop after N po-2024 requests (0 = all)")
    args = ap.parse_args()

    names = []
    latest = ("", "")
    for n in os.listdir(args.share):
        if not n.startswith("req-") or f"-{args.day}T" not in n:
            continue
        names.append(n)
        m = NAME_TS_RE.search(n)
        if m:
            key = m.group(1) + "T" + m.group(2) + ":" + m.group(3) + ":" + m.group(4)
            latest = max(latest, (key, n))
    if not names:
        sys.exit(f"no req-* captures for {args.day} in {args.share}")
    print(f"corpus: {len(names)} req files for {args.day} (latest {latest[0]}Z)", flush=True)

    # Pass 1: head-read for machine attribution (envelope lives in the first bytes).
    kept = []
    for i, n in enumerate(sorted(names)):
        try:
            with open(os.path.join(args.share, n), encoding="utf-8", errors="replace") as f:
                head = f.read(512)
        except OSError as e:
            print(f"  headerr {n}: {e}", file=sys.stderr)
            continue
        m = MACHINE_RE.search(head)
        if m and m.group(1) == args.machine:
            kept.append((n, TS_RE.search(head), MODEL_RE.search(head)))
        if (i + 1) % 5000 == 0:
            print(f"  pass1 {i + 1}/{len(names)} kept={len(kept)}", flush=True)
        if args.limit and len(kept) >= args.limit:
            break
    print(f"pass1: {len(kept)} {args.machine} requests", flush=True)

    # Pass 2: full read, extract citations + mobilization.
    agg = collections.defaultdict(lambda: {"req": 0, "mob": 0, "models": collections.Counter(),
                                           "mfiles": collections.Counter(), "cfiles": collections.Counter()})
    for i, (n, ts, mo) in enumerate(kept):
        try:
            with open(os.path.join(args.share, n), encoding="utf-8", errors="replace") as f:
                doc = json.load(f)
        except Exception as e:
            print(f"  jsonerr {n}: {e}", file=sys.stderr)
            continue
        body = doc.get("body") or {}
        msgs = body.get("messages")
        if not isinstance(msgs, list):
            continue
        cited = set()
        sources = []
        if isinstance(body.get("system"), list):
            sources += body["system"]
        for msg in msgs:
            if isinstance(msg, dict) and isinstance(msg.get("content"), list):
                sources += msg["content"]
        for blk in sources:
            if isinstance(blk, dict) and isinstance(blk.get("text"), str) and "Contents of " in blk["text"]:
                for c in CONTENTS_RE.finditer(blk["text"]):
                    cited.add(c.group(1))
        mobil = []
        for msg in msgs:
            if not isinstance(msg, dict) or msg.get("role") != "assistant":
                continue
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for blk in content:
                if not isinstance(blk, dict) or blk.get("type") != "tool_use" or blk.get("name") not in TOOL_NAMES:
                    continue
                inp = blk.get("input") or {}
                for key in ("file_path", "path", "notebook_path"):
                    v = inp.get(key)
                    if not isinstance(v, str):
                        continue
                    vv = v.replace("\\", "/").lower()
                    for c in cited:
                        cl = c.replace("\\", "/").lower()
                        if vv == cl or vv.startswith(cl.rstrip("/") + "/"):
                            mobil.append((blk.get("name"), c))
                            break
        lane = lane_of(sorted(cited)) if cited else "(no citation)"
        a = agg[lane]
        a["req"] += 1
        a["models"][mo.group(1) if mo else "?"] += 1
        for c in cited:
            a["cfiles"][c.split("\\")[-1]] += 1
        if mobil:
            a["mob"] += 1
            for tool, c in mobil:
                a["mfiles"][c.split("\\")[-1] + " <- " + tool] += 1
        if (i + 1) % 1000 == 0:
            print(f"  pass2 {i + 1}/{len(kept)}", flush=True)

    total = sum(a["req"] for a in agg.values())
    print(f"\n=== mobilization by lane ({total} requests) ===")
    for lane, a in sorted(agg.items(), key=lambda kv: -kv[1]["req"]):
        rate = 100 * a["mob"] / a["req"] if a["req"] else 0
        print(f"{lane}: {a['req']} req, mobilized {a['mob']} ({rate:.1f}%), models={dict(a['models'].most_common(3))}")
        top = dict(a["mfiles"].most_common(4))
        print(f"   mobilized files: {top if top else 'NONE'}")
        never = [f for f in a["cfiles"] if not any(f + " <-" in k for k in a["mfiles"])]
        if never:
            print(f"   NEVER mobilized ({len(never)} cited files): {', '.join(sorted(never)[:12])}{' ...' if len(never) > 12 else ''}")


if __name__ == "__main__":
    main()
