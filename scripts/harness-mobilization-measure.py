#!/usr/bin/env python3
"""Harness mobilization measure (#23 "charge vs mobilise", mobilise side).

Scans hub capture req-*.json files for one machine and one day, then reports
which harness-injected files the agents ever CONSULT in-flight. The charge
side (injected chars per request) is harness-injection-measure.py's job; this
script answers the complementary question — after injection, does anyone ever
re-open the source file?

A "mobilization" is now detected in every form a file is actually re-opened
(#486 CR):
  - Read/Grep/Glob/LS with a path input (file_path/path/notebook_path);
  - a Grep/Glob/LS scoped to a PARENT directory of the cited file (the
    containing direction — `Grep(path=~/.claude/rules)` reads every rule);
  - a Bash command whose text contains the cited path (cat/sed/head/grep);
  - path-form variants normalized: backslash, case, `~`, Git-Bash `/c/`
    drive form, and `~`-stripped home-relative tails.

Known remaining blind spots (documented, not hidden): a Glob whose only
scoping is `pattern` with no `path` (cwd-relative) is not matched; a Bash
command referencing a cited file by bare basename only (no directory part)
is not matched — both are loose enough to be false-positive factories.

HUB-HOST LOAD RULE (15/10 flap lesson): this script reads the hub's capture
disk over SMB. The default pass is bounded — a pacing sleep every N files
(`--pace-every`, `--pace-sleep`), on both passes — and `--limit` caps the
kept-request count. Every run prints its UTC start and end; report them so a
run can be correlated with hub incidents (hypothesis to record, not blame).

Usage:
    python -I scripts/harness-mobilization-measure.py --selftest
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
  - Cited paths may contain spaces ("G:\\Mon Drive\\…"): the marker regex
    captures up to the " (" separator, never to the first whitespace.
"""

import argparse
import collections
import datetime
import json
import os
import re
import sys
import time

TOOL_NAMES = {"Read", "Grep", "Glob", "LS"}
CONTENTS_RE = re.compile(r"Contents of (.+?)\s*\(")  # up to " (" — spaces survive
MACHINE_RE = re.compile(r'"machine":"([^"]*)"')
TS_RE = re.compile(r'"ts":"([^"]*)"')
MODEL_RE = re.compile(r'"model":"([^"]*)"')
NAME_TS_RE = re.compile(r"-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})")


def norm(p):
    """One canonical form per spelling: forward slashes, lowercased, `~` and
    Git-Bash drive prefixes expanded away where derivable without a home."""
    s = str(p).replace("\\", "/").strip().lower()
    if s.startswith("~/"):
        s = s[2:]
    elif s == "~":
        s = ""
    m = re.match(r"^/([a-z])/(.*)$", s)
    if m:  # /c/users/... -> c:/users/...
        s = m.group(1) + ":/" + m.group(2)
    return s.rstrip("/")


def variants(p):
    """All normalized spellings of a path: canonical, Git-Bash drive form,
    and the home-relative tail (everything after users/<name>/) so a `~` form
    or relative input still matches a cited absolute path."""
    s = norm(p)
    out = {s} if s else set()
    m = re.match(r"^([a-z]):/(.*)$", s)
    if m:
        out.add("/" + m.group(1) + "/" + m.group(2))
        m2 = re.match(r"users/([^/]+)/(.+)", m.group(2))
        if m2:
            out.add(m2.group(2))
    return out


def tool_matches(tool_v, cited_v):
    if tool_v == cited_v:
        return True
    # containing direction: the tool path is a parent dir of the cited file
    if cited_v.startswith(tool_v + "/"):
        return True
    # relative/~ form: tool path is a component-boundary tail of the cited
    # path (>= 2 components, so a bare basename never matches on its own)
    if len(tool_v.split("/")) >= 2 and cited_v.endswith("/" + tool_v):
        return True
    return False


def path_mobilizes(tool_path, cited):
    # norm() alone covers every TOOL-input spelling (~ strip, /c/ drive,
    # case, backslash); variants() on the CITED side adds the Git-Bash and
    # home-relative spellings a tool input or Bash text can carry.
    tv = norm(tool_path)
    if not tv:
        return None
    for c in cited:
        for cv in variants(c):
            if tool_matches(tv, cv):
                return c
    return None


def bash_mobilizes(command, cited):
    cmd = command.replace("\\", "/").lower()
    for c in cited:
        for cv in variants(c):
            if cv in cmd:
                return c
    return None


def extract(doc):
    """One capture doc -> (cited path set, [(form, tool, cited)])."""
    body = doc.get("body") or {}
    msgs = body.get("messages")
    if not isinstance(msgs, list):
        return set(), []
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
                cited.add(c.group(1).strip())
    mobil = []
    for msg in msgs:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for blk in content:
            if not isinstance(blk, dict) or blk.get("type") != "tool_use":
                continue
            name = blk.get("name")
            inp = blk.get("input") or {}
            if name == "Bash":
                cmd = inp.get("command")
                if isinstance(cmd, str):
                    c = bash_mobilizes(cmd, cited)
                    if c:
                        mobil.append(("bash", name, c))
            elif name in TOOL_NAMES:
                for key in ("file_path", "path", "notebook_path"):
                    v = inp.get(key)
                    if isinstance(v, str):
                        c = path_mobilizes(v, cited)
                        if c:
                            mobil.append(("path", name, c))
                        break
    return cited, mobil


