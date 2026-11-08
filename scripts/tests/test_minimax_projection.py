#!/usr/bin/env python3
r"""Pins for minimax-projection.py — one formula, and no free pace window.

The failure this file exists against is not a crash: it is a *reassuring* verdict.
On 2026-11-03 the same doctrine produced two projections ×1.7 apart from two readings
1 h 40 apart, because the second call measured the pace over the 5.3 h gap between the
samples instead of the elapsed time since the weekly window opened. Both scripts "ran
fine". The pin below therefore asserts the ABSENCE of a pace-window parameter: a caller
that can choose the window after seeing the numbers can make any verdict appear.

All fixtures here are SYNTHETIC (June 2026 dates, arbitrary percentages). Measured
console levels are deliberately not reproduced in this repository — it is a public fork,
so only ratios, durations and arithmetic travel here; the readings stay in the
machine-local watch log. What the pins fix is the *formula*, not a past number.

Run standalone:  python scripts/tests/test_minimax_projection.py
Or under pytest: pytest scripts/tests/test_minimax_projection.py
"""

import importlib.util
import inspect
import json
import os
import pathlib
import tempfile
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "minimax_projection", os.path.join(_HERE, "..", "minimax-projection.py"))
mp = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(mp)

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def ts(text):
    return mp.parse_ts(text)


ANCHOR = "2026-06-15T00:00Z"          # synthetic weekly reset anchor
TS_A = "2026-06-09T10:00:00Z"         # 34 h after the window opened
TS_B = "2026-06-09T14:45:00Z"         # 38.75 h after the window opened
CANONICAL_A = 148.2                   # what TS_A/30 % must project


def test_canonical_projection_from_the_anchor():
    """The pace is elapsed-time-since-open, never a sample-to-sample gap."""
    r = mp.project(ts(TS_A), 30, ts(ANCHOR))
    check("elapsed = 34 h depuis l'ouverture", abs(r["elapsed_h"] - 34.0) < 0.01, r["elapsed_h"])
    check("pace canonique 0.882 %/h", abs(r["weekly_pace_pct_per_h"] - 0.882) < 0.002,
          r["weekly_pace_pct_per_h"])
    check("eta 79.3 h", abs(r["weekly_eta_h"] - 79.3) < 0.2, r["weekly_eta_h"])
    check("projeté au reset 148.2 %", abs(r["weekly_projection_pct"] - CANONICAL_A) < 0.3,
          r["weekly_projection_pct"])
    check("sévérité WARN (mur avant le reset, marge > 24 h)", r["verdict"] == "WARN", r["verdict"])
    check("pas d'ASK au-dessus de 48 h", r["ask"] is False)


def test_a_decelerating_series_is_not_judged_on_its_last_gap():
    """The hazard the parameter ban removes: on a slowing curve, a gap window flatters.

    Synthetic series on one window: 10 % after 10 h (1.000 %/h), then 11 % after 14 h
    (0.250 %/h over the last 4 h). The cumulative formula the plan defines yields
    0.786 %/h -> 132 % at the reset; pacing the last gap yields 0.250 %/h -> 42 %,
    i.e. a verdict off by ×3 for the same reading. ``project()`` must return the first.
    """
    r = mp.project(ts("2026-06-08T14:00:00Z"), 11, ts(ANCHOR))
    cumulative = r["weekly_projection_pct"]
    gap_pace = (11 - 10) / 4.0
    gap_projection = gap_pace * mp.WEEK_HOURS
    check("la formule cumule depuis l'ouverture (≈132 %)", abs(cumulative - 132.0) < 1.0, cumulative)
    check("la fenêtre delta aurait dit ≈42 %", abs(gap_projection - 42.0) < 1.0, gap_projection)
    check("le verdict bascule d'un facteur > 2 selon la fenêtre", cumulative / gap_projection > 2.0,
          round(cumulative / gap_projection, 2))


def test_fresh_reading_after_a_reload():
    r = mp.project(ts(TS_B), 34, ts(ANCHOR), five_hour_pct=31)
    check("pace 0.877 %/h", abs(r["weekly_pace_pct_per_h"] - 0.877) < 0.002,
          r["weekly_pace_pct_per_h"])
    check("eta 75.2 h", abs(r["weekly_eta_h"] - 75.2) < 0.2, r["weekly_eta_h"])
    check("mur = relevé + eta", r["weekly_wall_utc"] == "2026-06-12T17:58Z", r["weekly_wall_utc"])
    check("marge 54.0 h avant le reset", abs(r["margin_h"] - 54.0) < 0.2, r["margin_h"])
    check("verdict WARN", r["verdict"] == "WARN", r["verdict"])
    check("5h % conservé", r["five_hour_pct"] == 31)


def test_no_pace_window_parameter():
    """Structural pin: the doctrine's failure mode is a *parameter*, so its absence is pinned."""
    params = set(inspect.signature(mp.project).parameters)
    check("project() n'accepte AUCUNE fenêtre de pace",
          params == {"ts", "weekly_pct", "reset_anchor", "five_hour_pct"}, params)
    try:
        mp.project(ts(TS_A), 30, ts(ANCHOR), window_h=5.3)
        rejected = False
    except TypeError:
        rejected = True
    check("un appel avec window_h=5.3 est refusé", rejected)


