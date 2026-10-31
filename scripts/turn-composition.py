#!/usr/bin/env python3
"""turn-composition.py -- of what is the TURN SURPLUS made? (#328)

#328 decomposed the spend as `ctx total x3.68 ~= requests x3.41 x harness-floor
x1.08` (05/07 vs 30/09). The harness floor is stable, so the surplus lives in
the NUMBER of turns. This tool answers the next question -- of what are those
turns made -- with three cheap sub-commands. None of them parses the whole
corpus; each reads the minimum bytes that carry its answer.

  envelope  WHICH LANE emits the turns. The capture envelope (ts, src, machine,
            model, entrypoint, hops) is serialized BEFORE the body, so a head
            read of ~2 KB per file attributes the whole corpus (~75k files,
            ~150 MB of I/O) instead of a sample. -> "more agents" vs "longer
            agents", per machine.

  history   WHAT ONE TURN RE-PAYS. n_messages, the inline role:"system" count,
            the bytes per role, and the same figures bucketed by assistant
            turns. The per-turn system tax is the ratio n_system / n_assistant:
            ~1 means the harness injects a system block on EVERY turn and the
            tax compounds with history length; ~0.2 means it is occasional.

  nudge     WHICH harness nudge rides those turns, and whether it is a
            PASSENGER or a TURN OF ITS OWN. A trailing system block whose
            predecessor is a user/tool_result message rode a turn that had to
            happen anyway (lever = shrink the text); one whose predecessor is
            an assistant final answer is a request emitted for nothing
            (lever = stop emitting the turn). The two call for opposite fixes,
            so the classification comes before any conclusion.

  archive   THE SAME ENVELOPE ATTRIBUTION, OVER THE DAY ARCHIVES. The live
            corpus only holds the last ~2 days: the nightly compaction rotates
            everything older into per-day .7z archives, so a before/after
            comparison cannot be read from the live directory at all. This
            sub-command streams the archives' request members and head-reads
            them WITHOUT extracting them to disk: `7z e -so` writes the
            members to a pipe, the envelope is the first ~2 KB of each member,
            and a capture's envelope timestamp is a file boundary marker.
            The member count is cross-checked against the archive index, so a
            boundary that did not split cleanly is a LOUD failure, never a
            silently short corpus.

Usage
-----
  python scripts/turn-composition.py envelope --dir D:\\claudish-captures --label now
  python scripts/turn-composition.py envelope --dir D:\\claudish-autopsy\\july05 --label july
  python scripts/turn-composition.py history  --dir D:\\claudish-captures --label now --limit 400
  python scripts/turn-composition.py nudge    --dir D:\\claudish-captures --label now --limit 400
  python scripts/turn-composition.py archive --archives "G:\\...\\captures-2026-07-*.7z" --label july

Reading rules (the traps this tool was built against, all measured 29/10):

  * Credential precedence is ENV-FIRST, then the config home's `apiKeys` map.
    Measured 31/10 (po-2025, `docker exec claudish-proxy env`): the key that
    authenticated `vllm-myia` was the container's `VLLM_API_KEY`, while
    `config.json` still carried a stale 15-character literal for the same
    variable -- a config-only probe reads the wrong key, and an env-only probe
    reports MISSING for a rung that serves traffic fine. Read BOTH; let
    `routability` name the winner. Never conclude "not routable" from one
    source alone.
  * `last_role == "system"` does NOT mean "harness-driven turn" (see `nudge`):
    since Claude Code v2.1.153+ the client appends an output-style reminder as
    an inline system message after the tool_result. Measured 29/10: 83.1 % of
    requests end that way, and 324/332 of them ride a user/tool_result turn.
  * Sampling is a deterministic spread over the files sorted by the timestamp
    carried IN THE NAME (sorting by name groups by pid first, so it is not
    chronological), and the picks always cover the newest capture. The coverage
    is printed (`sampling`: available / sampled / skipped / covers_newest), not
    implied: an earlier version kept the first `limit` names and dropped the
    tail silently -- n=799 at limit=400 lost the last 399 files with nothing in
    the output saying so.
  * An era comparison must state its incomparabilities: pre-#98 captures carry
    no `entrypoint` / `workload` / `device_id8`, and part of July carries no
    `session_id`. The tool returns None rather than inventing a value.
"""
from __future__ import annotations

