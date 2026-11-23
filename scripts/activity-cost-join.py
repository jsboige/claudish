#!/usr/bin/env python3
"""Join GitHub activity (github-activity.py) with provider consumption, one row per day.

The recipe is issue #1161 stage 2: a per-day series of contributions set
against the lanes' token consumption, so a coordinator can read
activity-per-cost (the RSM consumption loop's GitHub-side counterpart).

Inputs (both JSON files, produced elsewhere — this tool reads, it never
crawls):
  --activity    github-activity.py --json  -> {source, from, to, days:[{date,count}],
                                               coverage:{covered,span_days,absent}, ...}
  --consumption a per-day consumption series -> {"days":[{"date", "out",
                                               "cache_create", "cache_read",
                                               "in"?, "blind"?, "partial"?}]}
                One producer is a trough pass over the hub corpus; the shape
                is declarative so any reader (traffic-consumption.py family)
                can emit it.

Reading rules (the recipe's bounds, implemented as pins):
  1. Join on CALENDAR date. A day present on one side only is flagged
     `activity-only` / `consumption-only` and NEVER ratio'd.
  2. inEq = 1.25*cache_create + 0.1*cache_read + 5*out  (billed-attrib norm).
  3. An absent activity day is not a zero-contribution day: the fragment's
     coverage.absent list (and a GraphQL window's exclusive `to`) makes the
     row `activity-absent`, no ratio.
  4. `partial` is surfaced, never silently ratio'd: a day the consumption
     side marks partial, or the current UTC day under the fragment source.
  5. A `blind` consumption day (the #933 fleet blind spot) yields a BLIND
     row with no ratio — absence is named, not fabricated.
  6. One activity file carries one source; the header names it.

Exit: 0 on a report (even an all-flagged one), 2 on a blind read (no day
readable at all, or an input without `days`) — "no report" is said out loud.
"""
import argparse
import json
import sys
from datetime import datetime, timezone

SOURCE_LABELS = {"fragment": "fragment-anonyme", "graphql": "graphql"}


def load_json(path, what):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"activity-cost-join: {what} illisible ({path}): {exc}\n")
        sys.exit(2)


def ineq(day):
    """The recipe's norm, verbatim: 1.25*cc + 0.1*cr + 5*out."""
    return (1.25 * day.get("cache_create", 0)
            + 0.1 * day.get("cache_read", 0)
            + 5 * day.get("out", 0))


def join(activity, consumption, today=None):
    days_a = {d["date"]: d["count"] for d in activity.get("days", [])}
    days_c = {d["date"]: d for d in consumption.get("days", [])}
    absent_a = set(activity.get("coverage", {}).get("absent", []) or [])
    source = activity.get("source", "")
    to_day = activity.get("to")
    today = today or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    rows = []
    for date in sorted(set(days_a) | set(days_c) | absent_a):
        flags = []
        row = {"date": date, "contributions": None, "inEq": None,
               "ratio": None, "flags": flags}
        a_count = days_a.get(date)
        c_day = days_c.get(date)
        if date in absent_a and a_count is None:
            flags.append("activity-absent")
        if a_count is not None and c_day is None:
            flags.append("activity-only")
        if c_day is not None and a_count is None and date not in absent_a:
            flags.append("consumption-only")
        if c_day is not None:
            if c_day.get("blind"):
                flags.append("BLIND")
            if c_day.get("partial"):
                flags.append("partial")
            row["inEq"] = round(ineq(c_day), 3)
        if a_count is not None and c_day is not None:
            if date == today and source.startswith("fragment"):
                flags.append("partial")
            if (source == "graphql" or source.startswith("graphql")) and date == to_day:
                # a GraphQL window is exclusive of `to` — not measured there,
                # so no activity number to ratio (never a zero).
                flags.append("activity-absent")
            flags = sorted(set(flags))
        if a_count is not None:
            row["contributions"] = a_count
        blocked = any(f in flags for f in
                      ("BLIND", "partial", "activity-absent", "activity-only",
                       "consumption-only"))
        if (a_count is not None and c_day is not None and row["inEq"]
                and not blocked):
            row["ratio"] = round(a_count / (row["inEq"] / 1000.0), 4)
        row["flags"] = flags
        rows.append(row)
    return {"source": SOURCE_LABELS.get(source, source or "inconnue"),
            "window": {"from": activity.get("from"), "to": to_day},
            "rows": rows}


def render_text(joined):
    w = joined["window"]
    flagged = sum(1 for r in joined["rows"] if r["flags"])
    ratio_rows = [r for r in joined["rows"] if r["ratio"] is not None]
    print(f"source: {joined['source']} | fenetre: {w['from']} -> {w['to']}")
    print(f"{'date':12} {'contrib':>8} {'inEq':>12} {'contrib/k-inEq':>15}  flags")
    print("-" * 66)
    for r in joined["rows"]:
        contrib = "" if r["contributions"] is None else str(r["contributions"])
        ineq_s = "" if r["inEq"] is None else f"{r['inEq']:,.0f}"
        ratio_s = "" if r["ratio"] is None else f"{r['ratio']:.4f}"
        flags = ",".join(r["flags"]) if r["flags"] else "-"
        print(f"{r['date']:12} {contrib:>8} {ineq_s:>12} {ratio_s:>15}  {flags}")
    print("-" * 66)
    print(f"lignes: {len(joined['rows'])} | ratio rendus: {len(ratio_rows)} | "
          f"lignes marquees: {flagged}")
    print("lecture: un jour marque n'est jamais ratio — absent/blind/partial "
          "nomment un non-mesure, pas un zero.")
    if not ratio_rows:
        print("attention: aucun jour ratio-able dans la fenetre (barometre "
              "aveugle, pas un resultat).")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--activity", required=True, help="github-activity.py --json output")
    ap.add_argument("--consumption", required=True, help="per-day consumption JSON")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    activity = load_json(args.activity, "activite")
    consumption = load_json(args.consumption, "consommation")
    if "days" not in activity or "days" not in consumption:
        sys.stderr.write("activity-cost-join: une entree n'a pas de cle `days` "
                         "— lecture aveugle, aucun rapport.\n")
        sys.exit(2)
    joined = join(activity, consumption)
    if not joined["rows"]:
        sys.stderr.write("activity-cost-join: aucune date joignable — "
                         "lecture aveugle, aucun rapport.\n")
        sys.exit(2)
    if args.json:
        print(json.dumps(joined, ensure_ascii=False, indent=2))
    else:
        render_text(joined)


if __name__ == "__main__":
    main()