#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Activite GitHub d'un profil, sans rendre la page de 50 k items (#1161).

La page https://github.com/<login> est devenue illisible pour un profil
dense (50 607 contributions mesurees sur un an, fragment /contributions a
223 Ko / ~7,7 s) : le navigateur paie le rendu, pas la donnee. Cet
instrument lit la MEME donnee par le chemin leger :

  GraphQL contributionsCollection — 1 appel par fenetre <= 366 jours,
  jours individuels + totaux par type (commit / PR / issue / review / repo),
  via le token flotte (`gh api graphql`). Aucun scraping de page, aucun
  crawler au-dela du token existant (conditions d'arret #1161).

Degradation BRUYANTE : quota GraphQL epuise, reponse malformee, login
inconnu -> message exact sur stderr + exit non nul. Jamais de rapport vide
qui se lirait « zero activite ».

Stage 2 (#1161) — la recette de jointure avec la consommation providers :
  github-activity.py --json  ->  jours [{date, count}]
  traffic-consumption.py / native-consumption.py (fenetre alignee)
  ->  activite_par_cout[jour] = contributions[jour] / inEq[jour]
  Le rapport par jour sert aux coordinateurs a qualifier un rendement de
  methode (chute d'activite a consommation constante = derive a explorer),
  exactement comme la consommation seule sert a borser le cout.

Usage:
  python scripts/github-activity.py                      # 30 derniers jours
  python scripts/github-activity.py --days 7
  python scripts/github-activity.py --year 2026          # annee civile
  python scripts/github-activity.py --from 2026-11-01 --to 2026-11-22
  python scripts/github-activity.py --json               # mode machine
"""

import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone

DEFAULT_LOGIN = "jsboige"   # proprietaire de l'org flotte (jsboige/claudish)

QUERY = """
query($login:String!,$from:DateTime!,$to:DateTime!) {
  user(login:$login) {
    login
    contributionsCollection(from:$from,to:$to) {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      totalRepositoryContributions
    }
  }
}
"""

TOTAL_FIELDS = (
    "totalCommitContributions",
    "totalPullRequestContributions",
    "totalIssueContributions",
    "totalPullRequestReviewContributions",
    "totalRepositoryContributions",
)


def window_chunks(d_from, d_to, max_days=366):
    """Decoupe [d_from, d_to] en tranches <= max_days (limite GitHub par appel).

    Retourne une liste de (date, date) INCLUSIFS aux deux bornes.
    """
    chunks = []
    cur = d_from
    while cur <= d_to:
        end = min(cur + timedelta(days=max_days - 1), d_to)
        chunks.append((cur, end))
        cur = end + timedelta(days=1)
    return chunks


def parse_response(text):
    """Extrait jours + totaux d'une reponse GraphQL (texte JSON brut).

    Echoue BRUYAMMENT (ValueError avec le detail) sur : erreur GraphQL,
    login inconnu (user: null), champ manquant. Une reponse sans
    contributionCalendar n'est pas « zero activite », c'est une reponse
    qu'on n'a pas su lire.
    """
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"reponse GraphQL non-JSON: {exc}")
    if "errors" in data:
        msgs = "; ".join(e.get("message", "?") for e in data["errors"])
        raise ValueError(f"erreur GraphQL: {msgs}")
    user = (data.get("data") or {}).get("user")
    if user is None:
        raise ValueError("user: null — login inconnu ou non visible par le token")
    cc = user.get("contributionsCollection")
    if not cc:
        raise ValueError("contributionsCollection absent de la reponse")
    cal = cc.get("contributionCalendar") or {}
    days = []
    for week in cal.get("weeks") or []:
        for day in week.get("contributionDays") or []:
            days.append({"date": day["date"],
                         "count": int(day["contributionCount"])})
    totals = {f: int(cc.get(f) or 0) for f in TOTAL_FIELDS}
    return {"calendar_total": int(cal.get("totalContributions") or 0),
            "days": days, "totals": totals}


def merge_reports(reports, d_from, d_to):
    """Fusionne les tranches : jours dedupliques par date, bornes incluses.

    Les semaines partielles de GitHub debordent la fenetre demandee — le
    clip est ICI, une seule fois, pas dans le rendu.
    """
    by_date = {}
    calendar_total = 0
    totals = {f: 0 for f in TOTAL_FIELDS}
    for rep in reports:
        for day in rep["days"]:
            if d_from.isoformat() <= day["date"] <= d_to.isoformat():
                by_date[day["date"]] = day["count"]
        calendar_total += rep["calendar_total"]
        for f in TOTAL_FIELDS:
            totals[f] += rep["totals"][f]
    days = [{"date": d, "count": by_date[d]} for d in sorted(by_date)]
    span_days = (d_to - d_from).days + 1
    return {"days": days, "calendar_total": calendar_total, "totals": totals,
            "sum_days": sum(by_date.values()), "span_days": span_days}


def render_text(login, d_from, d_to, rep, calls):
    total = rep["sum_days"]
    n_days = len(rep["days"])
    active = sum(1 for d in rep["days"] if d["count"])
    lines = [
        f"{login} | {d_from} -> {d_to} ({rep['span_days']} j, {calls} appel(s) GraphQL)",
        f"contributions fenetre: {total:,} ({total / max(1, rep['span_days']):.0f}/j ; "
        f"{active} j actifs / {rep['span_days']})",
        f"calendrier GitHub (semaines debordantes comprises): {rep['calendar_total']:,}",
        " | ".join(f"{k.replace('total', '').replace('Contributions', '').lower()}: "
                   f"{v:,}" for k, v in rep["totals"].items()),
    ]
    top = sorted(rep["days"], key=lambda d: -d["count"])[:5]
    if top:
        lines.append("top jours: " + " | ".join(f"{d['date']} {d['count']}" for d in top))
    # 7 jours glissants final — le coordinateur regarde la tendance, pas le mur
    if n_days >= 7:
        last7 = sum(d["count"] for d in rep["days"][-7:])
        prev7 = sum(d["count"] for d in rep["days"][-14:-7]) if n_days >= 14 else None
        trend = ""
        if prev7 is not None:
            delta = last7 - prev7
            trend = f" (7 j precedent: {prev7:,}, {delta:+,})"
        lines.append(f"7 derniers jours: {last7:,}{trend}")
    return "\n".join(lines)


def gh_graphql(login, d_from, d_to):
    """Un appel gh api graphql pour la tranche. Bruyant si echec."""
    proc = subprocess.run(
        ["gh", "api", "graphql",
         "-F", f"login={login}",
         "-F", f"from={d_from.isoformat()}T00:00:00Z",
         "-F", f"to={d_to.isoformat()}T23:59:59Z",
         "-F", f"query={QUERY}"],
        capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        sys.stderr.write(f"gh api graphql a echoue (rc={proc.returncode}): "
                         f"{proc.stderr.strip()[:400]}\n")
        sys.exit(2)
    return proc.stdout


def main():
    args = sys.argv[1:]
    login = DEFAULT_LOGIN
    d_from = d_to = None
    as_json = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--login" and i + 1 < len(args):
            login = args[i + 1]; i += 2
        elif a == "--days" and i + 1 < len(args):
            n = int(args[i + 1]); i += 2
            today = datetime.now(timezone.utc).date()
            d_to = today
            d_from = today - timedelta(days=n - 1)
        elif a == "--year" and i + 1 < len(args):
            y = int(args[i + 1]); i += 2
            d_from = datetime(y, 1, 1).date()
            d_to = min(datetime(y, 12, 31).date(),
                       datetime.now(timezone.utc).date())
        elif a == "--from" and i + 1 < len(args):
            d_from = datetime.strptime(args[i + 1], "%Y-%m-%d").date(); i += 2
        elif a == "--to" and i + 1 < len(args):
            d_to = datetime.strptime(args[i + 1], "%Y-%m-%d").date(); i += 2
        elif a == "--json":
            as_json = True; i += 1
        else:
            sys.stderr.write(f"argument inconnu: {a}\n")
            sys.exit(64)
    today = datetime.now(timezone.utc).date()
    if d_to is None:
        d_to = today
    if d_from is None:
        d_from = d_to - timedelta(days=29)
    if d_from > d_to:
        sys.stderr.write(f"fenetre inversee: {d_from} > {d_to}\n")
        sys.exit(64)
    d_to = min(d_to, today)  # le futur n'a pas de contributions mesurables

    reports = []
    try:
        for c_from, c_to in window_chunks(d_from, d_to):
            reports.append(parse_response(gh_graphql(login, c_from, c_to)))
    except ValueError as exc:
        # Bruyant et lisible : pas de traceback, pas de rapport vide.
        sys.stderr.write(f"github-activity: {exc}\n")
        sys.exit(2)
    rep = merge_reports(reports, d_from, d_to)

    if as_json:
        print(json.dumps({"login": login, "from": d_from.isoformat(),
                          "to": d_to.isoformat(), "calls": len(reports),
                          "span_days": rep["span_days"],
                          "total": rep["sum_days"],
                          "calendar_total": rep["calendar_total"],
                          "totals": rep["totals"], "days": rep["days"]},
                         ensure_ascii=False))
    else:
        print(render_text(login, d_from, d_to, rep, len(reports)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
