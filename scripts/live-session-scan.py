#!/usr/bin/env python3
r"""live-session-scan.py — who pulls what, right now (#362 fleet session surveillance).

Answers the 2026-10-06 incident question — a STOPPED "adjoint" CoursIA-2 session
kept pulling `gpt-6-sol` on the OpenAI plan (last-chance, non-renewable gift-card
credit) and no instrument saw it continuously. This scanner aggregates the live
`req-*.json` captures per SESSION and flags the two classes that incident made
load-bearing:

  OPENAI-SHAPED  model matches gpt-|codex|-sol|o3-|o4-  — LEAK-grade: every
                 request there burns the last-chance OpenAI credit.
  RETIRED-ID     model matches claude-sonnet-4-6|glm-5.2|qwen3.6-35b-a3b —
                 INFO-grade: ids removed from the catalogs but still named by
                 drifted client configs (the qwen3.6 alias still serves, so
                 this is drift visibility, not a leak).

Two traps about the capture envelope, both measured on D:\claudish-captures
2026-10-06 (400 newest files):

1. `metadata` is serialized at the TAIL, not the head: the last
   `"metadata":{` occurrence sits 368-426 bytes before EOF (p50 411) on the
   353/400 files that carry one — always AFTER every message and tool block,
   so the LAST occurrence in a tail read is the real one and any echo inside
   message prose precedes it. 47/400 (11.8%) carry NO metadata block at all
   (envelope `machine` empty too — SDK/OpenAI-ish bodies); they stay visible
   in a dedicated per-machine bucket instead of vanishing.
2. `metadata.user_id` is a JSON-ENCODED STRING — {"device_id":..,"account_uuid":..,
   "session_id":..} — not the historical `machine:workspace:uuid` shape (same
   finding as live-consumption.py trap 1). Machine attribution therefore comes
   from the ENVELOPE `machine` field (byte ~30, always in the head read), and
   the session uuid from `metadata.session_id` or the session_id embedded in
   the user_id string. The aggregation key stays user_id+session_id as captured,
   whatever shape the client sent.

Anti-echo discipline (repo rule): the DEEP pass is a real JSON parse of the
whole file. The FAST pass never greps the message body — it reads a 6 KiB head
(envelope model/machine + a workdir hint, the only region it touches) and a
16 KiB tail (the metadata block, last occurrence wins). Fast and deep were
verified to produce identical session/model aggregates on a 200-file frozen
sample (see the PR body for the run).

Read-only. Stdlib only. Exit 0 even when LEAK flags are present — this is a
reporting organ, never an actuator; alarming is the caller's job.

Usage:
  python scripts/live-session-scan.py                          # last hour, top 20
  python scripts/live-session-scan.py --hours 6 --top 40
  python scripts/live-session-scan.py --models "gpt-|-sol"     # incident focus
  python scripts/live-session-scan.py --deep --hours 24        # slow: full parse
  python scripts/live-session-scan.py --json                   # machine output
"""
import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime

# --- fast-pass read sizes -------------------------------------------------
# Head: the envelope (ts, src, machine, model, ...) opens the file and the
# first message starts inside these bytes. Tail: covers the metadata block
# with two orders of magnitude of margin over the measured max (426 B).
HEAD_BYTES = 6144
TAIL_BYTES = 16384

# --- structural regexes (escape-aware, applied to head/tail fragments) -----
JSON_STR = r'((?:[^"\\]|\\.)*)'
ENV_MODEL_RE = re.compile(r'"model"\s*:\s*"' + JSON_STR + r'"')   # 1st = envelope
ENV_MACHINE_RE = re.compile(r'"machine"\s*:\s*"' + JSON_STR + r'"')
METADATA_RE = re.compile(r'"metadata"\s*:\s*\{')
USER_ID_RE = re.compile(r'"user_id"\s*:\s*"' + JSON_STR + r'"')
SESSION_ID_RE = re.compile(r'"session_id"\s*:\s*"' + JSON_STR + r'"')
WORKDIR_RE = re.compile(r'[A-Za-z]:\\Dev\\[^"\'\\\n]{1,60}')

