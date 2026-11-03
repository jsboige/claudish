#!/usr/bin/env python3
r"""Attribute captured requests to a working directory, from the request body alone.

Enquiry #328 (grain M1) / epic #445. The fleet reports "responses per merged PR",
a ratio whose numerator is counted per REQUEST and whose denominator is counted
per REPOSITORY. Nothing supplied the missing axis on the numerator side. This
instrument does, using only what a captured `req-*` body already carries: Claude
Code writes its environment preamble into every prompt, and the first line of it
names the working directory.

Marker contract (measured 2026-11-03 on capture archives 2026-07-27 .. 09-07):

    Primary working directory: d:\\dev\\CoursIA
    - Is a git repository: true
    - Platform: win32

and, in the SAME field from ~2026-09-08, the previous directory too:

    Primary working directory: d:\\dev\\CoursIA (was c:\\dev\\CoursIA)

⚠ TRAP 1 — the ` (was …)` suffix. Splitting the line on the separator before
dropping that suffix yields `coursia)` as a workspace key. Measured on ONE day of
the 2026-09-07 week (300 sampled bodies): 38 landed in `coursia)`, 33 in
`coursia-2)`, 13 in `roo-extensions)` — the naive parse splits every workspace in
two and halves the main bucket. Pin: `test_previous_directory_suffix`.

⚠ TRAP 2 — a path segment ENDING IN the letter `n`. In the JSON-escaped body a
literal backslash is `\\`, and the preamble's newline is `\n`; a naive
`find("\\n")` therefore cuts at the first backslash of `d:\\dev\\new`, i.e. at
`d:` — which is how a `d:` workspace bucket with hundreds of responses/day
appeared in the first run of this analysis. Unescape the double backslashes
BEFORE turning `\n` into a newline. Pin: `test_path_segment_ending_in_n`.

⚠ TRAP 3 — a body can carry many markers (a transcript quoted inside a
tool_result, a compaction summary). The LAST one is the request's own directory:
bodies are appended to, never rewritten. Pin: `test_last_marker_wins`.

A body with NO marker is not "unknown": the preamble is emitted by Claude Code, so
its absence means the request did not come from a Claude Code client at all — an
MCP server, a script, another agent. It is bucketed `(non-cc)` and kept in the
denominator under its own name, never dropped: that population can never produce
a PR, and hiding it is what makes a per-PR ratio look like a regression.

Sampling is a stride over each period's request names, not a head slice: a head
slice of an archive follows one hour of one machine. The estimate assumes the
stride sample is representative of the period — it is an ESTIMATE, and the tool
says so in its own output.

Usage:
    python scripts/capture-workspace-attribution.py --week 2026-09-07
    python scripts/capture-workspace-attribution.py --from 2026-07-27 --to 2026-09-07
    python scripts/capture-workspace-attribution.py --day 2026-09-08 --sample 300 --json out.json
    python scripts/capture-workspace-attribution.py --week 2026-09-07 --census census-days.jsonl
"""

import argparse
import collections
import importlib.util
import json
import os
import re
import sys
from datetime import date, timedelta

MARKER = b"Primary working directory:"
WINDOW = 400
PREVIOUS = re.compile(r"\s+\((?:was|previously)\b[^)]*\)", re.IGNORECASE)
ABSOLUTE = re.compile(r"^(?:[A-Za-z]:[\\/]|[/\\])")
REQ = re.compile(r"req-\d+-\d+-\d{4}-\d{2}-\d{2}T[\d-]+Z-.+\.json$")
NON_CC = "(non-cc)"
UNPARSED = "(unparsed)"
ROOT = "(root)"
DEFAULT_DIRS = (r"D:\claudish-captures\archive", r"G:\Mon Drive\Backups-Cloud\claudish")


def marker_line(body: bytes) -> str | None:
    """The workspace line of the LAST environment preamble in the body, unescaped."""
    idx = body.rfind(MARKER)
    if idx < 0:
        return None
    chunk = body[idx + len(MARKER): idx + len(MARKER) + WINDOW].decode("utf-8", "replace")
    chunk = chunk.replace("\\\\", "\x00")          # a literal path separator
    chunk = chunk.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"')
    chunk = chunk.replace("\x00", "\\")
    line = chunk.split("\n", 1)[0].split('"', 1)[0]
    return line.strip().rstrip("\\").strip()


def workspace_key(body: bytes) -> tuple[str, bool]:
    """(workspace key, came_from_claude_code)."""
    line = marker_line(body)
    if line is None:
        return NON_CC, False
    path = PREVIOUS.sub("", line).strip()
    if not ABSOLUTE.match(path):
        # The marker also appears inside quoted CODE (a script or a prompt that
        # discusses this very string). Such a hit is not a directory: bucket it
        # visibly instead of minting a workspace out of a fragment of source.
        return UNPARSED, True
    path = path.replace("\\", "/").rstrip("/")
    leaf = path.split("/")[-1].strip() if path else ""
    # No generic trailing-punctuation strip: a workspace may legitimately end in
    # `)`. An unknown rendering must show up in the table as itself, not be
    # silently folded into a neighbouring bucket.
    return (leaf.lower() or ROOT), True


def archive_for(day: str, dirs) -> str | None:
    for d in dirs:
        p = os.path.join(d, f"captures-{day}.7z")
        if os.path.isfile(p):
            return p
    return None