def selftest():
    """One positive per re-opening form + one negative. Each positive turns
    red if its detection branch (Bash counting, dir containment, path-variant
    normalization, space-safe marker regex) is removed."""
    RULE = r"C:\Users\u\.claude\rules\a.md"
    SPACE = r"G:\Mon Drive\projets\w.md"

    def doc(cited_paths, tool_name, tool_input):
        marker = "\n".join(f"Contents of {p} (12 lines)" for p in cited_paths)
        return {
            "body": {
                "system": [{"type": "text", "text": marker}],
                "messages": [
                    {"role": "user", "content": [{"type": "text", "text": marker}]},
                    {"role": "assistant", "content": [
                        {"type": "tool_use", "name": tool_name, "input": tool_input}
                    ]},
                ],
            }
        }

    cases = [
        # (label, doc, expected cited file or None)
        ("read_exact", doc([RULE], "Read", {"file_path": RULE}), RULE),
        ("read_backslash_variant", doc([RULE], "Read", {"file_path": RULE.replace("\\", "/")}), RULE),
        ("bash_cat", doc([RULE], "Bash", {"command": f"cat '{RULE}'"}), RULE),
        ("bash_gitbash_form", doc([RULE], "Bash", {"command": "head -5 /c/Users/u/.claude/rules/a.md"}), RULE),
        ("grep_parent_dir", doc([RULE], "Grep", {"path": "~/.claude/rules", "pattern": "x"}), RULE),
        ("tilde_read", doc([RULE], "Read", {"file_path": "~/.claude/rules/a.md"}), RULE),
        ("space_path_read", doc([SPACE], "Read", {"file_path": SPACE}), SPACE),
        ("space_path_bash", doc([SPACE], "Bash", {"command": f"grep x '{SPACE}'"}), SPACE),
        ("negative_unrelated", doc([RULE], "Read", {"file_path": r"D:\unrelated\other.md"}), None),
        ("negative_bare_basename", doc([RULE], "Bash", {"command": "cat a.md"}), None),
    ]
    failures = []
    for label, d, want in cases:
        cited, mobil = extract(d)
        got = mobil[0][2] if mobil else None
        ok = got == want and (want is None or len(mobil) >= 1)
        print(f"  {'PASS' if ok else 'FAIL'} {label}: mobilized={got!r} (want {want!r})")
        if not ok:
            failures.append(label)
    # marker regex must keep the space inside the cited path
    cited, _ = extract(doc([SPACE], "Read", {"file_path": SPACE}))
    if cited != {SPACE}:
        print(f"  FAIL marker_regex_space: cited={cited!r}")
        failures.append("marker_regex_space")
    else:
        print("  PASS marker_regex_space")
    if failures:
        sys.exit(f"selftest FAILED: {failures}")
    print("selftest: all forms green")


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
    ap.add_argument("--share", help="capture dir, forward slashes: //host/d$/claudish-captures")
    ap.add_argument("--day", help="capture day as it appears in filenames: 2026-10-15")
    ap.add_argument("--machine", help="x-claudish-machine value to keep")
    ap.add_argument("--limit", type=int, default=0, help="stop after N kept machine requests (0 = all)")
    ap.add_argument("--pace-every", type=int, default=10, help="pace the SMB pass: sleep every N files (0 = off)")
    ap.add_argument("--pace-sleep", type=float, default=0.05, help="pacing sleep in seconds")
    ap.add_argument("--selftest", action="store_true", help="run the synthetic form-coverage selftest, no SMB")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return
    if not (args.share and args.day and args.machine):
        sys.exit("--share, --day and --machine are required (or --selftest)")

    started = datetime.datetime.now(datetime.timezone.utc)
    print(f"run start (UTC): {started.isoformat()}", flush=True)

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

    def pace(i):
        if args.pace_every and (i + 1) % args.pace_every == 0:
            time.sleep(args.pace_sleep)

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
        pace(i)
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
        cited, mobil = extract(doc)
        lane = lane_of(sorted(cited)) if cited else "(no citation)"
        a = agg[lane]
        a["req"] += 1
        a["models"][mo.group(1) if mo else "?"] += 1
        for c in cited:
            a["cfiles"][c.split("\\")[-1]] += 1
        if mobil:
            a["mob"] += 1
            for form, tool, c in mobil:
                a["mfiles"][c.split("\\")[-1] + " <- " + tool + "/" + form] += 1
        if (i + 1) % 1000 == 0:
            print(f"  pass2 {i + 1}/{len(kept)}", flush=True)
        pace(i)

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
    ended = datetime.datetime.now(datetime.timezone.utc)
    print(f"run end (UTC): {ended.isoformat()} (elapsed {(ended - started).total_seconds():.0f}s)", flush=True)


if __name__ == "__main__":
    main()
