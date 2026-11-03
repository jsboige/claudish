#!/usr/bin/env python3
"""MiniMax weekly-quota projection — one formula, and no free pace window.

The weekly window is opened by the plan itself: ``window_start = reset_anchor - 7 days``.
From a single console reading:

    elapsed_h  = reading_ts - window_start
    pace       = weekly_pct / elapsed_h
    eta_h      = (100 - weekly_pct) / pace        # hours until the wall
    wall_utc   = reading_ts + eta_h
    projected  = pace * 168                        # % reached at the reset
    margin_h   = (reset_anchor - reading_ts) - eta_h

Severity (worker skill, §Veille quota MiniMax):

    ASK   when eta_h < 48             -> registry entry, never an automatic gesture
    WARN  when the wall lands before the reset AND margin_h > 24
    OK    otherwise

There is deliberately **no option to choose a shorter pace window**. On 2026-11-03 the
same doctrine produced two projections ×1.7 apart from readings 1 h 40 apart, because
the second call measured the pace over the 5.3 h gap between two samples instead of the
elapsed time since the window opened. The window is a property of the plan, not of the
sample: a caller that can pick the window after seeing the numbers can make any verdict
appear.

Measured console levels are deliberately absent from this file and its pins — this
repository is a public fork, so only ratios, durations and derived arithmetic travel
here; the readings themselves live in the machine-local watch log.

Usage
-----
    python scripts/minimax-projection.py --ts 2026-11-03T14:45:00Z \\
        --weekly-pct 34 --reset-anchor 2026-11-09T00:00Z [--five-hour-pct 31] [--json]

    # re-derive every recorded reading with the canonical formula and flag the ones
    # whose stored projection disagrees (the instrument that would have caught it)
    python scripts/minimax-projection.py --recompute-log ~/.claudish/minimax-plan-watch.log

    # same, forcing a verified anchor over the day-slipped one a row stored
    python scripts/minimax-projection.py --recompute-log ~/.claudish/minimax-plan-watch.log \\
        --assume-anchor 2026-11-09T00:00Z
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

WEEK_HOURS = 168.0
ASK_BELOW_H = 48.0
WARN_MARGIN_H = 24.0
# Two projections further apart than this are treated as a disagreement, not noise:
# the reading is integer-percent, so a faithful recomputation lands within a point or two.
DISAGREEMENT_PTS = 2.0


def parse_ts(value: str) -> datetime:
    """Parse an ISO-8601 timestamp; a naive value is UTC (never local — that is a 1-2 h skew)."""
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:  # pragma: no cover - message clarity only
        raise SystemExit(f"timestamp illisible: {value!r} ({exc})") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def severity(eta_h: float | None, hours_to_reset: float) -> tuple[str, bool]:
    """Return (severity, ask). Ask is a registry question, never an automatic gesture."""
    if eta_h is None:
        return "OK", False
    if eta_h < ASK_BELOW_H:
        return "ASK", True
    if eta_h < hours_to_reset and (hours_to_reset - eta_h) > WARN_MARGIN_H:
        return "WARN", False
    return "OK", False


def project(
    ts: datetime,
    weekly_pct: float,
    reset_anchor: datetime,
    five_hour_pct: float | None = None,
) -> dict:
    """Canonical projection. The pace window is derived, never supplied."""
    if not 0 <= weekly_pct <= 100:
        raise ValueError(f"weekly_pct hors bornes: {weekly_pct}")
    window_start = reset_anchor - timedelta(hours=WEEK_HOURS)
    elapsed_h = (ts - window_start).total_seconds() / 3600.0
    if elapsed_h <= 0:
        raise ValueError(
            f"relevé antérieur à l'ouverture de la fenêtre ({window_start.isoformat()})"
        )
    if ts > reset_anchor:
        raise ValueError("relevé postérieur à l'ancre de reset — l'ancre est périmée")

    hours_to_reset = (reset_anchor - ts).total_seconds() / 3600.0
    pace = weekly_pct / elapsed_h
    if pace > 0:
        eta_h: float | None = (100.0 - weekly_pct) / pace
        wall = ts + timedelta(hours=eta_h)
        wall_utc = wall.strftime("%Y-%m-%dT%H:%MZ")
        projected = pace * WEEK_HOURS
        margin_h: float | None = hours_to_reset - eta_h
    else:
        eta_h = None
        wall_utc = None
        projected = 0.0
        margin_h = None

    verdict, ask = severity(eta_h, hours_to_reset)
    return {
        "ts": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "weekly_pct": weekly_pct,
        "five_hour_pct": five_hour_pct,
        "window_start": window_start.strftime("%Y-%m-%dT%H:%MZ"),
        "reset_anchor": reset_anchor.strftime("%Y-%m-%dT%H:%MZ"),
        "elapsed_h": round(elapsed_h, 2),
        "hours_to_reset": round(hours_to_reset, 2),
        "weekly_pace_pct_per_h": round(pace, 3),
        "weekly_eta_h": None if eta_h is None else round(eta_h, 1),
        "weekly_wall_utc": wall_utc,
        "weekly_projection_pct": round(projected, 1),
        "margin_h": None if margin_h is None else round(margin_h, 1),
        "verdict": verdict,
        "ask": ask,
    }


def recompute_log(
    path: Path,
    last: int | None = None,
    assume_anchor: datetime | None = None,
) -> list[dict]:
    """Re-derive every readable reading; flag stored projections that disagree.

    ``assume_anchor`` overrides the anchor each row carries. That is the repair path for
    a day-slipped anchor: a row that stored ``<reset+1>T23:00Z`` instead of the true
    midnight moves the window start by 23 h and multiplies the projection by ~3 — the
    same reading, a different story. Rows whose anchor is malformed are still skipped,
    never guessed.
    """
    entries: list[dict] = []
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    readings = [row for row in entries if "weekly_pct" in row and row.get("ts")]
    if last is not None:
        readings = readings[-last:]

    out: list[dict] = []
    for row in readings:
        anchor_raw = row.get("weekly_reset_utc")
        if assume_anchor is not None:
            anchor = assume_anchor
        elif anchor_raw:
            try:
                anchor = parse_ts(anchor_raw)
            except SystemExit as exc:
                out.append({"ts": row.get("ts"), "skipped": str(exc)})
                continue
        else:
            out.append({"ts": row.get("ts"), "skipped": "aucune ancre de reset enregistrée"})
            continue
        try:
            result = project(
                parse_ts(row["ts"]),
                float(row["weekly_pct"]),
                anchor,
                row.get("five_hour_pct"),
            )
        except (ValueError, SystemExit) as exc:
            out.append({"ts": row.get("ts"), "skipped": str(exc)})
            continue
        if assume_anchor is not None:
            result["anchor_assumed"] = True
        stored = row.get("weekly_projection_pct")
        if isinstance(stored, (int, float)):
            delta = result["weekly_projection_pct"] - float(stored)
            result["stored_projection_pct"] = stored
            result["disagrees"] = abs(delta) > DISAGREEMENT_PTS
            result["delta_pts"] = round(delta, 1)
        else:
            result["disagrees"] = False
        out.append(result)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--ts", help="horodatage du relevé (ISO-8601, Z)")
    parser.add_argument("--weekly-pct", type=float, help="%% hebdomadaire consommé")
    parser.add_argument("--reset-anchor", help="ancre de reset hebdo (ISO-8601, Z)")
    parser.add_argument("--five-hour-pct", type=float, default=None)
    parser.add_argument("--json", action="store_true", help="sortie JSON (une ligne)")
    parser.add_argument("--recompute-log", metavar="PATH", help="re-dérive un journal NDJSON")
    parser.add_argument("--last", type=int, default=None, help="avec --recompute-log : N dernières")
    parser.add_argument("--assume-anchor", metavar="ISO",
                        help="avec --recompute-log : ancre vérifiée à substituer à celle des lignes")
    args = parser.parse_args(argv)

    if args.recompute_log:
        assumed = parse_ts(args.assume_anchor) if args.assume_anchor else None
        rows = recompute_log(Path(args.recompute_log).expanduser(), args.last, assumed)
        if args.json:
            print(json.dumps(rows, ensure_ascii=False, indent=1))
            return 0
        print(f"{'ts':22s} {'wk%':>4} {'elapsed':>8} {'pace':>7} {'eta_h':>7} {'proj':>7} "
              f"{'stored':>7} {'sévérité':>8}  note")
        for row in rows:
            if "skipped" in row:
                print(f"{str(row.get('ts')):22s} {'-':>4} {'-':>8} {'-':>7} {'-':>7} {'-':>7} "
                      f"{'-':>7} {'-':>8}  {row['skipped']}")
                continue
            stored = row.get("stored_projection_pct")
            note = "DÉSACCORD" if row.get("disagrees") else ""
            if row["verdict"] == "ASK":
                note = (note + " ASK").strip()
            print(f"{row['ts']:22s} {row['weekly_pct']:>4.0f} {row['elapsed_h']:>8.1f} "
                  f"{row['weekly_pace_pct_per_h']:>7.3f} {str(row['weekly_eta_h']):>7} "
                  f"{row['weekly_projection_pct']:>7.1f} "
                  f"{(f'{stored:.1f}' if isinstance(stored, (int, float)) else '-'):>7} "
                  f"{row['verdict']:>8}  {note}")
        disagreeing = sum(1 for row in rows if row.get("disagrees"))
        print(f"\n{len(rows)} relevés re-dérivés, {disagreeing} en désaccord avec leur projection enregistrée.")
        return 0

    missing = [name for name, value in (("--ts", args.ts), ("--weekly-pct", args.weekly_pct),
                                        ("--reset-anchor", args.reset_anchor)) if value is None]
    if missing:
        parser.error("requis: " + ", ".join(missing))
    result = project(parse_ts(args.ts), args.weekly_pct, parse_ts(args.reset_anchor),
                     args.five_hour_pct)
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
