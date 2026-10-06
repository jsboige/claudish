#!/usr/bin/env python3
r"""Read-only verification of the X-Claudish-Machine rollout (issue #1).

The header is wired end-to-end server-side (request-logger.ts reads it, the
relay preserves it across the hop — measured 2026-09-17, issue #1 comments),
so the only failure mode left is a CLIENT that stopped sending it. Nothing
measured that: this script does, with three controls plus a residual
attribution, all read-only:

  1. LOCAL SETTINGS  — does THIS machine's ~/.claude/settings.json carry
     `ANTHROPIC_CUSTOM_HEADERS: "X-Claudish-Machine: <name>"` in its env
     block? (The string may hold other headers separated by literal newlines;
     a real shell env var would override settings.json — we check and warn.)
  2. CORPUS          — over the newest req-*.json captures, what share of
     request envelopes carry a `machine` field, and how is it distributed?
  3. ROSTER          — every machine name seen must be a canonical roster
     name. `po-203` is a prose nickname, never a machine-keyed value — a
     nickname in the corpus silently forks the attribution (memory
     machine-naming-po2023-canonical, GDrive seed incident 25/09).
  4. RESIDUAL        — the no-machine requests, aggregated by lane
     (src, model, entrypoint, workload). claudish's OWN liveness probes
     (watchdog Test-ProxyWithTools, relay deepProbe) are separated out FIRST,
     by SHAPE rather than by the header: since #345 they DO carry
     X-Claudish-Machine, and they are still not a client lane. The first
     draft of this report counted them as "non-CC scripted clients", which
     was wrong (PR #336 review, 2026-10-05): what is left AFTER them is the
     real client gap, named, not guessed. Records keep the ENVELOPE only —
     the body is read once for probe classification, then dropped (memory).

Caveat printed, not hidden: on a RELAY (po-203 today), captures are written
only for locally-served requests — a NOMINAL forward writes nothing — so the
corpus covers the local slice, not the fleet. The observed time span is
always reported; never assume the window (docker-logs-moving-window lesson).

Exit codes: 0 = clean among CLIENT records · 1 = findings (local header
missing/wrong, unknown machine names) · 2 = nothing to verify (empty/missing
corpus, or a corpus holding ONLY claudish's own probes — 0 client record
proves nothing about the rollout either way). The script never throws: every
failure degrades to a reported reason.

Run:  python scripts/verify-machine-header.py [--corpus DIR] [--limit N]
                                             [--machine NAME] [--settings FILE]
                                             [--json]
"""

import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timezone

# Canonical fleet roster (cluster-reference). A capture machine value outside
# this list is a finding, not a curiosity: attribution joins on exact names.
ROSTER = [
    "myia-ai-01",
    "myia-po-2023",
    "myia-po-2024",
    "myia-po-2025",
    "myia-po-2026",
    "myia-po-2027",
    "myia-web1",
    "myia-web2",
]

REQ_GLOB = "req-*.json"

# The fixed user message our own liveness probes send — identical TEXT in both
# sources: watchdog Test-ProxyWithTools (claudish-watchdog.ps1:92-123, model
# glm-5.2) and relay deepProbe (relay.ts:819-844, model glm-5.3). The model
# differs between the two, so the message text is the stable discriminator.
# Since #345 these probes DO carry X-Claudish-Machine; they are still separated
# by SHAPE because a probe is not a client — counting one as a client rollout
# gap manufactured the false "non-CC scripted clients" claim.
PROBE_USER_TEXT = "List the current directory using Bash. Do it now."


def classify_probe(body):
    """True when this body is one of claudish's own liveness probes.

    Anchored on the probe SHAPE, not the text alone: exactly one user message,
    no system, tools exactly [Bash, Read], max_tokens 100 — and that message
    is the exact probe text (string or content-block list, the CC wire shape).
    Text alone is not enough: a real header-less session whose HISTORY quotes
    the phrase would pass for a probe and silently leave the residual
    (measured by review, 2026-10-05). Never raises on odd shapes.
    """
    if not isinstance(body, dict):
        return False
    if body.get("system") not in (None, "", [], {}):
        return False
    if body.get("max_tokens") != 100:
        return False
    tools = body.get("tools")
    if not isinstance(tools, list):
        return False
    names = sorted(
        t.get("name") for t in tools if isinstance(t, dict) and t.get("name"))
    if names != ["Bash", "Read"]:
        return False
    msgs = body.get("messages")
    if not isinstance(msgs, list) or len(msgs) != 1:
        return False
    m = msgs[0]
    if not isinstance(m, dict) or m.get("role") != "user":
        return False
    c = m.get("content")
    texts = [c] if isinstance(c, str) else [
        b.get("text") for b in c if isinstance(b, dict)
    ] if isinstance(c, list) else []
    return any(isinstance(t, str) and t.strip() == PROBE_USER_TEXT for t in texts)