import argparse
import collections
import fnmatch
import glob
import json
import os
import re
import statistics
import subprocess
import sys

TS_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d\d)[-:](\d\d)[-:](\d\d)")
KEYS_RE = re.compile(
    r'"(ts|src|machine|model|pid|instanceId|device_id8|entrypoint|hops)"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}\]]+)'
)
VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")

# A capture file opens with its envelope, and the envelope's timestamp is the
# hub's own capture shape: dashes between every time field (2026-10-16T01-03-
# 36-874Z). The marker is the envelope's OPENING — timestamp AND the key that
# follows it — not `{"ts":` alone: a body may embed a JSON object carrying a
# `ts` key, and a loose marker would split the stream in the middle of a body
# (silently mis-attributing the rest). The loose form is kept as a fallback
# for an era whose envelope had another key order; the member count is
# cross-checked against the archive index either way.
MEMBER_RE = re.compile(rb'\{"ts":"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z","src":"')
MEMBER_RE_LOOSE = re.compile(rb'\{"ts":"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z"')

SEVENZIP_CANDIDATES = [
    r"D:\PortableApps\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe",
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
]


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def csize(x) -> int:
    try:
        return len(json.dumps(x, ensure_ascii=False))
    except Exception:
        return 0


def text_len(content) -> int:
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        n = 0
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text" and isinstance(b.get("text"), str):
                    n += len(b["text"])
                else:
                    n += csize(b)
            elif isinstance(b, str):
                n += len(b)
        return n
    if content is None:
        return 0
    return csize(content)


def first_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text" and isinstance(b.get("text"), str):
                    return b["text"]
                return json.dumps(b, ensure_ascii=False)
    return ""


def has_block(m, t) -> bool:
    c = m.get("content") if isinstance(m, dict) else None
    if not isinstance(c, list):
        return False
    return any(isinstance(b, dict) and b.get("type") == t for b in c)


def pctile(vals, q):
    if not vals:
        return 0
    s = sorted(vals)
    return s[min(len(s) - 1, int(q * (len(s) - 1)))]


def _name_ts(name):
    # the capture timestamp carried by the file name (chronological key)
    m = re.search(r"-(\d{4}-\d{2}-\d{2}T[\d-]+Z)-", name)
    return m.group(1) if m else name


def sample_files(directory: str, limit: int):
    """Deterministic sample that covers the window and reports its coverage."""
    names = sorted((n for n in os.listdir(directory)
                    if n.startswith("req-") and n.endswith(".json")),
                   key=_name_ts)
    total = len(names)
    if not limit or limit >= total:
        picked = list(names)
    elif limit == 1:
        picked = [names[-1]]
    else:
        step = (total - 1) / float(limit - 1)
        picked = [names[i] for i in sorted(set(round(k * step) for k in range(limit)))]
    coverage = {"available": total, "sampled": len(picked),
                "skipped": total - len(picked),
                "covers_newest": bool(picked) and picked[-1] == names[-1]}
    return names, picked, coverage


def load_body(path: str):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------
# envelope
# --------------------------------------------------------------------------
def parse_head(blob: str) -> dict:
    """The envelope keys of a capture head. First occurrence wins: the envelope
    is serialized BEFORE the body, so the first `"machine"` in a head is the
    envelope's, not a copy quoted inside a tool result."""
    out = {}
    for m in KEYS_RE.finditer(blob):
        k = m.group(1)
        if k in out:
            continue
        v = m.group(2)
        if v.startswith('"'):
            try:
                out[k] = json.loads(v)
            except Exception:
                out[k] = v.strip('"')
        else:
            out[k] = v.strip()
    return out


