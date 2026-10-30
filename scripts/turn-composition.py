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

Usage
-----
  python scripts/turn-composition.py envelope --dir D:\\claudish-captures --label now
  python scripts/turn-composition.py envelope --dir D:\\claudish-autopsy\\july05 --label july
  python scripts/turn-composition.py history  --dir D:\\claudish-captures --label now --limit 400
  python scripts/turn-composition.py nudge    --dir D:\\claudish-captures --label now --limit 400

Reading rules (the traps this tool was built against, all measured 29/10):

  * The process environment of the container is NOT the credential list. A
    custom endpoint's `${VAR}` template resolves against the config home's
    `apiKeys` map; an env-only probe reports "MISSING" for a rung that serves
    traffic fine. Never conclude "not routable" from a container env read.
  * `last_role == "system"` does NOT mean "harness-driven turn" (see `nudge`):
    since Claude Code v2.1.153+ the client appends an output-style reminder as
    an inline system message after the tool_result. Measured 29/10: 83.1 % of
    requests end that way, and 324/332 of them ride a user/tool_result turn.
  * Sampling is a deterministic stride over name-sorted files, so it follows
    time without being biased by file-system order. Every sub-command also
    prints the EXACT population it sampled from, so a ratio can be re-weighted.
  * An era comparison must state its incomparabilities: pre-#98 captures carry
    no `entrypoint` / `workload` / `device_id8`, and part of July carries no
    `session_id`. The tool returns None rather than inventing a value.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import statistics
import sys

TS_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d\d)[-:](\d\d)[-:](\d\d)")
KEYS_RE = re.compile(
    r'"(ts|src|machine|model|pid|instanceId|device_id8|entrypoint|hops)"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}\]]+)'
)
VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


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


def sample_files(directory: str, limit: int):
    names = sorted(n for n in os.listdir(directory) if n.startswith("req-") and n.endswith(".json"))
    stride = max(1, len(names) // limit) if limit else 1
    return names, names[::stride][:limit] if limit else names, stride


def load_body(path: str):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------
# envelope
# --------------------------------------------------------------------------
def head_fields(path: str, head: int = 2048) -> dict:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            blob = fh.read(head)
    except OSError:
        return {}
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
    names, picked, stride = sample_files(args.dir, args.limit)
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
        "requests_total": len(names), "sampled": len(rows), "stride": stride,
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
    names, picked, stride = sample_files(args.dir, args.limit)
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
        "requests_total": len(names), "sampled": n_ok, "stride": stride,
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
            "credential_source": ("apiKeys:" + ",".join(v for v in vars_ if api_keys.get(v))
                                  if any(api_keys.get(v) for v in vars_)
                                  else ("env:" + ",".join(vars_) if vars_ else "literal/none")),
            "status": "OK" if not missing else "MISSING:" + ",".join(missing),
        })
    out = {
        "config": args.config, "container": args.container,
        "apiKeys_map_names": sorted(api_keys),
        "endpoints": rows,
        "note": "a ${VAR} template resolves against the config home's apiKeys map FIRST; "
                "a container-env-only probe reports a false MISSING",
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

    r = sub.add_parser("routability", help="which declared rungs can authenticate on this seat")
    r.add_argument("--config", required=True)
    r.add_argument("--container", default="")
    r.add_argument("--out")
    r.set_defaults(func=cmd_routability)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