# ---------------------------------------------------------------------------
# control 1 — local settings
# ---------------------------------------------------------------------------

def detect_local_machine(explicit=None):
    """Best-effort machine id: explicit flag, else myia-<COMPUTERNAME>."""
    if explicit:
        return explicit
    name = os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or ""
    name = name.strip().lower()
    if not name:
        return None
    if name.startswith("myia-"):
        return name
    return "myia-" + name


def read_settings_machine(settings_path, want_machine):
    """(ok, detail) — is X-Claudish-Machine: <want_machine> in settings env?

    Never raises: unreadable file / bad JSON / missing env block all return
    (False, reason). Multi-header strings separated by literal newlines are
    accepted (issue #1 append form).
    """
    if not os.path.isfile(settings_path):
        return False, "settings file not found: %s" % settings_path
    try:
        with open(settings_path, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as e:
        return False, "settings unreadable: %s" % e
    if not isinstance(data, dict):
        return False, "settings root is not an object"
    env = data.get("env")
    if not isinstance(env, dict):
        return False, "no env block in settings"
    raw = env.get("ANTHROPIC_CUSTOM_HEADERS")
    if not isinstance(raw, str) or not raw.strip():
        return False, "env.ANTHROPIC_CUSTOM_HEADERS absent/empty"
    for line in re.split(r"\r?\n", raw):
        m = re.match(r"\s*([^:]+?)\s*:\s*(.*?)\s*$", line)
        if not m:
            continue
        if m.group(1).lower() == "x-claudish-machine":
            value = m.group(2)
            if value == want_machine:
                return True, "X-Claudish-Machine: %s present" % value
            return False, "header present but names %r (want %r)" % (value, want_machine)
    return False, "X-Claudish-Machine not among ANTHROPIC_CUSTOM_HEADERS lines"


def shell_env_override_note():
    """The shell env var, when present (issue #1 caveat).

    A run launched from Claude Code inherits a copy of the SAME value the
    settings hold — that is not an override, it is a mirror; only a shell
    value that LACKS the header actually masks settings.json.
    """
    v = os.environ.get("ANTHROPIC_CUSTOM_HEADERS")
    if v is None:
        return None
    has = re.search(r"x-claudish-machine\s*:\s*([\w-]+)", v, re.I)
    if has:
        return ("shell env ANTHROPIC_CUSTOM_HEADERS also sets X-Claudish-Machine: %s "
                "(inherited copy of the settings value, same effect — not an override)" % has.group(1))
    return "WARN: shell env ANTHROPIC_CUSTOM_HEADERS is set WITHOUT X-Claudish-Machine — it masks the settings.json value"


# ---------------------------------------------------------------------------
# controls 2+3+4 — capture corpus
# ---------------------------------------------------------------------------

def scan_corpus(corpus_dir, limit):
    """Newest `limit` req-*.json envelopes as dicts (never raises per-file).

    Returns (records, unreadable, span) where span is (first_ts, last_ts) of
    the records that carry one. Unparsable files are counted, not fatal — a
    truncated capture is a known shape (a request killed mid-write).
    """
    if not os.path.isdir(corpus_dir):
        return [], 0, None
    files = glob.glob(os.path.join(corpus_dir, REQ_GLOB))

    def _safe_mtime(p):  # a file can vanish between glob and sort — never raise
        try:
            return os.path.getmtime(p)
        except OSError:
            return 0.0

    files.sort(key=_safe_mtime, reverse=True)
    files = files[: max(1, limit)]
    records, unreadable, stamps = [], 0, []
    for path in files:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                rec = json.load(fh)
            if not isinstance(rec, dict):
                unreadable += 1
                continue
            # The body is read exactly once (probe classification), then
            # dropped: records are envelopes — a retained body is a memory
            # bomb at --limit 2000 (PR #336 review blocker).
            if classify_probe(rec.get("body")):
                rec["probe"] = True
            rec.pop("body", None)
            records.append(rec)
            ts = rec.get("ts")
            if isinstance(ts, str) and ts:
                stamps.append(ts)
        except (OSError, ValueError):
            unreadable += 1
    span = (min(stamps), max(stamps)) if stamps else None
    return records, unreadable, span


def machine_distribution(records):
    """{machine: count} over records; '' = no machine field (absent/empty/null)."""
    dist = {}
    for rec in records:
        m = rec.get("machine")
        m = m.strip() if isinstance(m, str) and m.strip() else ""
        dist[m] = dist.get(m, 0) + 1
    return dist


def residual_attribution(records):
    """No-machine records aggregated by lane (src, model, entrypoint, workload)."""
    groups = {}
    for rec in records:
        if rec.get("probe"):
            continue  # ours — a probe is not a client lane, whatever header it carries (#345)
        m = rec.get("machine")
        if isinstance(m, str) and m.strip():
            continue
        key = (
            str(rec.get("src") or "?"),
            str(rec.get("model") or "?"),
            str(rec.get("entrypoint") or "-"),
            str(rec.get("workload") or "-"),
        )
        g = groups.setdefault(key, {"count": 0, "first": None, "last": None, "devices": set()})
        g["count"] += 1
        ts = rec.get("ts")
        if isinstance(ts, str) and ts:
            if g["first"] is None or ts < g["first"]:
                g["first"] = ts
            if g["last"] is None or ts > g["last"]:
                g["last"] = ts
        d = rec.get("device_id8")
        if isinstance(d, str) and d:
            g["devices"].add(d)
    for g in groups.values():
        g["devices"] = sorted(g["devices"])
    return groups


def client_stats(records):
    """(client_total, client_with_machine, probes) over client records.

    CLIENTS and probes are disjoint populations; every coverage ratio built
    from these three uses the SAME population on both sides — a probe that
    carries the header (issue #345 will make that the norm) must never
    inflate the client numerator above its denominator.
    """
    probes = sum(1 for r in records if r.get("probe"))
    client_total = 0
    client_with = 0
    for r in records:
        if r.get("probe"):
            continue
        client_total += 1
        m = r.get("machine")
        if isinstance(m, str) and m.strip():
            client_with += 1
    return client_total, client_with, probes


def richness(records):
    """device_id8 / entrypoint coverage, per side (attributed vs residual).

    The header rollout is verified by `machine`; these two say whether the
    RICHER attribution fields travelled with it (demand 2(a), PR #336 review).
    """
    out = {"attr": [0, 0, 0, 0], "resid": [0, 0, 0, 0]}  # [total, device_id8, entrypoint, both]
    for r in records:
        if r.get("probe"):
            continue
        m = r.get("machine")
        side = "attr" if (isinstance(m, str) and m.strip()) else "resid"
        s = out[side]
        s[0] += 1
        d = isinstance(r.get("device_id8"), str) and bool(r["device_id8"])
        e = isinstance(r.get("entrypoint"), str) and bool(r["entrypoint"])
        if d:
            s[1] += 1
        if e:
            s[2] += 1
        if d and e:
            s[3] += 1
    return out


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------

def human_report(machine, settings, override_note, records, unreadable, span,
                 dist, unknown, residual):
    lines = []
    add = lines.append
    add("=== X-Claudish-Machine rollout verification (issue #1) ===")
    add("")
    add("-- Control 1: local settings --")
    if machine is None:
        add("  machine id: NOT RESOLVED (pass --machine) — control skipped")
    else:
        ok, detail = settings
        add("  machine id: %s" % machine)
        add("  %s [%s] %s" % ("OK " if ok else "FAIL", detail, "" if ok else "(issue #1: merge into env block, takes effect next session)"))
    if override_note:
        add("  %s" % override_note)
    add("")
    add("-- Control 2: capture corpus --")
    if not records and not unreadable:
        add("  no %s files in corpus — cannot verify (on a relay this is normal" % REQ_GLOB)
        add("  when nothing was served locally; a NOMINAL forward writes no capture)")
    else:
        total = len(records)
        client_total, client_with, probes = client_stats(records)
        with_m = sum(c for k, c in dist.items() if k)
        pct = (100.0 * with_m / total) if total else 0.0
        add("  scanned %d req envelopes (%d unreadable)" % (total, unreadable))
        if span:
            add("  observed span: %s -> %s (report covers THIS span, not an assumed window)" % span)
        add("  attribution coverage (raw, all records): %d/%d = %.1f%%" % (with_m, total, pct))
        if probes:
            add("  of which %d are claudish's own liveness probes (Test-ProxyWithTools / deepProbe)" % probes)
        if client_total:
            # numerator and denominator on the SAME population: client records
            # only — a header-carrying probe (issue #345) can never inflate it
            cpct = 100.0 * client_with / client_total
            add("  CLIENT attribution coverage: %d/%d = %.1f%%" % (client_with, client_total, cpct))
        else:
            add("  0 CLIENT record in corpus — only probes here, nothing to verify (exit 2)")
        add("  NOTE: on a relay, captures cover only locally-served requests, not the fleet")
        rich = richness(records)
        for side, label in (("attr", "attributed"), ("resid", "residual")):
            t, d, e, b = rich[side]
            if t:
                add("  %-9s richness: device_id8 %d/%d · entrypoint %d/%d · both %d/%d"
                    % (label, d, t, e, t, b, t))
        add("  distribution:")
        for k in sorted(dist, key=lambda x: -dist[x]):
            label = k if k else "(no machine header)"
            add("    %-18s %5d" % (label, dist[k]))
    add("")
    add("-- Control 3: roster consistency --")
    if not records:
        add("  skipped (no corpus)")
    elif unknown:
        add("  UNKNOWN machine names (not in roster) — these fork attribution:")
        for u in unknown:
            add("    %-18s %5d reqs" % (u, dist[u]))
    else:
        seen = [k for k in dist if k]
        absent = [r for r in ROSTER if r not in seen]
        add("  all %d seen names are canonical" % len(seen))
        add("  roster names not seen this corpus: %s" % (", ".join(absent) or "(none)"))
        add("  (absent is normal for an idle machine or one served while the header was off)")
    add("")
    add("-- Residual: no-machine requests by lane --")
    probes = sum(1 for r in records if r.get("probe"))
    client_total = sum(1 for r in records if not r.get("probe"))
    if probes:
        add("  %d reqs from claudish's own probes (watchdog Test-ProxyWithTools / relay deepProbe)" % probes)
        add("  — separated out by SHAPE (they carry the header since #345); not a rollout gap")
    if not records:
        add("  (no corpus)")
    elif client_total == 0:
        add("  0 CLIENT request in this corpus — nothing to verify (exit 2), no rollout verdict")
    elif not residual:
        add("  none — every CLIENT request carried the header")
    else:
        rows = sorted(residual.items(), key=lambda kv: -kv[1]["count"])
        for (src, model, entrypoint, workload), g in rows[:10]:
            add("  %4d reqs  src=%s model=%s entrypoint=%s workload=%s" % (g["count"], src, model, entrypoint, workload))
            add("           span %s -> %s devices=%s" % (g["first"] or "?", g["last"] or "?", ",".join(g["devices"]) or "-"))
        if len(rows) > 10:
            add("  … and %d more lane groups" % (len(rows) - 10))
    add("")
    return "\n".join(lines)


def json_report(machine, settings, override_note, records, unreadable, span,
                dist, unknown, residual):
    client_total, client_with, probes = client_stats(records)
    rich = richness(records)
    return json.dumps({
        "machine": machine,
        "settings_ok": settings[0] if settings else None,
        "settings_detail": settings[1] if settings else "skipped",
        "shell_override": override_note,
        "scanned": len(records),
        "probes_excluded": probes,
        "client_total": client_total,
        "client_with_machine": client_with,
        "client_coverage": round(100.0 * client_with / client_total, 2) if client_total else None,
        "richness": rich,
        "unreadable": unreadable,
        "span": list(span) if span else None,
        "distribution": dist,
        "unknown_names": unknown,
        "residual": [
            {"src": k[0], "model": k[1], "entrypoint": k[2], "workload": k[3], **v}
            for k, v in sorted(residual.items(), key=lambda kv: -kv[1]["count"])
        ],
    }, indent=2, default=list)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--corpus", default=r"D:\claudish-captures", help="capture dir (req-*.json)")
    ap.add_argument("--limit", type=int, default=2000, help="newest N captures to scan")
    ap.add_argument("--machine", default=None, help="this machine's canonical id (default: auto-detect)")
    ap.add_argument("--settings", default=None, help="settings.json path (default: ~/.claude/settings.json)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)

    machine = detect_local_machine(args.machine)
    settings_path = args.settings or os.path.join(
        os.path.expanduser("~"), ".claude", "settings.json")
    settings = read_settings_machine(settings_path, machine) if machine else None
    override_note = shell_env_override_note()

    records, unreadable, span = scan_corpus(args.corpus, args.limit)
    dist = machine_distribution(records)
    unknown = sorted(k for k in dist if k and k not in ROSTER)
    residual = residual_attribution(records)

    if args.json:
        print(json_report(machine, settings, override_note, records, unreadable,
                          span, dist, unknown, residual))
    else:
        print(human_report(machine, settings, override_note, records, unreadable,
                           span, dist, unknown, residual))

    findings = []
    if settings is not None and not settings[0]:
        findings.append("local-settings")
    if unknown:
        findings.append("unknown-machine-names")
    if findings:
        return 1
    # "nothing to verify" includes the all-probe corpus: probes are ours and
    # header-less by design — 0 CLIENT record proves nothing about the rollout
    # either way, and must not read as "complete" (review blocker 2).
    client_total, _, _ = client_stats(records)
    if client_total == 0:
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # never throw: degrade to a reported reason
        print("VERIFY-ABORTED: %s" % e, file=sys.stderr)
        sys.exit(2)