def head_fields(path: str, head: int = 2048) -> dict:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            blob = fh.read(head)
    except OSError:
        return {}
    return parse_head(blob)


# --------------------------------------------------------------------------
# archive (the envelope attribution, over the day archives)
# --------------------------------------------------------------------------
def find_sevenzip(explicit: str = "") -> str:
    """Resolve the 7z binary: an explicit path first, then the pinned
    candidates. Empty = not found (the caller says so, it does not guess)."""
    for c in ([explicit] if explicit else []) + SEVENZIP_CANDIDATES:
        if c and os.path.isfile(c):
            return c
    return ""


def archive_index(sevenzip: str, archive: str) -> list:
    """The archive's member names, from the INDEX read (no member data)."""
    proc = subprocess.run([sevenzip, "l", "-slt", archive],
                          capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"7z l failed on {archive}: "
                           f"{proc.stderr.decode('utf-8', 'replace')[:300]}")
    names = []
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        if line.startswith("Path = "):
            names.append(line[len("Path = "):].strip())
    return names


def iter_heads(fh, head: int = 2048, chunk: int = 4 << 20, marker=None):
    """Yield the HEAD of every capture member in a concatenated stream.

    The stream is what `7z e -so` writes: the members back to back, no
    separator. A member's head starts at its envelope marker, so the heads are
    read by scanning for the markers. A member is only yielded once the NEXT
    marker is seen (its end is known), so a truncated stream cannot look
    complete; the last member is yielded at EOF.
    """
    marker = marker or MEMBER_RE
    buf = b""
    while True:
        data = fh.read(chunk)
        if not data:
            break
        buf += data
        ms = list(marker.finditer(buf))
        if not ms:
            if len(buf) > head + 8192:
                buf = buf[-(head + 8192):]
            continue
        keep = ms[-1].start()
        for m in ms[:-1]:
            # The NEXT marker is known, so this member's end is known: its
            # head is fully buffered, even when the member is shorter than
            # the head window (a slice shortens itself, it does not pad).
            yield buf[m.start():m.start() + head]
        buf = buf[keep:]
    m = marker.search(buf)
    if m:
        yield buf[m.start():m.start() + head]