def request_names(path: str) -> list[str]:
    import py7zr

    with py7zr.SevenZipFile(path) as z:
        return sorted(n for n in z.getnames() if REQ.search(os.path.basename(n)))


def sample_period(days: list[str], dirs, per_period: int) -> tuple[dict[str, list[str]], list[str]]:
    """Stride-sample request names across a period. Returns (by_day, missing_days)."""
    by_day: dict[str, list[str]] = {}
    missing: list[str] = []
    for day in days:
        p = archive_for(day, dirs)
        if not p:
            missing.append(day)
            by_day[day] = []
            continue
        by_day[day] = request_names(p)
    total = sum(len(v) for v in by_day.values())
    if total == 0:
        return by_day, missing
    stride = max(total // per_period, 1)
    picked: dict[str, list[str]] = {d: [] for d in by_day}
    i = 0
    flat = [(d, n) for d, names in by_day.items() for n in names]
    while i < len(flat):
        d, n = flat[i]
        picked[d].append(n)
        i += stride
    return picked, missing


def read_bodies(day: str, names: list[str], dirs, scratch: str) -> list[bytes]:
    path = archive_for(day, dirs)
    if not path or not names:
        return []
    import py7zr

    out: list[bytes] = []
    with py7zr.SevenZipFile(path) as z:
        available = set(z.getnames())
        targets = [n for n in names if n in available]
        if not targets:
            return []
        z.extract(targets=targets, path=scratch)
    for n in targets:
        fp = os.path.join(scratch, n)
        if os.path.isfile(fp):
            with open(fp, "rb") as f:
                out.append(f.read())
            os.remove(fp)
    return out


def load_census(path: str) -> dict[str, int]:
    """{day: responses} from a jsonl of {"day","resp"} rows."""
    census: dict[str, int] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            census[row["day"]] = row.get("resp", 0)
    return census


def periods(start: date, end: date, weekly: bool) -> list[list[str]]:
    out: list[list[str]] = []
    cur = start
    step = 7 if weekly else 1
    while cur <= end:
        out.append([(cur + timedelta(days=k)).isoformat() for k in range(step)])
        cur += timedelta(days=step)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--day")
    ap.add_argument("--week", help="any day of the week to measure (Monday-based)")
    ap.add_argument("--from", dest="start")
    ap.add_argument("--to", dest="end")
    ap.add_argument("--sample", type=int, default=400, help="request bodies per period (default 400)")
    ap.add_argument("--archives-dir", action="append", default=None)
    ap.add_argument("--census", help="jsonl of {day, resp} to scale counts into responses/day")
    ap.add_argument("--json", help="write the full result here")
    ap.add_argument("--scratch", default=None, help="extraction directory (default: system temp)")
    args = ap.parse_args(argv)

    dirs = tuple(args.archives_dir or DEFAULT_DIRS)
    if args.day:
        d = date.fromisoformat(args.day)
        periods_list = periods(d, d, weekly=False)
    elif args.week:
        d = date.fromisoformat(args.week)
        monday = d - timedelta(days=d.weekday())
        periods_list = periods(monday, monday + timedelta(days=6), weekly=True)
    elif args.start:
        s = date.fromisoformat(args.start)
        e = date.fromisoformat(args.end or args.start)
        periods_list = periods(s, e, weekly=s.weekday() == 0)
    else:
        ap.error("one of --day / --week / --from is required")

    census = load_census(args.census) if args.census else {}
    scratch = args.scratch or os.path.join(os.getcwd(), ".tmp", "ws-attribution")
    os.makedirs(scratch, exist_ok=True)

    results = {}
    for days in periods_list:
        label = days[0]
        picked, missing = sample_period(days, dirs, args.sample)
        counts: collections.Counter = collections.Counter()
        n = 0
        for day, names in picked.items():
            for body in read_bodies(day, names, dirs, scratch):
                key, _cc = workspace_key(body)
                counts[key] += 1
                n += 1
        rows = {k: v for k, v in counts.most_common()}
        entry = {"period": label, "days": days, "sampled": n, "workspaces": rows, "missing_days": missing}
        seen = [d for d in days if census.get(d)]
        if census and seen:
            total = sum(census[d] for d in seen)
            entry["resp_in_period"] = total
            entry["days_with_census"] = len(seen)
            entry["resp_per_day"] = total / len(seen)
            entry["est_resp_per_day"] = {
                k: (v / max(n, 1)) * entry["resp_per_day"] for k, v in rows.items()
            }
        results[label] = entry

        print(f"{label}  sampled={n}  days={len(days)}"
              + (f"  missing={','.join(missing)}" if missing else ""), flush=True)
        for k, v in list(rows.items())[:12]:
            share = 100 * v / max(n, 1)
            line = f"    {k:<40} {v:>5}  {share:5.1f}%"
            if "est_resp_per_day" in entry:
                line += f"   ~{entry['est_resp_per_day'][k]:8.0f} resp/d"
            print(line, flush=True)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=1)
        print(f"\nwrote {args.json}")
    if not args.census:
        print("\nNOTE: counts are raw samples; pass --census to scale them to responses/day.")
    print("NOTE: stride sample — an estimate, not a census. `(non-cc)` = no Claude Code preamble.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
