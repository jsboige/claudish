#!/usr/bin/env python3
"""Qwen Token Plan monthly-credit guard (operational, a-la-louche by design).

Context (2026-09-24): Qwen's subscription switched from a WEEKLY renewable
quota to a MONTHLY one. The fleet's habit — max the weekly credit, then PAYG —
would now burn the whole month in ~1 week. This guard self-imposes a weekly
cap so the credit lasts 4 weeks.

Method (user-calibrated, two points — no month-start archaeology needed):
  1. `baseline --percent P0` — snapshot the token counter when the user reads
     P0% REMAINING on the Qwen console (P0=71.4 on 2026-09-24).
  2. `report --percent P1`   — when the user reads P1 (=47%), the tokens
     burned between the two readings become the WEEKLY CAP. Since
     71.4 - 47 = 24.4 pts ~= 100/4, one week of current burn rate IS an
     even 4-week spread — the method lands within a few % of Total/4.
  3. `status` (enforcing) — rolling 7-day burn vs cap; EXCEEDED names the
     deroute lever: REMOVE the qwen steps from the cascade lines (realigning
     the positional _LABEL/_DIRECTION/_NOTE/_RESET fields) + drained restart
     — an operator gesture, never automatic here. NOT `..._RESET`: measured
     2026-09-25, a reset date only extends the backoff of a step that has
     already walled, never skips a healthy one (865 qwen responses served
     after a RESET-only recreate — #261).

Meter corpus (include-list, from config.json routing + cascade steps):
  deepseek-v4.1-flash   — cascade step via qwen-token-plan. The DOTTED id is
    the pure meter signal: cascade-served requests capture with the @-target
    verbatim (5767 files on 2026-09-23), while the UNdotted deepseek-v4-flash
    is the bare-name FallbackHandler chain (DeepSeek PAYG first — 3393 files
    same day, 0 [Fallback] walks in 26h, population = drain probes). One
    dotted resp file = one actual subscription call.
  qwen3.8-max, qwen3.8-flash — explicit agent routing (user rule 2026-09-24:
    latest version only). 3.8-flash added ahead of its routing entry.
  qwen3.6-flash, qwen3.7-plus, qwen3.7-max — STALE routing entries that still
    bill the meter if requested; remove from here when removed from routing.
EXCLUDED on purpose: deepseek-v4-flash (undotted — bare chain, DeepSeek-first
PAYG), qwen3.6-35b-a3b (routed to vllm-myia, LOCAL lane), and the Kimi
  lanes (captured as k3 / kimi-for-coding — a DIFFERENT subscription, and one
  that sits BEFORE Qwen in every cascade: its 5h wall alternates traffic away
  from Qwen, so counting k3 files would overstate the Qwen burn — user rule
  2026-09-24).

Units: output_tokens primary (docs say the Token Plan bills on OUTPUT) — but
the billing unit is UNCONFIRMED against the console, so input is tracked in
full: input_tokens (uncached), cache_read_input_tokens,
cache_creation_input_tokens. The 47% calibration reports all of them;
whichever correlates with the console's own math wins.

Usage:
  python qwen_monthly_guard.py baseline --percent 71.4
  python qwen_monthly_guard.py tick
  python qwen_monthly_guard.py report --percent 47
  python qwen_monthly_guard.py status
"""

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile

DEFAULT_STATE = os.path.join(os.path.expanduser("~"), ".claudish", "qwen-monthly-guard.json")
DEFAULT_CAPTURES = r"D:\claudish-captures"
DEFAULT_ARCHIVES = r"G:\Mon Drive\Backups-Cloud\claudish"
DEFAULT_7Z = r"D:\PortableApps\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe"

# Kimi steps (kc@k3, kc@kimi-for-coding) are deliberately absent — different
# subscription, and their wall diverts traffic away from Qwen (user 24/09).
METER_MODELS = {
    "deepseek-v4.1-flash",
    "qwen3.6-flash",
    "qwen3.7-plus",
    "qwen3.7-max",
    "qwen3.8-max",
    "qwen3.8-flash",
}

# resp-1-r0731-2026-09-24T04-56-52-709Z-openai-deepseek-v4-flash.sse
RESP_RE = re.compile(
    r"^resp-\d+-r\d+-(\d{4}-\d{2}-\d{2})T[\d-]+Z-\w+-(.+)\.sse$"
)
OUT_RE = re.compile(r'"output_tokens":(\d+)')
IN_RE = re.compile(r'"input_tokens":(\d+)')
CACHE_READ_RE = re.compile(r'"cache_read_input_tokens":(\d+)')
CACHE_CREATE_RE = re.compile(r'"cache_creation_input_tokens":(\d+)')