def scan_archive(sevenzip: str, archive: str, pattern: str, head: int, marker):
    """Stream one archive's members and return their parsed envelope heads."""
    proc = subprocess.Popen(
        [sevenzip, "e", "-so", archive, pattern, "-r"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    fields = []
    try:
        for raw in iter_heads(proc.stdout, head, marker=marker):
            fields.append(parse_head(raw.decode("utf-8", "replace")))
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass
        proc.wait()
    return fields


def pick_fields(strict, loose, index_n):
    """Choose the marker that held. The archive index is the ground truth for
    the member count: a marker whose head count disagrees with it did NOT
    split this archive cleanly, and the corpus it yields is not trustworthy.

    Returns (fields, marker_used) with marker_used in strict|loose|none.
    """
    if len(strict) == index_n:
        return strict, "strict"
    if len(loose) == index_n:
        return loose, "loose"
    return (loose if len(loose) > len(strict) else strict), "none"


def day_completeness(n_req: int, n_resp: int) -> dict:
    """How much of a day does this archive's REQUEST census cover?

    A full day's archive holds one request capture and one response capture
    per request, so the two counts are of the same order (measured 30/10:
    49 099 req / 47 194 resp for 28/10, 83 075 / 77 826 for 29/10). An
    archive whose requests are a small minority is a PARTIAL day — its
    request census looks complete and covers a fraction of the day (27/10:
    5 136 req against 57 849 resp).
    """
    total = n_req + n_resp
    share = n_req / float(total) if total else 0.0
    return {
        "index_req": n_req,
        "index_resp": n_resp,
        "requests_share_of_members": round(share, 4),
        "day_looks_complete": share >= 0.5,
    }


def cmd_archive(args):
    sevenzip = find_sevenzip(args.sevenzip)
    if not sevenzip:
        raise SystemExit("NO_7Z: no 7z binary found — pass --sevenzip")

    archives = []
    for pattern in args.archives:
        archives.extend(sorted(glob.glob(pattern)))
    if not archives:
        raise SystemExit("NO_ARCHIVE: the --archives glob matched nothing")

    c_entry, c_machine, c_model = (collections.Counter() for _ in range(3))
    per_day = collections.Counter()
    c_machine_model, c_machine_day = collections.Counter(), collections.Counter()
    unreadable = 0
    total = 0
    per_archive = []

    for archive in archives:
        pattern = args.pattern
        rx = re.compile(fnmatch.translate(pattern))
        all_names = archive_index(sevenzip, archive)
        index_members = [n for n in all_names if rx.match(os.path.basename(n))]
        # A FULL day's archive holds one request capture and one response
        # capture per request: the two counts must be of the same order
        # (measured 30/10: 49 099 req / 47 194 resp for 28/10, 83 075 /
        # 77 826 for 29/10). An archive whose requests are a small minority
        # is a PARTIAL day (27/10: 5 136 req against 57 849 resp) -- its
        # request census would look complete and cover a fraction of the day.
        n_req = sum(1 for n in all_names if os.path.basename(n).startswith("req-"))
        n_resp = sum(1 for n in all_names if os.path.basename(n).startswith("resp-"))
        completeness = day_completeness(n_req, n_resp)
        # The index is the ground truth for "how many members are in there".
        # If the stream split into a different number of heads, the boundary
        # marker did NOT hold on this archive: the corpus is then UNUSABLE,
        # and the counts would be a silent lie. A second, looser marker is
        # tried before giving up (an era whose envelope had another key
        # order), and the marker that held is reported.
        fields = scan_archive(sevenzip, archive, pattern, args.head, MEMBER_RE)
        if len(fields) != len(index_members):
            loose = scan_archive(sevenzip, archive, pattern, args.head, MEMBER_RE_LOOSE)
            fields, marker_used = pick_fields(fields, loose, len(index_members))
        else:
            marker_used = "strict"
        for f in fields:
            if not f:
                unreadable += 1
                continue
            ts = f.get("ts") or ""
            m = TS_RE.search(ts)
            day = f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else "?"
            if args.frm and day < args.frm:
                continue
            if args.to and day > args.to:
                continue
            total += 1
            ep = f.get("entrypoint") or "(none)"
            mach = f.get("machine") or "(none)"
            mod = f.get("model") or "(none)"
            c_entry[ep] += 1
            c_machine[mach] += 1
            c_model[mod] += 1
            per_day[day] += 1
            c_machine_model[(mach, mod)] += 1
            c_machine_day[(mach, day)] += 1
        per_archive.append({
            "archive": archive,
            "index_members": len(index_members),
            "stream_members": len(fields),
            "marker": marker_used,
            "boundary_ok": len(index_members) == len(fields),
            "index_total": len(all_names),
            **completeness,
        })

    mm = collections.defaultdict(list)
    for (mach, mod), v in sorted(c_machine_model.items(), key=lambda kv: (-kv[1], kv[0][0], kv[0][1])):
        mm[mach].append({"model": mod, "n": v})
    md = collections.defaultdict(list)
    for (mach, day), v in sorted(c_machine_day.items()):
        md[mach].append({"day": day, "n": v})

    out = {
        "label": args.label,
        "archives": [a for a in archives],
        "requests_total": total,
        "files_unreadable": unreadable,
        "entrypoint": dict(c_entry.most_common()),
        "machine": dict(c_machine.most_common()),
        "model": dict(c_model.most_common(15)),
        "per_day": {k: per_day[k] for k in sorted(per_day)},
        "machine_model": {k: v[: getattr(args, "top", 8)] for k, v in sorted(mm.items())},
        "machine_per_day": {k: v for k, v in sorted(md.items())},
        "per_archive": per_archive,
        "boundary_all_ok": all(a["boundary_ok"] for a in per_archive),
        "days_look_complete": all(a["day_looks_complete"] for a in per_archive),
    }
    emit(out, args.out)
    if not out["boundary_all_ok"]:
        raise SystemExit("BOUNDARY_MISMATCH: a member count disagrees with the "
                         "archive index — the corpus is NOT trustworthy")
    if not out["days_look_complete"]:
        print("PARTIAL_DAY: an archive holds far fewer request captures than "
              "response captures — its request census covers a FRACTION of "
              "that day. Read per_archive[].requests_share_of_members before "
              "quoting a number.", file=sys.stderr)


def cmd_envelope(args):
    names = sorted(n for n in os.listdir(args.dir) if n.startswith("req-") and n.endswith(".json"))
    c_entry, c_machine, c_model, c_dev = (collections.Counter() for _ in range(4))
    per_day, per_entry_day = collections.Counter(), collections.Counter()
    # cross-tabs: a sibling lane asked for ITS OWN slice -- the per-machine
    # totals alone do not say WHICH model its turns were made of.
    c_machine_model, c_machine_day = collections.Counter(), collections.Counter()
    unreadable = 0
    for n in names:
        f = head_fields(os.path.join(args.dir, n), args.head)
        if not f:
            unreadable += 1
        ts = f.get("ts") or ""
        m = TS_RE.search(ts)
        day = f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else "?"
        ep = f.get("entrypoint") or "(none)"
        mach = f.get("machine") or "(none)"
        mod = f.get("model") or "(none)"
        c_entry[ep] += 1
        c_machine[mach] += 1
        c_model[mod] += 1
        c_dev[f.get("device_id8") or "(none)"] += 1
        per_day[day] += 1
        per_entry_day[(ep, day)] += 1
        c_machine_model[(mach, mod)] += 1
        c_machine_day[(mach, day)] += 1

    # top-N models per machine, kept in ONE pass over the sorted counter so the
    # order is deterministic (a Counter's iteration order is insertion order).
    mm = collections.defaultdict(list)
    for (mach, mod), v in sorted(c_machine_model.items(), key=lambda kv: (-kv[1], kv[0][0], kv[0][1])):
        mm[mach].append({"model": mod, "n": v})
    md = collections.defaultdict(list)
    for (mach, day), v in sorted(c_machine_day.items()):
        md[mach].append({"day": day, "n": v})

    out = {
        "label": args.label, "dir": args.dir, "requests_total": len(names),
        "files_unreadable": unreadable,
        "entrypoint": dict(c_entry.most_common()),
        "machine": dict(c_machine.most_common()),
        "model": dict(c_model.most_common(15)),
        "device_id8": dict(c_dev.most_common(15)),
        "per_day": {k: per_day[k] for k in sorted(per_day)},
        "entrypoint_per_day": [
            {"entrypoint": k[0], "day": k[1], "n": v}
            for k, v in sorted(per_entry_day.items(), key=lambda x: (x[0][1], -x[1]))
        ],
        # per-machine slices: what each lane's turns were made of, and when
        "machine_model": {k: v[: getattr(args, "top", 8)] for k, v in sorted(mm.items())},
        "machine_per_day": {k: v for k, v in sorted(md.items())},
    }
    emit(out, args.out)


# --------------------------------------------------------------------------
# history (per-trace budget + the per-turn system tax)
# --------------------------------------------------------------------------
def cmd_history(args):
    names, picked, coverage = sample_files(args.dir, args.limit)
    rows = []
    for n in picked:
        try:
            j = load_body(os.path.join(args.dir, n))
        except Exception as exc:
            print(f"PARSE_FAIL {n}: {exc}", file=sys.stderr)
            continue
        body = j.get("body") or {}
        msgs = [m for m in (body.get("messages") or []) if isinstance(m, dict)]
        roles = [m.get("role") for m in msgs]
        by_role = collections.Counter()
        for m in msgs:
            by_role[m.get("role") or "?"] += text_len(m.get("content"))
        n_sys = roles.count("system")
        n_asst = roles.count("assistant")
        rows.append({
            "n_messages": len(msgs), "n_system": n_sys, "n_assistant": n_asst,
            "chars_system_inline": by_role.get("system", 0),
            "chars_user": by_role.get("user", 0),
            "chars_assistant": by_role.get("assistant", 0),
            "chars_system_top": csize(body.get("system")),
            "chars_tools": csize(body.get("tools")),
            "n_tools": len(body.get("tools") or []),
            "last_role": roles[-1] if roles else None,
        })

    def tot(k):
        return sum(r[k] for r in rows)

    def mean(k):
        return round(statistics.fmean([r[k] for r in rows]), 1) if rows else 0

    grand = sum(tot(k) for k in ("chars_user", "chars_assistant", "chars_system_inline",
                                 "chars_system_top", "chars_tools")) or 1
    buckets = collections.defaultdict(list)
    for r in rows:
        a = r["n_assistant"]
        buckets[0 if a < 10 else 1 if a < 30 else 2 if a < 60 else 3 if a < 120 else 4].append(r)
    labels = {0: "<10 turns", 1: "10-29", 2: "30-59", 3: "60-119", 4: "120+"}

    out = {
        "label": args.label, "dir": args.dir,
        "requests_total": len(names), "sampled": len(rows), "sampling": coverage,
        "mean_per_request_chars": {k.replace("chars_", ""): mean(k) for k in
                                  ("chars_user", "chars_assistant", "chars_system_inline",
                                   "chars_system_top", "chars_tools")},
        "pct_of_bytes": {k.replace("chars_", ""): round(100.0 * tot(k) / grand, 1) for k in
                         ("chars_user", "chars_assistant", "chars_system_inline",
                          "chars_system_top", "chars_tools")},
        "n_messages": {"p50": pctile([r["n_messages"] for r in rows], .5),
                       "p90": pctile([r["n_messages"] for r in rows], .9),
                       "max": max((r["n_messages"] for r in rows), default=0)},
        "n_system_inline": {"p50": pctile([r["n_system"] for r in rows], .5),
                            "p90": pctile([r["n_system"] for r in rows], .9),
                            "max": max((r["n_system"] for r in rows), default=0)},
        "n_tools_declared": {"p50": pctile([r["n_tools"] for r in rows], .5),
                             "p90": pctile([r["n_tools"] for r in rows], .9)},
        "pct_last_role_system": round(100.0 * sum(1 for r in rows if r["last_role"] == "system")
                                      / max(1, len(rows)), 1),
        "growth_by_assistant_turns": [
            {
                "bucket": labels[b], "n": len(buckets[b]),
                "mean_n_messages": round(statistics.fmean([r["n_messages"] for r in buckets[b]]), 1),
                "mean_n_system": round(statistics.fmean([r["n_system"] for r in buckets[b]]), 1),
                "sys_blocks_per_assistant_turn": round(
                    statistics.fmean([(r["n_system"] / r["n_assistant"]) if r["n_assistant"] else 0
                                      for r in buckets[b]]), 3),
                "mean_chars_per_system_block": round(
                    statistics.fmean([(r["chars_system_inline"] / r["n_system"]) if r["n_system"] else 0
                                      for r in buckets[b]]), 0),
                "mean_chars_system_inline": round(
                    statistics.fmean([r["chars_system_inline"] for r in buckets[b]]), 0),
            }
            for b in sorted(buckets)
        ],
    }
    emit(out, args.out)


# --------------------------------------------------------------------------
# nudge (which trailing system block, and is it a turn of its own?)
# --------------------------------------------------------------------------
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}[T0-9:. -]*")
HEX_RE = re.compile(r"\b[0-9a-f]{8,}\b")
NUM_RE = re.compile(r"\b\d+\b")


def norm(s: str, n: int = 90) -> str:
    s = re.sub(r"\s+", " ", s.strip())
    s = HEX_RE.sub("<ID>", DATE_RE.sub("<DATE>", s))
    return NUM_RE.sub("<N>", s)[:n]


def cmd_nudge(args):
    names, picked, coverage = sample_files(args.dir, args.limit)
    clusters, chars, examples = collections.Counter(), collections.Counter(), {}
    classes = collections.Counter()
    sessions = collections.defaultdict(list)
    n_ok = 0
    for n in picked:
        try:
            j = load_body(os.path.join(args.dir, n))
        except Exception:
            continue
        body = j.get("body") or {}
        msgs = [m for m in (body.get("messages") or []) if isinstance(m, dict)]
        if not msgs:
            continue
        n_ok += 1
        last = msgs[-1]
        trailing = last.get("role") == "system"
        if trailing:
            prev = msgs[-2] if len(msgs) >= 2 else None
            prole = prev.get("role") if isinstance(prev, dict) else "(none)"
            if prole == "assistant":
                k = ("prev=assistant+tool_use" if has_block(prev, "tool_use")
                     else "prev=assistant+NO_tool_use(OWN-TURN)")
            elif prole == "user":
                k = "prev=user+tool_result" if has_block(prev, "tool_result") else "prev=user+no_tool_result"
            else:
                k = f"prev={prole}"
            classes[k] += 1
            t = first_text(last.get("content"))
            key = norm(t)
            clusters[key] += 1
            chars[key] += len(t)
            examples.setdefault(key, re.sub(r"\s+", " ", t.strip())[:260])
        sid = ""
        try:
            uid = (body.get("metadata") or {}).get("user_id")
            if uid:
                sid = (json.loads(uid) or {}).get("session_id") or ""
        except Exception:
            pass
        if sid:
            core = msgs[:-1] if trailing else msgs
            sig = (len(core), first_text(core[-1].get("content"))[:120] if core else "")
            sessions[sid].append(sig)

    dup = sum(v - 1 for items in sessions.values() for v in collections.Counter(items).values() if v > 1)
    dup_sessions = sum(1 for items in sessions.values()
                       if any(v > 1 for v in collections.Counter(items).values()))
    n_trailing = sum(classes.values())
    out = {
        "label": args.label, "dir": args.dir,
        "requests_total": len(names), "sampled": n_ok, "sampling": coverage,
        "ended_with_system": n_trailing,
        "pct_ended_with_system": round(100.0 * n_trailing / max(1, n_ok), 1),
        "classification": dict(classes.most_common()),
        "clusters": [
            {"n": c, "pct": round(100.0 * c / max(1, n_trailing), 1),
             "mean_chars": round(chars[k] / c), "example": examples[k]}
            for k, c in clusters.most_common(args.top)
        ],
        "sessions_in_sample": len(sessions),
        "sessions_with_repeated_state": dup_sessions,
        "duplicate_state_requests": dup,
    }
    emit(out, args.out)


# --------------------------------------------------------------------------
# routability: which declared rungs can actually authenticate on this seat
# --------------------------------------------------------------------------
def cmd_routability(args):
    with open(args.config, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    api_keys = cfg.get("apiKeys") or {}
    env_present = {}
    if args.container:
        import subprocess
        try:
            raw = subprocess.run(["docker", "exec", args.container, "env"],
                                 capture_output=True, text=True, timeout=60).stdout
            for line in raw.splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    env_present[k] = len(v) > 0
        except Exception as exc:
            print(f"WARN: cannot read container env: {exc}", file=sys.stderr)

    rows = []
    eps = cfg.get("customEndpoints") or {}
    for name, ep in (eps.items() if isinstance(eps, dict) else [(e.get("name"), e) for e in eps]):
        if not isinstance(ep, dict):
            continue
        tmpl = ep.get("apiKey")
        vars_ = VAR_RE.findall(tmpl) if isinstance(tmpl, str) else []
        missing = [v for v in vars_
                   if not (api_keys.get(v) or env_present.get(v))]
        rows.append({
            "endpoint": name, "baseUrl": ep.get("baseUrl") or ep.get("url"),
            "apiPath": ep.get("apiPath"), "authScheme": ep.get("authScheme"),
            # precedence is env-FIRST (measured 31/10): name the source that WINS
            "credential_source": (
                ("env:" + ",".join(v for v in vars_ if env_present.get(v)))
                if any(env_present.get(v) for v in vars_)
                else (("apiKeys:" + ",".join(v for v in vars_ if api_keys.get(v)))
                      if any(api_keys.get(v) for v in vars_)
                      else "literal/none")),
            "status": "OK" if not missing else "MISSING:" + ",".join(missing),
        })
    out = {
        "config": args.config, "container": args.container,
        "apiKeys_map_names": sorted(api_keys),
        "endpoints": rows,
        "note": "credential resolution is ENV-FIRST, then the config home's apiKeys map "
                "(measured 31/10: VLLM_API_KEY in the container authenticated vllm-myia "
                "while config.json carried a stale literal). `credential_source` names the "
                "winner. Authenticatable is NOT routable: this reads credentials and "
                "endpoint declarations only -- no cascade order, no wall, no routing.",
    }
    emit(out, args.out)


def emit(obj, path):
    text = json.dumps(obj, indent=2, ensure_ascii=False)
    print(text)
    if path:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("envelope", help="which lane emits the turns (head reads only)")
    e.add_argument("--dir", required=True)
    e.add_argument("--label", required=True)
    e.add_argument("--head", type=int, default=2048)
    e.add_argument("--top", type=int, default=8)
    e.add_argument("--out")
    e.set_defaults(func=cmd_envelope)

    h = sub.add_parser("history", help="what one turn re-pays + the per-turn system tax")
    h.add_argument("--dir", required=True)
    h.add_argument("--label", required=True)
    h.add_argument("--limit", type=int, default=400)
    h.add_argument("--out")
    h.set_defaults(func=cmd_history)

    n = sub.add_parser("nudge", help="which trailing system block rides the turn (passenger vs own turn)")
    n.add_argument("--dir", required=True)
    n.add_argument("--label", required=True)
    n.add_argument("--limit", type=int, default=400)
    n.add_argument("--top", type=int, default=12)
    n.add_argument("--out")
    n.set_defaults(func=cmd_nudge)

    r = sub.add_parser(
        "routability",
        help="credential resolvability ONLY -- which declared rungs hold a resolvable "
             "credential in this config home (env first, then apiKeys). Says nothing "
             "about cascade order, walls, or whether a request would be routed here")
    r.add_argument("--config", required=True)
    r.add_argument("--container", default="")
    r.add_argument("--out")
    r.set_defaults(func=cmd_routability)

    a = sub.add_parser("archive", help="the envelope attribution, over the day .7z archives")
    a.add_argument("--archives", nargs="+", required=True,
                   help="one or more .7z paths or globs")
    a.add_argument("--label", required=True)
    a.add_argument("--sevenzip", default="")
    a.add_argument("--from", dest="frm", default="", help="first day, YYYY-MM-DD")
    a.add_argument("--to", dest="to", default="", help="last day, YYYY-MM-DD")
    a.add_argument("--head", type=int, default=2048)
    a.add_argument("--pattern", default="req-*.json",
                   help="member pattern, used for BOTH the stream and the index "
                        "cross-check (a scoped run stays self-consistent)")
    a.add_argument("--top", type=int, default=8)
    a.add_argument("--out")
    a.set_defaults(func=cmd_archive)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