# --- flag classes (hardcoded by design: they ARE the product) --------------
OPENAI_RE = re.compile(r'gpt-|codex|-sol|o3-|o4-')
RETIRED_RE = re.compile(r'claude-sonnet-4-6|glm-5\.2|qwen3\.6-35b-a3b')
UNATTRIBUTED = "(no-metadata)"


def model_flags(model):
    if OPENAI_RE.search(model):
        return ["OPENAI-SHAPED"]
    if RETIRED_RE.search(model):
        return ["RETIRED-ID"]
    return []


def json_unescape(raw):
    """`raw` is the escaped body of a JSON string; return the real text."""
    try:
        return json.loads('"' + raw + '"')
    except Exception:
        return raw


def read_head_tail(path):
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        head = fh.read(min(HEAD_BYTES, size))
        if size > HEAD_BYTES:
            fh.seek(max(0, size - TAIL_BYTES))
            tail = fh.read()
        else:
            tail = head
    return (head.decode("utf-8", "replace"),
            tail.decode("utf-8", "replace"))


def parse_fast(path):
    """Head+tail structural extract. Returns (record|None reason string)."""
    try:
        head, tail = read_head_tail(path)
    except OSError as e:
        return "read-error: %s" % e
    if not head.startswith('{"ts"'):
        return "not-an-envelope"
    rec = {}
    m = ENV_MODEL_RE.search(head)
    rec["model"] = json_unescape(m.group(1)) if m else "?"
    m = ENV_MACHINE_RE.search(head)
    rec["machine"] = json_unescape(m.group(1)) if m else ""
    m = WORKDIR_RE.search(head)
    rec["workdir_hint"] = m.group(0) if m else ""
    # metadata: LAST occurrence in the tail is the real one (trap 1).
    last = None
    for last in METADATA_RE.finditer(tail):
        pass
    if last is None:
        rec["user_id"] = None
        rec["session_id"] = None
        return rec
    seg = tail[last.start():]
    rec["user_id"] = None
    rec["session_id"] = None
    mu = USER_ID_RE.search(seg)
    if mu:
        rec["user_id"] = json_unescape(mu.group(1))
    ms = SESSION_ID_RE.search(seg)
    if ms:
        rec["session_id"] = json_unescape(ms.group(1))
    # an anchor that yields neither field was not the body metadata block —
    # both stay None and session_key() falls to the unattributed bucket.
    return rec


def deep_workdir_hint(messages):
    """Workdir hint from the first 2 messages only (deep pass)."""
    texts = []
    for msg in messages[:2]:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    texts.append(block["text"])
    m = WORKDIR_RE.search("\n".join(texts))
    return m.group(0) if m else ""


def parse_deep(path):
    """Full JSON parse — the anti-echo ground truth."""
    try:
        with open(path, "rb") as fh:
            data = fh.read()
        obj = json.loads(data.decode("utf-8", "replace"))
    except (OSError, ValueError) as e:
        return "parse-error: %s" % e
    if not isinstance(obj, dict):
        return "not-an-envelope"
    body = obj.get("body")
    body = body if isinstance(body, dict) else {}
    rec = {
        "model": obj.get("model") or body.get("model") or "?",
        "machine": obj.get("machine") if isinstance(obj.get("machine"), str) else "",
        "workdir_hint": deep_workdir_hint(body.get("messages") or []),
    }
    meta = body.get("metadata")
    meta = meta if isinstance(meta, dict) else {}
    rec["user_id"] = meta.get("user_id") if isinstance(meta.get("user_id"), str) else None
    rec["session_id"] = meta.get("session_id") if isinstance(meta.get("session_id"), str) else None
    return rec


def session_key(rec):
    """user_id + session_id as captured; falls back to the unattributed bucket
    keyed by envelope machine so no-metadata traffic stays countable."""
    if rec["user_id"] is None and rec["session_id"] is None:
        return (UNATTRIBUTED, rec["machine"] or "?")
    return (rec["user_id"] or "", rec["session_id"] or "")