def utc_today() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def parse_sse_usage(path: str):
    """MAX per field per file — wire-openai emits a zero block first
    (same lesson as compaction-trend.py: never sum, take the max). The three
    input fields are DISJOINT components post-split (input + cache_read +
    cache_creation = the upstream prompt_tokens)."""
    out_max = 0
    in_max = 0
    cr_max = 0
    cc_max = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            body = f.read()
        for m in OUT_RE.finditer(body):
            out_max = max(out_max, int(m.group(1)))
        for m in IN_RE.finditer(body):
            in_max = max(in_max, int(m.group(1)))
        for m in CACHE_READ_RE.finditer(body):
            cr_max = max(cr_max, int(m.group(1)))
        for m in CACHE_CREATE_RE.finditer(body):
            cc_max = max(cc_max, int(m.group(1)))
    except OSError:
        return None
    return out_max, in_max, cr_max, cc_max


def scan_dir_for_day(captures_dir: str, day: str):
    """Sum usage over the loose-capture dir for one UTC day. Returns
    (n, out, in, cache_read, cache_creation) — recomputed fresh each call
    since the loose day only grows (files for a past day can still appear
    pre-purge)."""
    n = 0
    sums = [0, 0, 0, 0]
    try:
        names = os.listdir(captures_dir)
    except OSError:
        # Five fields, like every return of this contract: the caller unpacks
        # five, and a short tuple raises ValueError there. Treating an
        # unlistable dir as "no loose data" is intended — the caller then
        # falls back to the archive for that day.
        return 0, 0, 0, 0, 0
    for name in names:
        m = RESP_RE.match(name)
        if not m or m.group(1) != day or m.group(2) not in METER_MODELS:
            continue
        got = parse_sse_usage(os.path.join(captures_dir, name))
        if got:
            n += 1
            for i in range(4):
                sums[i] += got[i]
    return (n,) + tuple(sums)


def archive_path(archives_dir: str, day: str) -> str:
    return os.path.join(archives_dir, f"captures-{day}.7z")


def scan_archive_for_day(seven_zip: str, archives_dir: str, day: str):
    """One-pass 7z extraction of the meter models only (per-file `-e -so` on a
    Google-Drive mount re-scans the whole archive each call — measured
    2026-09-24, timeout-class slow). Multiple -ir! masks are an OR.
    Returns (n, out, in, cache_read, cache_creation) when the archive WAS read
    — possibly all zeros, which is a real measurement — or None when it could
    not be read at all: absent, 7z error, timeout, missing binary. An unread
    archive is not a zero: the caller must never cache it as one."""
    arc = archive_path(archives_dir, day)
    if not os.path.exists(arc):
        # The caller only asks when it believes an archive exists, so a miss
        # here means the mount (or a purge) moved under it. Same contract as an
        # extraction failure: unmeasurable, hence None — never a zero, which
        # the caller would cache permanently.
        return None
    masks = []
    for model in sorted(METER_MODELS):
        masks += ["-ir!*-" + model + ".sse"]
    with tempfile.TemporaryDirectory(prefix="qwen-guard-") as tmp:
        cmd = [seven_zip, "e", "-y", f"-o{tmp}", arc] + masks
        try:
            subprocess.run(
                cmd, capture_output=True, timeout=600, check=True
            )
        except (subprocess.SubprocessError, OSError) as e:
            print(f"WARN: 7z extraction failed for {day}: {e}", file=sys.stderr)
            return None
        n = 0
        sums = [0, 0, 0, 0]
        for name in os.listdir(tmp):
            got = parse_sse_usage(os.path.join(tmp, name))
            if got:
                n += 1
                for i in range(4):
                    sums[i] += got[i]
    return (n,) + tuple(sums)


def iter_days(start_day: str, end_day: str):
    d = dt.date.fromisoformat(start_day)
    end = dt.date.fromisoformat(end_day)
    while d <= end:
        yield d.isoformat()
        d += dt.timedelta(days=1)


