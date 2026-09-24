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
     deroute lever (position-preserving `..._RESET` on the qwen cascade
     steps + drained restart — an operator gesture, never automatic here).

Meter corpus (include-list, from config.json routing + cascade steps):
  deepseek-v4-flash, deepseek-v4.1-flash  (cascade steps via qwen-token-plan;
    the @-target deepseek-v4.1-flash surfaces as deepseek-v4-flash in capture
    filenames — outbound id is rewritten before the wire)
  qwen3.6-flash, qwen3.7-plus, qwen3.7-max, qwen3.8-max  (explicit routing)
EXCLUDED on purpose: qwen3.6-35b-a3b — routed to vllm-myia (LOCAL lane, not
the Qwen meter) even though the name starts with "qwen".
KNOWN BIAS (accepted, upper-bound direction): bare client requests for
deepseek-v4-flash ride the DeepSeek-first FallbackHandler chain and may be
served by DeepSeek PAYG while still landing in our corpus. Measured 2026-09-24
that population is drain-probes only (~15 output tokens each); if real bare
traffic appears, tighten with [Failover] log correlation.

Units: output_tokens (the Token Plan bills on OUTPUT — docs/reference/
budget-failover.md). input_tokens tracked alongside for recalibration if the
47% cross-check disagrees.

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

METER_MODELS = {
    "deepseek-v4-flash",
    "deepseek-v4.1-flash",
    "qwen3.6-flash",
    "qwen3.7-plus",
    "qwen3.7-max",
    "qwen3.8-max",
}

# resp-1-r0731-2026-09-24T04-56-52-709Z-openai-deepseek-v4-flash.sse
RESP_RE = re.compile(
    r"^resp-\d+-r\d+-(\d{4}-\d{2}-\d{2})T[\d-]+Z-\w+-(.+)\.sse$"
)
OUT_RE = re.compile(r'"output_tokens":(\d+)')
IN_RE = re.compile(r'"input_tokens":(\d+)')


def utc_today() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def parse_sse_usage(path: str):
    """MAX output/input per file — wire-openai emits a zero block first
    (same lesson as compaction-trend.py: never sum, take the max)."""
    out_max = 0
    in_max = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            body = f.read()
        for m in OUT_RE.finditer(body):
            out_max = max(out_max, int(m.group(1)))
        for m in IN_RE.finditer(body):
            in_max = max(in_max, int(m.group(1)))
    except OSError:
        return None
    return out_max, in_max


def scan_dir_for_day(captures_dir: str, day: str):
    """Sum usage over the loose-capture dir for one UTC day. Returns
    (n_files, out_sum, in_sum) — recomputed fresh each call since the loose
    day only grows (files for a past day can still appear pre-purge)."""
    n = 0
    out_sum = 0
    in_sum = 0
    try:
        names = os.listdir(captures_dir)
    except OSError:
        return 0, 0, 0
    for name in names:
        m = RESP_RE.match(name)
        if not m or m.group(1) != day or m.group(2) not in METER_MODELS:
            continue
        got = parse_sse_usage(os.path.join(captures_dir, name))
        if got:
            n += 1
            out_sum += got[0]
            in_sum += got[1]
    return n, out_sum, in_sum


def archive_path(archives_dir: str, day: str) -> str:
    return os.path.join(archives_dir, f"captures-{day}.7z")


def scan_archive_for_day(seven_zip: str, archives_dir: str, day: str):
    """One-pass 7z extraction of the meter models only (per-file `-e -so` on a
    Google-Drive mount re-scans the whole archive each call — measured
    2026-09-24, timeout-class slow). Multiple -ir! masks are an OR."""
    arc = archive_path(archives_dir, day)
    if not os.path.exists(arc):
        return 0, 0, 0
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
            return 0, 0, 0
        n = 0
        out_sum = 0
        in_sum = 0
        for name in os.listdir(tmp):
            got = parse_sse_usage(os.path.join(tmp, name))
            if got:
                n += 1
                out_sum += got[0]
                in_sum += got[1]
    return n, out_sum, in_sum


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
    recomputed; a day cached from loose is recomputed (same-day growth)."""
    baseline_day = state["baseline_day"]
    days = state.setdefault("days", {})
    today = utc_today()
    for day in iter_days(baseline_day, today):
        cached = days.get(day)
        if cached and cached.get("source") == "archive":
            continue
        n, out_sum, in_sum = scan_dir_for_day(args.captures_dir, day)
        has_archive = os.path.exists(archive_path(args.archive_dir, day))
        if n == 0 and has_archive:
            # Either the day was quiet in loose AND archived, or (the trap)
            # the loose files were purged into the archive — the archive is
            # authoritative and must never lose an already-counted day.
            n, out_sum, in_sum = scan_archive_for_day(
                args.seven_zip, args.archive_dir, day
            )
            days[day] = {
                "source": "archive",
                "files": n,
                "out": out_sum,
                "in": in_sum,
            }
        elif n > 0 or cached is None:
            days[day] = {"source": "loose", "files": n, "out": out_sum, "in": in_sum}
        # else: n == 0, no archive, cached from loose with data — keep the
        # cache (a same-day re-scan racing the nightly purge).


def cumulative_out(state: dict) -> int:
    return sum(d.get("out", 0) for d in state.get("days", {}).values())


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
    n, out_sum, in_sum = scan_dir_for_day(args.captures_dir, day)
    state.update(
        {
            "phase": "awaiting-p1",
            "baseline_day": day,
            "t0_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "percent0": args.percent,
            "t0_partial_out": out_sum,
            "t0_partial_in": in_sum,
            "t0_files": n,
            "days": {
                day: {
                    "source": "loose",
                    "files": n,
                    "out": out_sum,
                    "in": in_sum,
                }
            },
        }
    )
    save_state(args.state, state)
    print(
        f"BASELINE set: {args.percent}% remaining read at {state['t0_utc']}.\n"
        f"  baseline day {day}: {n} meter files, out={out_sum} in={in_sum} tokens.\n"
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
    print(
        f"TICK {state['phase']}: days {state['baseline_day']}..{utc_today()} "
        f"({files} meter files, cumulative out={total_out})\n"
        f"  burned since baseline (P0={state['percent0']}%): {burned} output tokens"
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
    span_pts = state["percent0"] - args.percent
    implied_total = round(burned / (span_pts / 100.0))
    cap_weekly = burned
    even_spread = round(implied_total / 4)
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
            "implied_monthly_total_out": implied_total,
            "even_spread_out": even_spread,
            "spread_drift_pct": drift,
        }
    )
    save_state(args.state, state)
    print(
        f"CALIBRATED: P0={state['percent0']}% -> P1={args.percent}% "
        f"({span_pts} pts) burned {burned} output tokens.\n"
        f"  WEEKLY CAP = {cap_weekly} output tokens\n"
        f"  implied monthly total = {implied_total}; even 4-week spread = "
        f"{even_spread} (cap drift {drift}%)\n"
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
            verdict = "EXCEEDED — deroute lever: set the qwen steps' ..._RESET position to next Monday, drained restart (operator gesture)"
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