def test_ask_threshold_is_48h():
    r = mp.project(ts(TS_B), 80, ts(ANCHOR))
    check("eta < 48 h -> ASK", r["verdict"] == "ASK" and r["ask"] is True,
          (r["weekly_eta_h"], r["verdict"]))
    r2 = mp.project(ts(TS_B), 60, ts(ANCHOR))
    check("eta ~ 25.8 h -> ASK (borne basse)", r2["verdict"] == "ASK", r2["weekly_eta_h"])


def test_ok_when_pace_fits_the_reset():
    r = mp.project(ts(TS_B), 5, ts(ANCHOR))
    check("pace faible -> OK même si le reset est loin",
          r["verdict"] == "OK" and r["margin_h"] < 0, (r["verdict"], r["margin_h"]))


def test_zero_reading_does_not_divide_by_zero():
    r = mp.project(ts(TS_B), 0, ts(ANCHOR))
    check("0 % -> pas d'exception, pas de verdict", r["verdict"] == "OK" and r["weekly_eta_h"] is None)
    check("0 % -> projection 0", r["weekly_projection_pct"] == 0.0)


def test_refusals():
    for label, kwargs in (
        ("relevé avant l'ouverture de la fenêtre",
         dict(ts=ts("2026-06-01T12:00:00Z"), weekly_pct=3, reset_anchor=ts(ANCHOR))),
        ("relevé postérieur à l'ancre",
         dict(ts=ts("2026-06-16T12:00:00Z"), weekly_pct=99, reset_anchor=ts(ANCHOR))),
        ("pourcentage hors bornes",
         dict(ts=ts(TS_B), weekly_pct=101, reset_anchor=ts(ANCHOR))),
    ):
        try:
            mp.project(**kwargs)
            refused = False
        except ValueError:
            refused = True
        check(f"refus: {label}", refused)


def test_naive_timestamp_is_utc():
    check("un horodatage sans fuseau est lu en UTC (jamais en heure locale)",
          mp.parse_ts("2026-06-09T14:45:00") == mp.parse_ts("2026-06-09T14:45:00Z"))


def test_recompute_log_flags_a_disagreeing_stored_projection():
    """Re-deriving a journal must flag rows whose stored projection the formula cannot reproduce."""
    rows = [
        {"ts": TS_A, "weekly_pct": 30, "weekly_reset_utc": ANCHOR, "weekly_projection_pct": 60.0},
        {"ts": TS_B, "weekly_pct": 34, "weekly_reset_utc": ANCHOR,
         "weekly_projection_pct": CANONICAL_A + 1},
        {"ts": "2026-06-09T12:30:00Z", "type": "correction", "weekly_reset_utc": ANCHOR},
        {"ts": "2026-06-09T13:00:00Z", "weekly_pct": 31},
    ]
    with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False, encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")
        path = fh.name
    try:
        out = mp.recompute_log(pathlib.Path(path))
    finally:
        os.unlink(path)
    check("3 relevés retenus, l'entrée sans weekly_pct ignorée", len(out) == 3, len(out))
    check("projection enregistrée fausse -> DÉSACCORD", out[0].get("disagrees") is True,
          out[0].get("delta_pts"))
    check("projection enregistrée fidèle -> pas de désaccord", out[1].get("disagrees") is False,
          out[1].get("delta_pts"))
    check("un relevé sans ancre est SAUTÉ, jamais deviné", "skipped" in out[2], out[2])


def test_assume_anchor_repairs_a_day_slipped_row():
    """A stored anchor one day late poisons the projection; --assume-anchor repairs it."""
    rows = [{"ts": TS_A, "weekly_pct": 30, "weekly_reset_utc": "2026-06-16T00:00Z"}]
    with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False, encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")
        path = fh.name
    try:
        as_stored = mp.recompute_log(pathlib.Path(path))
        repaired = mp.recompute_log(pathlib.Path(path), assume_anchor=ts(ANCHOR))
    finally:
        os.unlink(path)
    ratio = as_stored[0]["weekly_projection_pct"] / repaired[0]["weekly_projection_pct"]
    check("ancre glissée d'un jour -> projection ×>2.5", ratio > 2.5, round(ratio, 2))
    check("ancre vérifiée substituée -> projection canonique",
          abs(repaired[0]["weekly_projection_pct"] - CANONICAL_A) < 0.3,
          repaired[0]["weekly_projection_pct"])
    check("la substitution est DÉCLARÉE dans la sortie", repaired[0].get("anchor_assumed") is True)


def main():
    cases = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for case in cases:
        print(f"\n{case.__name__}")
        case()
    print()
    if FAILS:
        print(f"{len(FAILS)} pin(s) rouge(s): {', '.join(FAILS)}")
        return 1
    print(f"{len(cases)} cas, tous verts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
