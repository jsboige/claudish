#!/usr/bin/env python3
"""turn-autopsy.py -- #328 G12: stratified autopsy of agent turns.

Why this exists
---------------
The July-vs-now question (`jsboige/claudish#328`) is "x3.4 requests for ~half the
PRs". Counters answered the *what* (ctx total x6.13 = x3.41 requests x x1.80
harness floor, 05/07 vs 30/09) and refused the *why*: that answer lives in the
NATURE of each turn, which is only in the bodies. This tool turns a 400-600 KB
request body into a ~1.5 KB reading slice, so a reader can classify 50-100
turns/hour without opening a JSON by hand.

It does NOT classify. It extracts the material a reader needs, then aggregates
the labels the reader wrote.

Subcommands
-----------
  sample     Work-list: bounded, seeded sample of turns, with reading slices.
  show       Render a work-list as reading slices -- the reader's input.
  label      Scaffold a labels file from a work-list (one blank record per turn).
  stats      Per-era distributions: trigger, last role, machine, lane, pairing.
  aggregate  nature x era table from a work-list plus its labels file.

Corpus
------
Captures live in `D:\\claudish-captures` (loose = the live day) and
`D:\\claudish-captures\\archive\\captures-YYYY-MM-DD.7z` (30-day local), then
`G:\\Mon Drive\\Backups-Cloud\\claudish\\` (single home of history).

Filename grammar -- the free lunch, no body parse required:

  req-1-0001-2026-07-05T02-00-04-064Z-192.168.0.254__192.168.0.254_57617.json
  req-1-0002-2026-07-05T02-00-06-902Z-direct.json          (no upstream proxy)
  resp-1-r0001-2026-07-05T02-00-06-569Z-openai-glm-5.2.sse (handler + model)

The IP chain answers "which client"; the resp name answers "which lane". Both
without opening a body. `machine` lives in the envelope.

Measured trap: **pre-#98 captures carry `machine` but NOT `entrypoint`,
`workload` or `device_id8`** (verified on captures-2026-07-05). The tool must
degrade: those fields come back `null`, never invented.

Heavy-analysis rule (CLAUDE.md): extraction writes to D:, never C:, and a full
day's decompression pegs the hub host -- prefer a bounded sample and the
05-07Z trough for anything large.
> **Trap, measured 2026-10-09**: the lane must come out of the filename with a
> STRICT timestamp pattern. A loose `(.+?)-([a-z0-9_.-]+)-(.+?)` split the
> TIMESTAMP itself (`T`/`Z` are outside the class), manufacturing thousands of
> distinct "lanes" -- one per turn -- which a `max(1, ...)` allocation then
> turned into "extract 14 244 members for --n 50". The tool therefore prints the
> lane count BEFORE extracting: a lane count near the turn count is that bug.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

SEVENZIP = os.environ.get(
    "SEVENZIP", r"D:\PortableApps\PortableApps\7-ZipPortable\App\7-Zip\7z.exe"
)
SCRATCH_ROOT = os.environ.get("AUTOPSY_TMP", r"D:\claudish-autopsy")

# --- the grid -------------------------------------------------------------
# Separated on purpose (ai-01, 2026-10-08): nature, result and confidence are
# three axes, never one label. "absence of mutation is not proof of ceremony".
NATURE = [
    "production",       # writes code/docs: an artefact is created or changed
    "verification",     # tests, review, CI, checking someone else's work
    "coordination",     # dashboard, inbox, dispatch, ACK, status
    "navigation",       # read/grep to understand, before acting
    "context-repair",   # compaction, re-reading after loss, re-grounding
    "duplicate-restart",# the same work re-issued (retry, redo, second attempt)
    "waiting-poll",     # polling, waiting on an external event
    "other",
]
RESULT = ["advanced", "no-op", "regression", "unknown"]
CONFIDENCE = ["measured", "inferred", "uncertain"]

# --- turn triggers --------------------------------------------------------
# Read off the LAST message. The pilot (2026-10-09, 49 July turns) showed a
# large share of turns are driven by nothing the agent or the user asked for:
# the harness injects the prompt itself. That share is measurable, so it is
# measured rather than eyeballed. Order matters -- first match wins.
TRIGGERS = [
    ("todo-nudge", re.compile(r"The TodoWrite tool hasn't been used recently")),
    ("bg-notification", re.compile(r"Command running in background with ID:")),
    ("date-change", re.compile(r"The date has changed\. Today's date is now")),
    ("cron", re.compile(r"You are running as a scheduled cron job")),
    ("compaction", re.compile(r"CRITICAL: Respond with TEXT ONLY|Respond with plain text only")),
    ("system-reminder", re.compile(r"^\s*<system-reminder>")),
]
AUTOMATIC_TRIGGERS = {"todo-nudge", "bg-notification", "date-change", "cron"}


def classify_trigger(msgs: list) -> str:
    """Tool-result FIRST (#424 CR): a message carrying a `tool_result` block is
    a tool-result turn, full stop -- its tool_result content may QUOTE harness
    phrases ("Command running in background with ID:" is the agent's own Bash
    result echoing the notification shape) and must not masquerade as a nudge.
    Trigger regexes only ever read text blocks."""
    if not msgs:
        return "empty"
    last = msgs[-1] or {}
    if "tool_result" in _blocks_of(last):
        return "tool-result"
    text = _textblocks_of(last)
    for name, rx in TRIGGERS:
        if rx.search(text):
            return name
    if last.get("role") == "system":
        return "system"
    if last.get("role") == "user":
        return "human"
    return "other"

# Strict timestamp shape: a loose split eats the timestamp and invents lanes.
TS = r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z"
REQ_RE = re.compile(
    rf"^req-1-(\d+)-({TS})-(?:(\d+\.\d+\.\d+\.\d+)__(\d+\.\d+\.\d+\.\d+)_(\d+)|(direct))\.json$")
RESP_RE = re.compile(rf"^resp-1-r(\d+)-({TS})-(.+)\.sse$")


def die(msg: str) -> None:
    print(f"[turn-autopsy] ERROR: {msg}", file=sys.stderr)
    sys.exit(2)


# --- corpus listing -------------------------------------------------------

def _is_file_record(cur: dict) -> bool:
    """7z -slt writes `Attributes = A` for a plain file. The archive's own
    header record carries a Path but no Attributes -- excluding it here is what
    keeps the archive itself out of the member list."""
    attrs = cur.get("Attributes", "")
    return bool(cur.get("Path")) and "A" in attrs and "D" not in attrs


def list_archive_members(archive: str) -> list[tuple[str, int]]:
    """Return [(name, size)] for a .7z, reading only the archive index."""
    out = subprocess.run([SEVENZIP, "l", "-slt", archive],
                         capture_output=True, text=True, errors="replace")
    if out.returncode != 0:
        die(f"7z l failed on {archive}: {out.stderr.strip()[:300]}")
    members, cur = [], {}
    for line in out.stdout.splitlines():
        line = line.strip()
        if line == "":
            if _is_file_record(cur):
                members.append((cur["Path"], int(cur.get("Size") or 0)))
            cur = {}
        elif " = " in line:
            k, v = line.split(" = ", 1)
            cur[k] = v
    if _is_file_record(cur):
        members.append((cur["Path"], int(cur.get("Size") or 0)))
    return members


def list_dir_members(path: str) -> list[tuple[str, int]]:
    out = []
    for name in os.listdir(path):
        full = os.path.join(path, name)
        if os.path.isfile(full) and (name.startswith("req-") or name.startswith("resp-")):
            out.append((name, os.path.getsize(full)))
    return out


def index_members(members: list[tuple[str, int]]) -> tuple[dict, dict]:
    """req counter -> [(ts, name)] ; resp counter -> [(ts, name, lane)].

    LISTS, not single values (#424 CR): the capture counter restarts with the
    container (measured on captures-2026-07-05: 10 498 resp files for 7 114
    distinct counters), so a dict assignment silently overwrites homonyms and
    mispairs requests of one uptime window with responses of another."""
    reqs: dict[int, list[tuple[str, str]]] = defaultdict(list)
    resps: dict[int, list[tuple[str, str, str]]] = defaultdict(list)
    for name, _size in members:
        base = os.path.basename(name)
        m = REQ_RE.match(base)
        if m:
            reqs[int(m.group(1))].append((m.group(2), base))
            continue
        m = RESP_RE.match(base)
        if m:
            handler, _, model = m.group(3).partition("-")
            resps[int(m.group(1))].append((m.group(2), base, f"{handler}/{model or '?'}"))
    return reqs, resps


# A resp belongs to the LATEST req of its counter whose ts it follows, within
# this bound. 20 min: generous vs a slow first token, narrow vs the hours that
# separate two uptime windows reusing the same counter.
PAIR_WINDOW_MS = 20 * 60 * 1000


def _ts_ms(ts: str) -> int:
    """Filename timestamp -> epoch ms. Real calendar arithmetic, never digit
    concatenation: `02-59-59-999 -> 03-00-00-000` is 1 ms, not 4e7 units."""
    return int(datetime.strptime(ts, "%Y-%m-%dT%H-%M-%S-%fZ")
               .replace(tzinfo=timezone.utc).timestamp() * 1000)


def pair_all(reqs: dict, resps: dict) -> dict:
    """Pair every req with the resp of its counter whose timestamp is >= its
    own and within PAIR_WINDOW_MS. Returns {(counter, req_ts, req_name):
    (status, resp_entry|None)} with status in paired / unpaired / ambiguous.

    Ownership is decided resp-side (each resp goes to the LATEST req it
    follows within the window), so two windows reusing one counter each keep
    their own response. A req with no in-window resp after it is `unpaired`;
    a req claimed by several resps is `ambiguous` -- both are reported as
    their own status, never silently folded into a wrong pairing."""
    out: dict[tuple[int, str, str], tuple[str, object]] = {}
    for c, rlist in reqs.items():
        rlist = sorted(rlist)
        slist = sorted(resps.get(c) or [])
        claims: dict[int, list[tuple[str, str, str]]] = defaultdict(list)
        for sp in slist:
            t1 = _ts_ms(sp[0])
            owner = -1
            for r_i, rq in enumerate(rlist):
                t0 = _ts_ms(rq[0])
                if t0 > t1:
                    break              # rlist is ts-sorted: past here, no owner
                if t1 - t0 <= PAIR_WINDOW_MS:
                    owner = r_i        # keep the LATEST in-window predecessor
            if owner >= 0:
                claims[owner].append(sp)
        for r_i, rq in enumerate(rlist):
            got = claims.get(r_i) or []
            if len(got) == 1:
                out[(c, *rq)] = ("paired", got[0])
            elif got:
                out[(c, *rq)] = ("ambiguous", got)
            else:
                out[(c, *rq)] = ("unpaired", None)
    return out


def build_candidates(reqs: dict, resps: dict) -> list[dict]:
    """One candidate per REQUEST (not per counter): counter, timestamps,
    pairing status and the paired resp entry when there is one."""
    pairs = pair_all(reqs, resps)
    out = []
    for (c, rq_ts, rq_name), (status, entry) in pairs.items():
        out.append({"counter": c, "req_ts": rq_ts, "req_name": rq_name,
                    "pair": status, "resp": entry})
    out.sort(key=lambda r: (r["req_ts"], r["req_name"]))
    return out


def pick_sample(cands: list[dict], n: int, seed: int,
                stratify_by_lane: bool) -> list[dict]:
    """Seeded sample of turn candidates. Optional proportional stratification
    by the lane read off the paired resp filename (the volume axis #328 is
    about); unpaired and ambiguous candidates pool under their own labels.

    Allocation is bounded by `n`: a lane is never forced to a minimum when more
    lanes exist than slots (that is what turned `--n 50` into 14 244 members)."""
    rng = random.Random(seed)
    if not stratify_by_lane:
        return sorted(rng.sample(cands, min(n, len(cands))),
                      key=lambda r: (r["req_ts"], r["req_name"]))

    by_lane: dict[str, list[dict]] = defaultdict(list)
    for r in cands:
        lane = r["resp"][2] if r["resp"] else f"unknown/{r['pair']}"
        by_lane[lane].append(r)
    total = len(cands)
    lanes = sorted(by_lane.items(), key=lambda kv: -len(kv[1]))

    if len(lanes) >= n:                       # more lanes than slots: one each
        picked = [rng.choice(group) for _lane, group in lanes[:n]]
    else:
        picked = []
        for lane, group in lanes:
            share = max(1, round(n * len(group) / total))
            picked += rng.sample(group, min(share, len(group)))
        if len(picked) > n:                   # the min-1 rule can overshoot
            picked = rng.sample(picked, n)
    return sorted(picked, key=lambda r: (r["req_ts"], r["req_name"]))


def local_copy(archive: str) -> str:
    """Copy the archive to D: once, then extract from there.

    Measured 2026-10-09: a 48.5 MB July archive read straight off G: (DriveFS)
    took >10 min for three `7z e` calls, because every call re-reads the whole
    file across the cloud mount AND the archive is solid (one block, so any
    member costs a full decompression). One local copy pays the cloud read
    once. `--no-copy` restores the old behaviour for a local archive.
    """
    if archive[:2].upper() == "D:":
        return archive
    os.makedirs(SCRATCH_ROOT, exist_ok=True)
    dest = os.path.join(SCRATCH_ROOT, os.path.basename(archive))
    if not os.path.exists(dest) or os.path.getsize(dest) != os.path.getsize(archive):
        print(f"[turn-autopsy] copying {archive} -> {dest} (one cloud read)",
              file=sys.stderr)
        shutil.copy2(archive, dest)
    return dest


def extract(archive: str | None, srcdir: str | None, names: list[str], dest: str) -> None:
    os.makedirs(dest, exist_ok=True)
    if srcdir:
        for nm in names:
            shutil.copy2(os.path.join(srcdir, nm), os.path.join(dest, nm))
        return
    # one 7z call with every member -- a solid archive pays the block once
    # per call, so batching matters (measured: 4 req + 1 resp = 6.2 s).
    for i in range(0, len(names), 40):
        chunk = names[i:i + 40]
        out = subprocess.run([SEVENZIP, "e", archive, f"-o{dest}", "-y", *chunk],
                             capture_output=True, text=True, errors="replace")
        if out.returncode != 0:
            die(f"7z e failed: {out.stderr.strip()[:300]}")


# --- reading slices -------------------------------------------------------

def _blocks_of(msg: dict) -> list[str]:
    content = msg.get("content")
    if isinstance(content, str):
        return ["text"]
    if isinstance(content, list):
        return [b.get("type", "?") for b in content if isinstance(b, dict)]
    return []


def _textblocks_of(msg: dict) -> str:
    """Text blocks ONLY -- what the harness or the user WROTE, never what a
    tool returned. The trigger scan runs on this (#424 CR): a tool_result
    quoting "Command running in background with ID:" is the agent's own
    output, not a background notification."""
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _text_of(msg: dict) -> str:
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    parts.append(b.get("text", ""))
                elif b.get("type") == "tool_result":
                    inner = b.get("content")
                    if isinstance(inner, str):
                        parts.append(inner)
                    elif isinstance(inner, list):
                        parts += [x.get("text", "") for x in inner
                                  if isinstance(x, dict) and x.get("type") == "text"]
        return "\n".join(parts)
    return ""


def _clip(s: str, head: int, tail: int) -> dict:
    s = " ".join(s.split())
    if len(s) <= head + tail:
        return {"head": s, "tail": "", "chars": len(s)}
    return {"head": s[:head], "tail": s[-tail:], "chars": len(s)}


def slice_req(path: str) -> dict:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        raw = fh.read()
    rec = {"body_chars": len(raw)}
    try:
        env = json.loads(raw)
    except Exception as exc:  # a truncated capture is data, not a crash
        rec["parse_error"] = str(exc)[:120]
        return rec
    for k in ("ts", "machine", "model", "pid", "src", "entrypoint", "workload", "device_id8"):
        rec[k] = env.get(k)  # absent in pre-#98 captures -> stays None
    body = env.get("body") or {}
    msgs = body.get("messages") or []
    rec["n_messages"] = len(msgs)
    sysf = body.get("system")
    rec["system_chars"] = len(json.dumps(sysf)) if sysf else 0
    rec["declared_tools"] = len(body.get("tools") or [])

    if msgs:
        last = msgs[-1] or {}
        rec["last_role"] = last.get("role")
        rec["last_block_types"] = _blocks_of(last)
        rec["last_text"] = _clip(_text_of(last), 700, 300)
        rec["trigger"] = classify_trigger(msgs)
    # the session's intent: first user message that is not the harness reminder
    for m in msgs:
        if m.get("role") == "user":
            t = _text_of(m)
            if t and not t.lstrip().startswith("<system-reminder>"):
                rec["first_intent"] = _clip(t, 300, 0)
                break
    return rec


def slice_resp(path: str) -> dict:
    rec = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            txt = fh.read()
    except OSError as exc:
        return {"error": str(exc)[:100]}
    usage = {}
    tools, stop = [], None
    for line in txt.splitlines():
        if not line.startswith("data:"):
            continue
        try:
            ev = json.loads(line[5:].strip())
        except Exception:
            continue
        t = ev.get("type")
        if t == "message_delta":
            usage.update(ev.get("usage") or {})
            stop = (ev.get("delta") or {}).get("stop_reason") or stop
        elif t == "content_block_start":
            blk = ev.get("content_block") or {}
            if blk.get("type") == "tool_use" and blk.get("name"):
                tools.append(blk["name"])
    rec["stop_reason"] = stop
    rec["out"] = usage.get("output_tokens")
    rec["in"] = usage.get("input_tokens")
    rec["cache_read"] = usage.get("cache_read_input_tokens")
    rec["tools"] = tools[:12]
    rec["n_tool_calls"] = len(tools)
    return rec


# --- subcommands ----------------------------------------------------------

def cmd_sample(args) -> int:
    archive, src = None, None
    if args.archive:
        archive = args.archive if args.no_copy else local_copy(args.archive)
        members = list_archive_members(archive)
    elif args.dir:
        members = list_dir_members(args.dir)
        src = args.dir
    else:
        die("sample needs --archive or --dir")

    reqs, resps = index_members(members)
    if not reqs:
        die("no req-* members found")
    cands = build_candidates(reqs, resps)
    picked = pick_sample(cands, args.n, args.seed, args.stratify == "lane")

    lanes_seen = len({e[2] for lst in resps.values() for e in lst})
    pair_counts = Counter(r["pair"] for r in cands)
    print(f"[turn-autopsy] corpus: {sum(len(v) for v in reqs.values())} req / "
          f"{sum(len(v) for v in resps.values())} resp, {lanes_seen} lane(s); "
          f"pairing: {dict(pair_counts)}", file=sys.stderr)
    if args.stratify == "lane" and lanes_seen > len(picked):
        print(f"[turn-autopsy] WARNING: {lanes_seen} lanes > {len(picked)} slots "
              f"-- allocation degraded, check the lane grammar", file=sys.stderr)

    wanted = []
    for cand in picked:
        wanted.append(cand["req_name"])
        if cand["resp"]:
            wanted.append(cand["resp"][1])
    dest = args.workdir or os.path.join(SCRATCH_ROOT, f"{args.era}-{args.seed}")
    have = all(os.path.exists(os.path.join(dest, n)) for n in wanted)
    if have and args.reuse:
        print(f"[turn-autopsy] reuse: {len(wanted)} members already in {dest}",
              file=sys.stderr)
    else:
        print(f"[turn-autopsy] {len(picked)} turns -> extracting "
              f"{len(wanted)} members to {dest}", file=sys.stderr)
        # `archive`, not args.archive: with the local copy in play the
        # extraction must read the D: copy, not re-cross the cloud mount
        extract(archive, src, wanted, dest)

    out_path = args.out
    rows = []
    for cand in picked:
        name = cand["req_name"]
        rec = {"turn_id": os.path.splitext(name)[0],  # full name, no extension
               "req_file": name, "era": args.era, "counter": cand["counter"],
               "pair_status": cand["pair"]}
        m = REQ_RE.match(name)
        if m:
            rec["ip_chain"] = "direct" if m.group(6) else \
                f"{m.group(3)}, {m.group(4)}:{m.group(5)}"
        entry = cand["resp"]
        rec["lane"] = entry[2] if entry else None
        rec["req"] = slice_req(os.path.join(dest, name))
        if entry:
            rec["resp"] = slice_resp(os.path.join(dest, entry[1]))
        rows.append(rec)

    with open(out_path, "w", encoding="utf-8") as fh:
        for rec in rows:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"[turn-autopsy] wrote {len(rows)} turns -> {out_path}", file=sys.stderr)

    # realized stratification -- report it, never assume it
    print("machines :", dict(Counter((r["req"].get("machine") or "(none)") for r in rows).most_common()))
    print("lanes    :", dict(Counter((r.get("lane") or f"({r.get('pair_status')})") for r in rows).most_common(10)))
    print("roles    :", dict(Counter((r["req"].get("last_role") or "?") for r in rows).most_common()))
    return 0


def cmd_stats(args) -> int:
    """Per-era distributions over a work-list. Reports the AUTOMATIC-TRIGGER
    share -- the pilot's headline, because a turn nobody asked for is a turn no
    counter can attribute to intent."""
    rows = [json.loads(l) for l in open(args.worklist, encoding="utf-8") if l.strip()]
    eras = sorted({r["era"] for r in rows})

    def dist(fn):
        return {e: Counter(fn(r) for r in rows if r["era"] == e) for e in eras}

    keys = [t for t, _ in TRIGGERS] + ["tool-result", "human", "system", "other", "empty"]
    def block(title, table, keys_):
        print(f"\n== {title} ==")
        w = max(len(k) for k in keys_) + 2
        print("".ljust(w) + "".join(e.ljust(12) for e in eras))
        for k in keys_:
            counts = [table[e].get(k, 0) for e in eras]
            if not any(counts):
                continue
            print(k.ljust(w) + "".join(str(c).ljust(12) for c in counts))

    trig = dist(lambda r: (r.get("req") or {}).get("trigger") or "?")
    block("trigger (last message)", trig, keys)

    for e in eras:
        n = sum(trig[e].values())
        autos = sum(trig[e].get(t, 0) for t in AUTOMATIC_TRIGGERS)
        pct = f"{100.0 * autos / n:.0f}%" if n else "0%"
        print(f"\n[{e}] n={n}  automatic-trigger = {autos} ({pct})")

    lr = dist(lambda r: (r.get("req") or {}).get("last_role") or "?")
    block("last role", lr, ["user", "system", "assistant", "?"])

    mach = dist(lambda r: (r.get("req") or {}).get("machine") or "(none)")
    block("machine", mach, sorted({k for e in eras for k in mach[e]}))
    lan = dist(lambda r: r.get("lane") or f"({r.get('pair_status') or 'unpaired'})")
    block("lane", lan, sorted({k for e in eras for k in lan[e]}))
    pr = dist(lambda r: r.get("pair_status") or "(legacy)")
    block("pairing", pr, ["paired", "unpaired", "ambiguous", "(legacy)"])
    return 0


def cmd_show(args) -> int:
    """Render a work-list as reading slices -- this IS the pilot's input.

    One block per turn, ~8 lines. Everything the reader needs to decide a
    NATURE, and nothing else: no JSON, no 400 KB body."""
    rows = [json.loads(l) for l in open(args.worklist, encoding="utf-8") if l.strip()]
    for i, r in enumerate(rows):
        req = r.get("req") or {}
        resp = r.get("resp") or {}
        pair = r.get("pair_status") or "unpaired"
        lane_disp = r.get("lane") or f"({pair})"
        print(f"--- [{i+1}/{len(rows)}] {r['turn_id']}  era={r['era']} "
              f"lane={lane_disp}")
        print(f"    machine={req.get('machine') or '(none)'} "
              f"src={req.get('ip_chain')} msgs={req.get('n_messages')} "
              f"sys={req.get('system_chars')} tools_decl={req.get('declared_tools')}")
        if resp:
            print(f"    resp: stop={resp.get('stop_reason')} out={resp.get('out')} "
                  f"cache_read={resp.get('cache_read')} "
                  f"tools={resp.get('tools')}")
        else:
            print(f"    resp: ({pair})")
        fi = req.get("first_intent") or {}
        if fi.get("head"):
            print(f"    intent: {fi['head'][:220]}")
        print(f"    last[{req.get('last_role')}] {req.get('last_block_types')}: "
              f"{(req.get('last_text') or {}).get('head','')[:600]}")
        tail = (req.get("last_text") or {}).get("tail") or ""
        if tail:
            print(f"    ...tail: {tail[:220]}")
        print()
    return 0


def cmd_label(args) -> int:
    rows = [json.loads(l) for l in open(args.worklist, encoding="utf-8") if l.strip()]
    out = args.out
    with open(out, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps({
                "turn_id": r["turn_id"], "era": r["era"],
                "nature": "", "result": "", "confidence": "",
                "note": "",
            }, ensure_ascii=False) + "\n")
    print(f"[turn-autopsy] {len(rows)} blank labels -> {out}", file=sys.stderr)
    print("nature    :", " | ".join(NATURE))
    print("result    :", " | ".join(RESULT))
    print("confidence:", " | ".join(CONFIDENCE))
    return 0


def cmd_aggregate(args) -> int:
    labels = {}
    for line in open(args.labels, encoding="utf-8"):
        if line.strip():
            r = json.loads(line)
            labels[r["turn_id"]] = r
    rows = [json.loads(l) for l in open(args.worklist, encoding="utf-8") if l.strip()]
    eras = sorted({r["era"] for r in rows})
    table: dict[str, Counter] = {e: Counter() for e in eras}
    unlabeled = 0
    for r in rows:
        lab = labels.get(r["turn_id"], {})
        nature = (lab.get("nature") or "").strip() or "(unlabeled)"
        if nature == "(unlabeled)":
            unlabeled += 1
        table[r["era"]][nature] += 1
    keys = NATURE + ["(unlabeled)"]
    width = max(len(k) for k in keys) + 2
    header = "nature".ljust(width) + "".join(e.ljust(12) for e in eras)
    print(header)
    print("-" * len(header))
    for k in keys:
        counts = [table[e].get(k, 0) for e in eras]
        if not any(counts):
            continue
        print(k.ljust(width) + "".join(str(c).ljust(12) for c in counts))
    print()
    print(f"turns: {len(rows)}   labeled: {len(rows) - unlabeled}   unlabeled: {unlabeled}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sample", help="bounded seeded sample -> work-list JSONL")
    s.add_argument("--archive", help="captures-YYYY-MM-DD.7z")
    s.add_argument("--dir", help="loose capture directory")
    s.add_argument("--era", required=True, help="label for this era, e.g. july / now")
    s.add_argument("--n", type=int, default=50)
    s.add_argument("--seed", type=int, default=328)
    s.add_argument("--stratify", choices=["none", "lane"], default="lane")
    s.add_argument("--out", required=True)
    s.add_argument("--workdir", help="extraction dir (default: D:\\claudish-autopsy\\<era>-<seed>)")
    s.add_argument("--no-copy", action="store_true",
                   help="extract straight from the archive (skip the local copy)")
    s.add_argument("--reuse", action="store_true",
                   help="skip extraction when every sampled member is already in --workdir")
    s.set_defaults(func=cmd_sample)

    l = sub.add_parser("label", help="scaffold a labels file from a work-list")
    l.add_argument("--worklist", required=True)
    l.add_argument("--out", required=True)
    l.set_defaults(func=cmd_label)

    sh = sub.add_parser("show", help="render a work-list as reading slices")
    sh.add_argument("--worklist", required=True)
    sh.set_defaults(func=cmd_show)

    st = sub.add_parser("stats", help="per-era distributions (trigger, role, machine, lane)")
    st.add_argument("--worklist", required=True)
    st.set_defaults(func=cmd_stats)

    a = sub.add_parser("aggregate", help="nature x era table")
    a.add_argument("--worklist", required=True)
    a.add_argument("--labels", required=True)
    a.set_defaults(func=cmd_aggregate)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
