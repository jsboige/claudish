#!/usr/bin/env python3
"""Pins for the activity x cost join (#1161 stage 2, recipe c.7093.../#1161).

The join reads two JSON files and must never fabricate a ratio:
  P1  normal day -> inEq exact (1.25*cc + 0.1*cr + 5*out) and the ratio rendered
  P2  activity-only / consumption-only days are flagged, never ratio'd
  P3  an absent activity day (coverage.absent) is `activity-absent`, not zero
  P4  a blind consumption day is BLIND with no ratio
  P5  partial is surfaced: consumption.partial, and the current day under the fragment
  P6  a graphql window is exclusive of `to` -> `activity-absent` there, not zero
  P7  blind read: missing `days` or zero joinable dates -> exit 2, no stdout report
  P8  --json shape carries source, window, rows with flags
  P9  #1180: a consumption document that declares `coverage.uncovered` roots was
      read from half the corpus -> every day `partial`, no ratio, cause named

Run: python scripts/tests/test_activity_cost_join.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_TOOL = os.path.join(_HERE, "..", "activity-cost-join.py")

spec = importlib.util.spec_from_file_location("activity_cost_join", _TOOL)
acj = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acj)

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def act(days, source="fragment", absent=(), to="2026-11-22"):
    return {"source": source, "from": "2026-11-16", "to": to,
            "coverage": {"covered": len(days), "span_days": 7,
                         "absent": list(absent)},
            "days": [{"date": d, "count": c} for d, c in days.items()]}


def con(days):
    return {"days": days}


def row(joined, date):
    for r in joined["rows"]:
        if r["date"] == date:
            return r
    raise AssertionError(f"no row {date}")


def run_cli(tmp, activity, consumption, as_json=False):
    ap = os.path.join(tmp, "a.json")
    cp = os.path.join(tmp, "c.json")
    with open(ap, "w", encoding="utf-8") as fh:
        json.dump(activity, fh)
    with open(cp, "w", encoding="utf-8") as fh:
        json.dump(consumption, fh)
    argv = [sys.executable, "-I", _TOOL,
            "--activity", ap, "--consumption", cp]
    if as_json:
        argv.append("--json")
    return subprocess.run(argv, capture_output=True, text=True)


def main():
    print("P1 — jour normal, inEq exact et ratio rendu")
    j = acj.join(act({"2026-11-20": 12}),
                 con([{"date": "2026-11-20", "cache_create": 1000,
                       "cache_read": 40000, "out": 200}]),
                 today="2026-11-23")
    r = row(j, "2026-11-20")
    # 1.25*1000 + 0.1*40000 + 5*200 = 1250 + 4000 + 1000 = 6250
    check("inEq formule recette", r["inEq"] == 6250.0, r["inEq"])
    check("ratio = contrib / (inEq/1000)", r["ratio"] == round(12 / 6.25, 4), r["ratio"])
    check("aucun flag", r["flags"] == [], r["flags"])

    print("P2 — jours d'un seul cote : marques, jamais ratios")
    j = acj.join(act({"2026-11-20": 12}),
                 con([{"date": "2026-11-21", "out": 100}]),
                 today="2026-11-23")
    r20 = row(j, "2026-11-20")
    check("activity-only marque", r20["flags"] == ["activity-only"], r20["flags"])
    check("activity-only sans ratio", r20["ratio"] is None)
    r21 = row(j, "2026-11-21")
    check("consumption-only marque", r21["flags"] == ["consumption-only"], r21["flags"])
    check("consumption-only sans ratio", r21["ratio"] is None)

    print("P3 — jour absent cote activite = non mesure, pas zero")
    j = acj.join(act({"2026-11-20": 12}, absent=["2026-11-19"]),
                 con([{"date": "2026-11-19", "out": 100},
                      {"date": "2026-11-20", "out": 4}]),
                 today="2026-11-23")
    r = row(j, "2026-11-19")
    check("activity-absent marque", "activity-absent" in r["flags"], r["flags"])
    check("activity-absent sans contributions", r["contributions"] is None)

    print("P4 — jour aveugle cote consommation : BLIND, sans ratio")
    j = acj.join(act({"2026-11-20": 12}),
                 con([{"date": "2026-11-20", "out": 100, "blind": True}]),
                 today="2026-11-23")
    r = row(j, "2026-11-20")
    check("BLIND marque", "BLIND" in r["flags"], r["flags"])
    check("BLIND sans ratio", r["ratio"] is None)

    print("P5 — partial est rendu, jamais ratio en silence")
    j = acj.join(act({"2026-11-20": 12}),
                 con([{"date": "2026-11-20", "out": 100, "partial": True}]),
                 today="2026-11-23")
    check("partial consommation", "partial" in row(j, "2026-11-20")["flags"])
    # AC #1161 stage-2 (b) : une consommation partiale ne se ratio PAS en
    # silence — le drapeau seul ne suffirait pas si un ratio sortait quand meme.
    check("partial consommation sans ratio", row(j, "2026-11-20")["ratio"] is None)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    j = acj.join(act({today: 3}), con([{"date": today, "out": 10}]))
    r = row(j, today)
    check("jour courant fragment = partial", "partial" in r["flags"], r["flags"])
    check("jour courant sans ratio", r["ratio"] is None)

    print("P6 — fenetre graphql exclusive de `to` : activity-absent, pas zero")
    j = acj.join(act({"2026-11-20": 12, "2026-11-22": 5}, source="graphql"),
                 con([{"date": "2026-11-20", "out": 4},
                      {"date": "2026-11-22", "out": 4}]),
                 today="2026-11-23")
    check("to exclu marque", "activity-absent" in row(j, "2026-11-22")["flags"],
          row(j, "2026-11-22")["flags"])
    check("to exclu sans ratio", row(j, "2026-11-22")["ratio"] is None)
    check("jour plein ratio", row(j, "2026-11-20")["ratio"] is not None)

    print("P7 — lecture aveugle : exit 2, aucun rapport")
    with tempfile.TemporaryDirectory() as tmp:
        p = run_cli(tmp, {"nodays": True}, con([{"date": "2026-11-20", "out": 1}]))
        check("entree sans days -> exit 2", p.returncode == 2, p.returncode)
        check("stderr nomme la lecture aveugle", "aveugle" in p.stderr.lower(),
              p.stderr[:120])
        check("stdout vide", p.stdout.strip() == "")
        p = run_cli(tmp, act({}), con([]))
        check("zero date joignable -> exit 2", p.returncode == 2, p.returncode)

    print("P8 — sortie --json : source, fenetre, lignes, flags")
    with tempfile.TemporaryDirectory() as tmp:
        p = run_cli(tmp, act({"2026-11-20": 12}),
                    con([{"date": "2026-11-20", "out": 100}]), as_json=True)
        check("exit 0", p.returncode == 0, p.stderr[:200])
        payload = json.loads(p.stdout)
        check("source nommee", payload["source"] == "fragment-anonyme", payload["source"])
        check("fenetre portee", payload["window"]["to"] == "2026-11-22")
        check("ligne porte date/inEq/flags",
              {"date", "contributions", "inEq", "ratio", "flags"}
              <= set(payload["rows"][0]))
        p = run_cli(tmp, act({"2026-11-20": 12}),
                    con([{"date": "2026-11-20", "out": 100}]))
        text = p.stdout
        check("texte nomme la source", "fragment-anonyme" in text)

    print("P9 — #1180 (review ai-01, finding 2) : un document lu d'un demi-corpus "
          "ne se ratio pas")
    day = {"date": "2026-11-20", "out": 100}
    half = dict(con([day]),
                coverage={"requested": [r"\\hub\d$\captures", r"\\hub\c$\overflow"],
                          "covered": [r"\\hub\d$\captures"],
                          "uncovered": [r"\\hub\c$\overflow"]})
    j = acj.join(act({"2026-11-20": 12}), half, today="2026-11-23")
    r = row(j, "2026-11-20")
    check("jour du document marque partial, sans flag sur la ligne", r["flags"] == ["partial"], r["flags"])
    check("aucun ratio rendu", r["ratio"] is None, r)
    check("inEq reste rendu (la mesure partielle se lit, elle ne se ratio pas)",
          r["inEq"] == 500.0, r["inEq"])
    check("la cause est nommee : 1 racine non lue", j["uncovered_roots"] == 1, j["uncovered_roots"])
    whole = dict(con([day]), coverage={"requested": [r"\\hub\d$\captures"],
                                       "covered": [r"\\hub\d$\captures"], "uncovered": []})
    j = acj.join(act({"2026-11-20": 12}), whole, today="2026-11-23")
    check("couverture entiere (uncovered vide) : ratio rendu, 0 racine non lue",
          row(j, "2026-11-20")["ratio"] is not None and j["uncovered_roots"] == 0, row(j, "2026-11-20"))
    j = acj.join(act({"2026-11-20": 12}), con([day]), today="2026-11-23")
    check("sans cle coverage (un fichier de serie) : inchange",
          row(j, "2026-11-20")["ratio"] is not None and j["uncovered_roots"] == 0, row(j, "2026-11-20"))
    for label, odd in (("liste", ["x"]), ("nombre", 3), ("cle inattendue", {"covered": 5})):
        j = acj.join(act({"2026-11-20": 12}), dict(con([day]), coverage=odd), today="2026-11-23")
        check(f"coverage de forme inattendue ({label}) : pas de crash, pas de refus invente",
              row(j, "2026-11-20")["ratio"] is not None and j["uncovered_roots"] == 0,
              (row(j, "2026-11-20")["flags"], j["uncovered_roots"]))
    with tempfile.TemporaryDirectory() as tmp:
        p = run_cli(tmp, act({"2026-11-20": 12}), half)
        check("texte : la cause est nommee", "1 racine(s) du corpus declaree(s) non lue(s)" in p.stdout,
              p.stdout[-300:])
        p = run_cli(tmp, act({"2026-11-20": 12}), whole)
        check("texte : rien d'ajoute quand la couverture est entiere",
              "racine(s) du corpus" not in p.stdout, p.stdout[-300:])

    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} pin(s): {', '.join(FAILS)}")
        return 1
    print("ALL PINS GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())