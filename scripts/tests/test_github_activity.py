#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pins pour github-activity.py (#1161, stage 1).

Chaque pin defend une lecture qu'une implementation plausible obtient FAUX :

  1. DECOUPE — les tranches de <= 366 jours couvrent la fenetre SANS trou ni
     recouvrement (un jour compte une fois, un trou sous-compte).
  2. BORNES INCLUSIVES — une fenetre de 7 jours fait 7 jours, pas 6.
  3. CLIP DES SEMAINES DEBORDANTES — GitHub rend des semaines pleines : un
     jour avant la borne demandee est EXCLU du total fenetre (sinon deux
     fenetres adjacentes comptent deux fois le jour de couture).
  4. FUSION MULTI-TRANCHES — jours dedupliques par date, totaux SOMMES.
  5. DEGRADATION BRUYANTE — erreur GraphQL, user null, non-JSON : ValueError
     avec le detail. Jamais un rapport vide qui se lirait « zero activite ».
  6. RENDU — total, moyenne/jour, ligne tendance 7 j seulement quand la
     fenetre la permet (jamais de tendance fabriquee sur 5 jours).

Run: python scripts/tests/test_github_activity.py
"""

import importlib.util
import json
import os
import sys
from datetime import date, timedelta

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ga = _load("github_activity", os.path.join(_HERE, "..", "github-activity.py"))

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def resp(days, cal_total=None, **totals):
    """Reponse GraphQL façon gh api graphql — clés littérales du serveur."""
    cal_total = cal_total if cal_total is not None else sum(days.values())
    body = {
        "data": {"user": {"login": "x", "contributionsCollection": {
            "contributionCalendar": {
                "totalContributions": cal_total,
                "weeks": [
                    {"contributionDays": [
                        {"date": d, "contributionCount": c}
                        for d, c in sorted(days.items())
                    ]}]},
            "totalCommitContributions": totals.get("commit", 0),
            "totalPullRequestContributions": totals.get("pr", 0),
            "totalIssueContributions": totals.get("issue", 0),
            "totalPullRequestReviewContributions": totals.get("review", 0),
            "totalRepositoryContributions": totals.get("repo", 0),
        }}},
    }
    return json.dumps(body)


print("window_chunks — couverture sans trou ni recouvrement")
chunks = ga.window_chunks(date(2026, 1, 1), date(2026, 1, 30))
check("30 jours = 1 tranche", len(chunks) == 1, f"(got {len(chunks)})")
check("bornes inclusives (7 jours font 7 jours)",
      (ga.window_chunks(date(2026, 1, 1), date(2026, 1, 7))[0][1]
       - ga.window_chunks(date(2026, 1, 1), date(2026, 1, 7))[0][0]).days == 6)
chunks2 = ga.window_chunks(date(2024, 1, 1), date(2026, 3, 15))
covered = []
for a, b in chunks2:
    check_len = (b - a).days + 1 <= 366
    if not check_len:
        check("tranche <= 366 jours", False, f"({a} -> {b})")
    covered.extend([a + timedelta(days=n) for n in range((b - a).days + 1)])
check("multi-annee couverte sans trou ni doublon",
      len(covered) == len(set(covered)) == (date(2026, 3, 15) - date(2024, 1, 1)).days + 1,
      f"({len(covered)} jours, {len(set(covered))} uniques)")

print("parse_response — extraction et degradation bruyante")
r = ga.parse_response(resp({"2026-11-20": 5, "2026-11-21": 7}, commit=5, pr=7))
check("jours extraits", [d["date"] for d in r["days"]] == ["2026-11-20", "2026-11-21"])
check("totaux par type extraits", r["totals"]["totalCommitContributions"] == 5
      and r["totals"]["totalPullRequestContributions"] == 7)
for name, text in (
    ("erreur GraphQL remonte le message",
     json.dumps({"errors": [{"message": "rate limit exceeded"}]})),
    ("user null (login inconnu) remonte",
     json.dumps({"data": {"user": None}})),
    ("non-JSON remonte", "<html>502</html>"),
):
    try:
        ga.parse_response(text)
        check(name, False, "(aucune exception)")
    except ValueError as exc:
        check(name, len(str(exc)) > 0, f"(message vide)")

print("merge_reports — clip des semaines debordantes + fusion")
# La semaine GraphQL deborde avant la borne : 2026-10-31 est hors fenetre.
r1 = ga.parse_response(resp({"2026-10-31": 100, "2026-11-01": 10,
                             "2026-11-02": 20}, commit=30))
m = ga.merge_reports([r1], date(2026, 11, 1), date(2026, 11, 2))
check("jour d'avant-veille de borne exclu du total fenetre",
      m["sum_days"] == 30, f"(got {m['sum_days']})")
check("le jour exclu n'est pas dans days",
      [d["date"] for d in m["days"]] == ["2026-11-01", "2026-11-02"])
# Deux tranches : le jour de couture ne compte pas deux fois.
r2 = ga.parse_response(resp({"2026-11-03": 40, "2026-11-04": 50}, pr=90))
m2 = ga.merge_reports([r1, r2], date(2026, 11, 1), date(2026, 11, 4))
check("fusion multi-tranches : total somme, jours uniques",
      m2["sum_days"] == 120 and len(m2["days"]) == 4,
      f"(total {m2['sum_days']}, {len(m2['days'])} jours)")
check("totaux par type sommes entre tranches",
      m2["totals"]["totalCommitContributions"] == 30
      and m2["totals"]["totalPullRequestContributions"] == 90)
check("span_days = fenetre demandee, pas les semaines rendues",
      m2["span_days"] == 4, f"(got {m2['span_days']})")

print("render_text — total, moyenne, tendance honnete")
rep14 = {"days": [{"date": f"2026-11-{d:02d}", "count": 10} for d in range(1, 15)],
         "calendar_total": 999, "totals": {f: 0 for f in ga.TOTAL_FIELDS},
         "sum_days": 140, "span_days": 14}
out = ga.render_text("jsboige", date(2026, 11, 1), date(2026, 11, 14), rep14, 1)
check("total et moyenne/jour rendus", "140" in out and "10/j" in out, f"(got {out!r})")
check("tendance 7 j rendue quand >= 14 jours", "7 derniers jours: 70" in out)
rep5 = {"days": [{"date": f"2026-11-{d:02d}", "count": 10} for d in range(1, 6)],
        "calendar_total": 50, "totals": {f: 0 for f in ga.TOTAL_FIELDS},
        "sum_days": 50, "span_days": 5}
out5 = ga.render_text("jsboige", date(2026, 11, 1), date(2026, 11, 5), rep5, 1)
check("pas de tendance fabriquee sur 5 jours", "7 derniers jours" not in out5)

print()
if FAILS:
    print(f"FAILED: {len(FAILS)} -> {FAILS}")
    sys.exit(1)
print("all pins green")