def short_session(rec):
    """Short display id: the uuid embedded in user_id when metadata.session_id
    is absent (the measured hub shape keeps it inside the user_id JSON)."""
    sid = rec["session_id"]
    if not sid and rec["user_id"]:
        m = re.search(r'"session_id"\s*:\s*"([0-9a-f-]{8,36})"', rec["user_id"])
        if m:
            sid = m.group(1)
    if sid:
        return sid[:8]
    if rec["user_id"]:
        return rec["user_id"][:12]
    return UNATTRIBUTED


def full_session_id(rec):
    sid = rec["session_id"]
    if not sid and rec["user_id"]:
        m = re.search(r'"session_id"\s*:\s*"([0-9a-f-]{8,36})"', rec["user_id"])
        if m:
            sid = m.group(1)
    return sid or ""


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Per-session live attribution over req-*.json captures (#362).")
    ap.add_argument("--hours", type=float, default=1.0,
                    help="window in hours from now, by file mtime (default 1)")
    ap.add_argument("--top", type=int, default=20,
                    help="sessions to display (default 20)")
    ap.add_argument("--models", default=None,
                    help="regex filter on model id; only matching requests enter "
                         "the aggregation (default all)")
    ap.add_argument("--json", action="store_true",
                    help="machine-readable JSON on stdout")
    ap.add_argument("--deep", action="store_true",
                    help="full JSON parse of every file (slow: multi-MB files); "
                         "default is the verified head+tail fast pass")
    ap.add_argument("--captures", default=r"D:\claudish-captures",
                    help="captures directory (default D:\\claudish-captures)")
    args = ap.parse_args(argv)

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if not os.path.isdir(args.captures):
        print("captures dir not found: %s" % args.captures, file=sys.stderr)
        return 2
    model_filter = None
    if args.models:
        try:
            model_filter = re.compile(args.models, re.IGNORECASE)
        except re.error as e:
            print("bad --models regex: %s" % e, file=sys.stderr)
            return 2

    parse = parse_deep if args.deep else parse_fast
    now = datetime.now().timestamp()
    cutoff = now - args.hours * 3600.0

    files_seen = scanned = 0
    unparsable = []
    no_metadata = 0
    model_totals = Counter()
    sessions = {}  # key -> record

    try:
        it = os.scandir(args.captures)
    except OSError as e:
        print("cannot scan %s: %s" % (args.captures, e), file=sys.stderr)
        return 2
    with it:
        for entry in it:
            name = entry.name
            if not (name.startswith("req-") and name.endswith(".json")):
                continue
            files_seen += 1
            try:
                mtime = entry.stat(follow_symlinks=False).st_mtime
            except OSError:
                continue
            if mtime < cutoff:
                continue
            scanned += 1
            rec = parse(entry.path)
            if isinstance(rec, str):
                unparsable.append((name, rec))
                continue
            model = rec["model"]
            if model_filter is not None and not model_filter.search(model):
                continue
            model_totals[model] += 1
            if rec["user_id"] is None and rec["session_id"] is None:
                no_metadata += 1
            key = session_key(rec)
            agg = sessions.get(key)
            if agg is None:
                agg = {
                    "key": key, "machine": rec["machine"], "session_id": "",
                    "user_id": rec["user_id"] or "",
                    "requests": 0, "first": mtime, "last": mtime,
                    "models": Counter(), "flags": set(),
                    "workdir_hint": rec["workdir_hint"],
                }
                sessions[key] = agg
            agg["requests"] += 1
            agg["first"] = min(agg["first"], mtime)
            agg["last"] = max(agg["last"], mtime)
            agg["models"][model] += 1
            agg["flags"].update(model_flags(model))
            if not agg["session_id"]:
                agg["session_id"] = full_session_id(rec)
            if not agg["workdir_hint"] and rec["workdir_hint"]:
                agg["workdir_hint"] = rec["workdir_hint"]

    rows = list(sessions.values())
    for r in rows:
        r["flags"] = sorted(r["flags"])
    # LEAK-grade sessions float to the top of the report, then request count.
    rows.sort(key=lambda r: ("OPENAI-SHAPED" not in r["flags"], -r["requests"]))

    leak_rows = [r for r in rows if "OPENAI-SHAPED" in r["flags"]]
    retired_rows = [r for r in rows if "RETIRED-ID" in r["flags"]]
    leak_reqs = sum(r["requests"] for r in leak_rows)
    retired_reqs = sum(r["requests"] for r in retired_rows)

    def iso(ts):
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")

    out = {
        "window_hours": args.hours,
        "captures_dir": args.captures,
        "mode": "deep" if args.deep else "fast",
        "files_seen": files_seen,
        "files_in_window": scanned,
        "unparsable": {"count": len(unparsable),
                       "files": [{"file": n, "reason": r} for n, r in unparsable]},
        "no_metadata_requests": no_metadata,
        "model_totals": {m: {"requests": c, "flags": model_flags(m)}
                         for m, c in model_totals.most_common()},
        "sessions": [{
            "machine": r["machine"] or "?",
            "user_id": r["user_id"],
            "session_id": r["session_id"],
            "requests": r["requests"],
            "first": iso(r["first"]),
            "last": iso(r["last"]),
            "models": dict(r["models"].most_common()),
            "flags": r["flags"],
            "workdir_hint": r["workdir_hint"],
        } for r in rows],
        "digest": {
            "openai_shaped": {"sessions": len(leak_rows), "requests": leak_reqs},
            "retired_id": {"sessions": len(retired_rows), "requests": retired_reqs},
        },
    }

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0

    mode = "DEEP (full JSON parse)" if args.deep else "FAST (head %d + tail %d)" % (
        HEAD_BYTES, TAIL_BYTES)
    print("live-session-scan  window=%.2fh  mode=%s  dir=%s" % (
        args.hours, mode, args.captures))
    print("files: %d in window / %d total   unparsable: %d   no-metadata reqs: %d   sessions: %d" % (
        scanned, files_seen, len(unparsable), no_metadata, len(rows)))
    if unparsable:
        for n, r in unparsable[:5]:
            print("  unparsable: %s  (%s)" % (n, r))
        if len(unparsable) > 5:
            print("  ... and %d more" % (len(unparsable) - 5))
    print()
    print("DIGEST  OPENAI-SHAPED: %d reqs / %d sessions   RETIRED-ID: %d reqs / %d sessions" % (
        leak_reqs, len(leak_rows), retired_reqs, len(retired_rows)))
    print()
    print("MODELS (in-window requests)")
    for m, c in model_totals.most_common():
        fl = model_flags(m)
        print("  %6d  %-45s %s" % (c, m, " ".join(fl)))
    print()
    print("SESSIONS (top %d, OPENAI-SHAPED first)" % args.top)
    hdr = "  %-13s %5s  %-14s %-14s %-12s %-9s %-24s %s"
    print(hdr % ("FLAGS", "N", "FIRST", "LAST", "MACHINE", "SESSION", "WORKDIR", "MODELS"))
    for r in rows[:args.top]:
        models = ", ".join("%s x%d" % (m, c) for m, c in
                           sorted(r["models"].items(), key=lambda kv: -kv[1])[:3])
        print(hdr % ("|".join(r["flags"]) or "-", r["requests"],
                     datetime.fromtimestamp(r["first"]).strftime("%m-%d %H:%M:%S"),
                     datetime.fromtimestamp(r["last"]).strftime("%m-%d %H:%M:%S"),
                     r["machine"] or "?",
                     (r["session_id"][:8] if r["session_id"]
                      else (r["user_id"][:8] or UNATTRIBUTED)),
                     r["workdir_hint"][:24] or "-",
                     models[:60]))
    if len(rows) > args.top:
        print("  ... and %d more sessions" % (len(rows) - args.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())