def load_state(path: str) -> dict:
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_state(path: str, state: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def refresh_days(state: dict, args) -> None:
    """Bring state['days'] up to date, each UTC day counted exactly once.
    Loose files win while present (they cover the growing day and survive
    until the nightly purge); a day cached from an archive is never
    recomputed; a day cached from loose is recomputed (same-day growth).
    A day whose archive read FAILS stays uncached, so the next tick retries
    it — caching the failure would freeze a permanent zero, and an
    under-counted burn is the failure mode that points the wrong way."""
    baseline_day = state["baseline_day"]
    days = state.setdefault("days", {})
    today = utc_today()
    for day in iter_days(baseline_day, today):
        cached = days.get(day)
        if cached and cached.get("source") == "archive":
            continue
        got = scan_dir_for_day(args.captures_dir, day)
        n, out_sum, in_sum, cr_sum, cc_sum = got
        has_archive = os.path.exists(archive_path(args.archive_dir, day))
        if n == 0 and has_archive:
            # Either the day was quiet in loose AND archived, or (the trap)
            # the loose files were purged into the archive — the archive is
            # authoritative and must never lose an already-counted day.
            got = scan_archive_for_day(args.seven_zip, args.archive_dir, day)
            if got is None:
                # Extraction failed — a GDrive-mount hiccup reaches here. Do NOT
                # cache it: an archive-sourced day is never recomputed, so the
                # zero written now would be permanent and silently under-count
                # the burn. Leave the day unwritten; the next tick retries.
                continue
            n, out_sum, in_sum, cr_sum, cc_sum = got
            days[day] = day_entry("archive", n, out_sum, in_sum, cr_sum, cc_sum)
        elif n > 0 or cached is None:
            days[day] = day_entry("loose", n, out_sum, in_sum, cr_sum, cc_sum)
        # else: n == 0, no archive, cached from loose with data — keep the
        # cache (a same-day re-scan racing the nightly purge).


def day_entry(source, n, out_sum, in_sum, cr_sum, cc_sum) -> dict:
    return {
        "source": source,
        "files": n,
        "out": out_sum,
        "in": in_sum,
        "cache_read": cr_sum,
        "cache_creation": cc_sum,
    }


def cumulative_out(state: dict) -> int:
    return sum(d.get("out", 0) for d in state.get("days", {}).values())


def cumulative_field(state: dict, field: str) -> int:
    return sum(d.get(field, 0) for d in state.get("days", {}).values())


def burned_since_baseline(state: dict) -> int:
    # days[] covers [baseline_day..today] INCLUSIVE; the baseline-day snapshot
    # (t0_partial) was taken mid-day, so the remainder of that day is burn.
    return cumulative_out(state) - state.get("t0_partial_out", 0)


def cmd_baseline(args, state: dict) -> None:
    if state.get("phase"):
        sys.exit(
            f"refusing: state phase is '{state['phase']}' — use --force to restart"
        )
    day = utc_today()
    n, out_sum, in_sum, cr_sum, cc_sum = scan_dir_for_day(args.captures_dir, day)
    state.update(
        {
            "phase": "awaiting-p1",
            "baseline_day": day,
            "t0_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "percent0": args.percent,
            "t0_partial_out": out_sum,
            "t0_partial_in": in_sum,
            "t0_partial_cache_read": cr_sum,
            "t0_partial_cache_creation": cc_sum,
            "t0_files": n,
            "days": {day: day_entry("loose", n, out_sum, in_sum, cr_sum, cc_sum)},
        }
    )
    save_state(args.state, state)
    print(
        f"BASELINE set: {args.percent}% remaining read at {state['t0_utc']}.\n"
        f"  baseline day {day}: {n} meter files, out={out_sum} "
        f"in={in_sum} (cache_read={cr_sum}, cache_creation={cc_sum}) tokens.\n"
        f"  Next: when the Qwen console reads the calibration target, run "
        f"`report --percent <reading>`."
    )


def cmd_tick(args, state: dict) -> None:
    if not state.get("phase"):
        sys.exit("no baseline — run `baseline --percent <console reading>` first")
    refresh_days(state, args)
    save_state(args.state, state)
    burned = burned_since_baseline(state)
    total_out = cumulative_out(state)
    files = sum(d.get("files", 0) for d in state["days"].values())
    b_in = cumulative_field(state, "in") - state.get("t0_partial_in", 0)
    b_cr = cumulative_field(state, "cache_read") - state.get(
        "t0_partial_cache_read", 0
    )
    b_cc = cumulative_field(state, "cache_creation") - state.get(
        "t0_partial_cache_creation", 0
    )
    print(
        f"TICK {state['phase']}: days {state['baseline_day']}..{utc_today()} "
        f"({files} meter files, cumulative out={total_out})\n"
        f"  burned since baseline (P0={state['percent0']}%): out={burned} "
        f"in={b_in} (cache_read={b_cr}, cache_creation={b_cc}) tokens"
    )
    if state["phase"] == "enforcing":
        print_status_body(state)


def cmd_report(args, state: dict) -> None:
    if state.get("phase") != "awaiting-p1":
        sys.exit(f"refusing: phase is '{state.get('phase')}', expected awaiting-p1")
    if args.percent >= state["percent0"]:
        sys.exit(
            f"refusing: reading {args.percent}% >= baseline {state['percent0']}% "
            f"— P1 must be LOWER (these are remaining-% readings)"
        )
    refresh_days(state, args)
    burned = burned_since_baseline(state)
    b_in = cumulative_field(state, "in") - state.get("t0_partial_in", 0)
    b_cr = cumulative_field(state, "cache_read") - state.get(
        "t0_partial_cache_read", 0
    )
    b_cc = cumulative_field(state, "cache_creation") - state.get(
        "t0_partial_cache_creation", 0
    )
    span_pts = state["percent0"] - args.percent
    frac = span_pts / 100.0

    def implied(burned_value):
        return round(burned_value / frac) if frac else None

    implied_total = implied(burned)
    cap_weekly = burned
    even_spread = round(implied_total / 4) if implied_total else None
    drift = (
        round(100.0 * (cap_weekly - even_spread) / even_spread, 1)
        if even_spread
        else None
    )
    state.update(
        {
            "phase": "enforcing",
            "p1_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "percent1": args.percent,
            "cap_weekly_out": cap_weekly,
            "cap_weekly_in": b_in,
            "cap_weekly_cache_read": b_cr,
            "cap_weekly_cache_creation": b_cc,
            "implied_monthly_total_out": implied_total,
            "implied_monthly_total_in": implied(b_in),
            "implied_monthly_total_cache_read": implied(b_cr),
            "implied_monthly_total_in_all": implied(b_in + b_cr + b_cc),
            "implied_monthly_total_in_plus_out": implied(b_in + b_cr + b_cc + burned),
            "even_spread_out": even_spread,
            "spread_drift_pct": drift,
        }
    )
    save_state(args.state, state)
    print(
        f"CALIBRATED: P0={state['percent0']}% -> P1={args.percent}% "
        f"({span_pts} pts).\n"
        f"  burned: out={burned} in={b_in} (cache_read={b_cr}, "
        f"cache_creation={b_cc})\n"
        f"  WEEKLY CAP (out) = {cap_weekly} output tokens\n"
        f"  implied monthly totals, per candidate billing unit — compare "
        f"against the console's own numbers to pick the real one:\n"
        f"    out only           : {implied_total}\n"
        f"    in only (uncached) : {implied(b_in)}\n"
        f"    cache_read only    : {implied(b_cr)}\n"
        f"    all in (in+cr+cc)  : {implied(b_in + b_cr + b_cc)}\n"
        f"    in+out             : {implied(b_in + b_cr + b_cc + burned)}\n"
        f"  even 4-week spread (out) = {even_spread} (cap drift {drift}%)\n"
        f"  From now on `status` watches the rolling 7-day burn against the cap."
    )


def rolling7_out(state: dict) -> int:
    today = dt.datetime.now(dt.timezone.utc).date()
    window = {
        (today - dt.timedelta(days=i)).isoformat() for i in range(7)
    }
    return sum(
        d.get("out", 0)
        for day, d in state.get("days", {}).items()
        if day in window
    )


def print_status_body(state: dict) -> None:
    cap = state["cap_weekly_out"]
    roll = rolling7_out(state)
    pct = round(100.0 * roll / cap, 1) if cap else None
    verdict = "OK"
    if pct is not None:
        if roll >= cap:
            verdict = "EXCEEDED — deroute lever: remove the qwen steps from the cascade lines (+ realign _LABEL/_DIRECTION/_NOTE/_RESET), drained restart (operator gesture; _RESET alone is inert, #261)"
        elif pct >= 90:
            verdict = "NEAR (>90%)"
        elif pct >= 70:
            verdict = "WATCH (>70%)"
    print(
        f"STATUS enforcing: rolling-7d out={roll} / cap={cap} ({pct}%)\n"
        f"  verdict: {verdict}"
    )


def cmd_status(args, state: dict) -> None:
    if not state.get("phase"):
        sys.exit("no baseline — run `baseline --percent <console reading>` first")
    refresh_days(state, args)
    save_state(args.state, state)
    if state["phase"] == "enforcing":
        print_status_body(state)
    else:
        burned = burned_since_baseline(state)
        print(
            f"STATUS awaiting-p1 (P0={state['percent0']}% at {state['t0_utc']}): "
            f"burned so far {burned} output tokens. "
            f"Waiting for the user's next console reading (`report --percent <p>`)."
        )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--state", default=DEFAULT_STATE)
    ap.add_argument("--captures-dir", default=DEFAULT_CAPTURES)
    ap.add_argument("--archive-dir", default=DEFAULT_ARCHIVES)
    ap.add_argument("--7z", dest="seven_zip", default=DEFAULT_7Z)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("baseline")
    b.add_argument("--percent", type=float, required=True)
    b.add_argument("--force", action="store_true")
    sub.add_parser("tick")
    r = sub.add_parser("report")
    r.add_argument("--percent", type=float, required=True)
    sub.add_parser("status")
    args = ap.parse_args()

    state = load_state(args.state)
    if args.cmd == "baseline":
        if args.force:
            state = {}
        cmd_baseline(args, state)
    elif args.cmd == "tick":
        cmd_tick(args, state)
    elif args.cmd == "report":
        cmd_report(args, state)
    elif args.cmd == "status":
        cmd_status(args, state)


if __name__ == "__main__":
    main()
