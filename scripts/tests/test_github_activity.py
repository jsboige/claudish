#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pins pour github-activity.py (#1161) — chemin fragment anonyme par defaut.

Chaque pin defend une lecture qu'une implementation plausible obtient FAUX :

  1. LE COMPTE VIT DANS LE TOOL-TIP jume (for=<id> <-> id=<id>), pas dans le
     <td> : « No contributions » = 0, « 1 contribution » singulier, « 1,234
     contributions » virgule de milliers, balise interne dans le tip.
  2. L'ORDRE DES ATTRIBUTS du <td> n'est pas garanti (mesure : data-date
     AVANT id sur le fragment reel) — chaque attribut est cherche libre.
  3. AUTO-CONTROLE H2 : la somme parsee est confrontee au total du MEME
     fragment — ecart > 0,5 % rendu, jamais silencieux.
  4. DEGRADATION BRUYANTE — un fragment sans jour lisible (structure
     GitHub changee), une erreur GraphQL, user null : message exact.
     Jamais un rapport vide qui se lirait « zero activite ».
  5. FENETRES — annees civiles chevauchantes fusionnees, jours dedupliques,
     clip aux bornes demandees (fenetres adjacentes sans double-compte).
  6. PAGE HTML — auto-suffisante : donnees embarquees, AUCUN http(s) dans
     src/href a l'ouverture ; la cellule porte son compte en title ;
     le warning d'ecart H2 est rendu.
  7. SOURCE — le chemin defaut est fragment-anonyme (zero quota GraphQL) ;
     les totaux par type n'existent QUE sur --graphql, dit tel quel.
  8. REPLI FENETRE — sans argument de fenetre : annee glissante ; avec
     --days 1 : 1 jour (le repli ne l'avale pas).
  9. COUVERTURE (CR #1162) — un jour que le fragment ne rend pas est
     ABSENT, jamais « 0 contribution » : il est nomme, ni actif ni
     inactif, et une couverture nulle sort en exit 2 sans rapport.
 10. TENDANCE — les N derniers jours CALENDAIRES ; un trou dans la
     fenetre supprime la somme au lieu d'additionner autour, un trou plus
     ancien retire la comparaison.

GHA_MODULE=<autre revision> rejoue ces pins contre un autre script (preuve
qu'un pin est rouge sur l'ancien).

Run: python scripts/tests/test_github_activity.py
"""

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# GHA_MODULE permet de rejouer CES pins contre une autre revision du script —
# c'est ainsi qu'on prouve qu'un pin est ROUGE sur l'ancien (mutations, CR).
ga = _load("github_activity",
           os.environ.get("GHA_MODULE")
           or os.path.join(_HERE, "..", "github-activity.py"))

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def td(day, level, count_text, order="date-first"):
    """Une cellule + son tool-tip jume, ordre d'attributs parametrable."""
    cid = f"contribution-day-component-0-{day.replace('-', '')[-4:]}"
    if order == "date-first":          # ordre mesure sur le fragment reel
        tag = (f'<td tabindex="0" data-ix="0" data-date="{day}" '
               f'id="{cid}" data-level="{level}" role="gridcell" '
               f'class="ContributionCalendar-day"></td>')
    else:                              # variante id-first
        tag = (f'<td tabindex="0" id="{cid}" data-date="{day}" '
               f'data-level="{level}" role="gridcell" '
               f'class="ContributionCalendar-day"></td>')
    tip = (f'<tool-tip for="{cid}" data-direction="n">{count_text}</tool-tip>')
    return tag + tip


FRAG = (
    '<h2 id="js-contribution-activity-description" class="f4">\n'
    '      1,235\n'
    '      contributions\n        in the last year\n    </h2>\n'
    + td("2026-11-18", 0, "No contributions on November 18th.")
    + td("2026-11-19", 1, "1 contribution on November 19th.")
    + td("2026-11-20", 4, "1,234 contributions on November 20th.",
         order="id-first")
    # tool-tip avec balise interne + cellule sans tool-tip (exclue)
    + '<td data-date="2026-11-21" id="contribution-day-component-1-0" '
      'data-level="2" class="ContributionCalendar-day"></td>'
    + '<tool-tip for="contribution-day-component-1-0">'
      '<b>400</b> contributions on November 21st.</tool-tip>'
    + '<td data-date="2026-11-22" id="contribution-day-component-1-1" '
      'data-level="0" class="ContributionCalendar-day"></td>'
)

print("parse_fragment — le compte vit dans le tool-tip jume")
p = ga.parse_fragment(FRAG)
check("zero / singulier / virgule de milliers / balise interne",
      p["days"] == {"2026-11-18": 0, "2026-11-19": 1, "2026-11-20": 1234,
                    "2026-11-21": 400},
      f"(got {p['days']})")
check("cellule sans tool-tip exclue (pas un 0 fabrique)",
      "2026-11-22" not in p["days"])
check("niveaux extraits (couleur de page)", p["levels"]["2026-11-20"] == 4)
check("total H2 extrait (virgule de milliers)", p["h2_total"] == 1235,
      f"(got {p['h2_total']})")

print("crosscheck_h2 — auto-controle du fragment contre lui-meme")
w = ga.crosscheck_h2({"days": {"a": 1235}, "h2_total": 1235})
check("exactitude rendue ok", w["ok"] and w["rel"] == 0)
w2 = ga.crosscheck_h2({"days": {"a": 1000}, "h2_total": 1235})
check("ecart > 0,5 % rendu PAS ok (jamais silencieux)",
      not w2["ok"] and w2["rel"] > 0.005)
check("H2 absent -> pas de faux verdict", ga.crosscheck_h2({"days": {}, "h2_total": None}) is None)

print("parse_fragment — degradation bruyante")
try:
    ga.parse_fragment("<html>502 Bad Gateway</html>")
    check("fragment illisible -> ValueError", False, "(aucune exception)")
except ValueError as exc:
    check("fragment illisible -> ValueError nomme la cause", "sans jour" in str(exc))

print("parse_response (GraphQL) — extraction et degradation")
GQ = json.dumps({"data": {"user": {"contributionsCollection": {
    "contributionCalendar": {"totalContributions": 3, "weeks": [
        {"contributionDays": [
            {"date": "2026-11-01", "contributionCount": 2},
            {"date": "2026-11-02", "contributionCount": 1}]}]},
    "totalCommitContributions": 2, "totalPullRequestContributions": 1,
    "totalIssueContributions": 0, "totalPullRequestReviewContributions": 0,
    "totalRepositoryContributions": 0}}}})
r = ga.parse_response(GQ)
check("jours + totaux par type extraits",
      r["days"] == {"2026-11-01": 2, "2026-11-02": 1}
      and r["totals"]["totalCommitContributions"] == 2)
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
        check(name, len(str(exc)) > 0, "(message vide)")

print("fenetres — annees civiles, fusion, clip")
check("annees chevauchantes",
      ga.years_spanning(date(2025, 12, 1), date(2026, 1, 31)) == [2025, 2026])
frag_a = {"days": {"2025-12-30": 5, "2025-12-31": 6, "2026-01-01": 7},
          "levels": {"2025-12-30": 1}}
frag_b = {"days": {"2026-01-01": 7, "2026-01-02": 8}, "levels": {}}
merged = ga.merge_parsed({2025: frag_a, 2026: frag_b},
                         date(2025, 12, 31), date(2026, 1, 1))
check("clip aux bornes + dedoublonne par date",
      merged["days"] == {"2025-12-31": 6, "2026-01-01": 7},
      f"(got {merged['days']})")
check("totaux par type absents du chemin fragment", merged["totals"] is None)
gq_parsed = ga.parse_response(GQ)
merged_gq = ga.merge_parsed({None: gq_parsed}, date(2026, 11, 1), date(2026, 11, 2))
check("totaux portes par la source graphql",
      merged_gq["totals"]["totalPullRequestContributions"] == 1)
s = ga.summarize(merged["days"], date(2025, 12, 31), date(2026, 1, 1))
check("sommaire : somme + fenetre inclusive + actifs",
      s["sum"] == 13 and s["span_days"] == 2 and s["active"] == 2,
      f"(got {s})")

print("render_text — source dite, totaux absents dits")
s14 = ga.summarize({f"2026-11-{d:02d}": 100 for d in range(9, 23)},
                   date(2026, 11, 9), date(2026, 11, 22))
out = ga.render_text("jsboige", date(2026, 11, 9), date(2026, 11, 22),
                     s14, "fragment-anonyme", None, None)
check("source fragment affichee", "source: fragment-anonyme" in out)
check("absence de totaux par type dite (--graphql nomme)",
      "--graphql" in out)
s_empty = ga.summarize({}, date(2026, 1, 1), date(2026, 1, 2))
out_w = ga.render_text("x", date(2026, 1, 1), date(2026, 1, 2), s_empty,
                       "fragment-anonyme", None,
                       {"parsed": 100, "h2": 150, "rel": 0.33, "ok": False})
check("ecart H2 rendu avec mise en garde", "MEFIE-TOI" in out_w and "33.00%" in out_w)

print("render_html — page auto-suffisante")
s_h = ga.summarize({"2026-11-20": 1234}, date(2026, 11, 16), date(2026, 11, 22))
page = ga.render_html("jsboige", date(2026, 11, 16), date(2026, 11, 22),
                      s_h, {"2026-11-20": 4}, "fragment-anonyme",
                      {"parsed": 1234, "h2": 1234, "rel": 0.0, "ok": True},
                      "2026-11-22 18:00 UTC")
check("cellule datée avec compte en title",
      'title="2026-11-20: 1234"' in page)
check("aucune ressource externe a l'ouverture",
      "http://" not in page and "https://" not in page)
check("exactitude H2 rendue", "exact" in page)
page_w = ga.render_html("x", date(2026, 1, 1), date(2026, 1, 2),
                        ga.summarize({}, date(2026, 1, 1), date(2026, 1, 2)),
                        {}, "fragment-anonyme",
                        {"parsed": 100, "h2": 150, "rel": 0.33, "ok": False},
                        "t")
check("warning d'ecart rendu dans la page", "ecart 33.00%" in page_w)

print("couverture — un jour ABSENT n'est pas un jour a zero (CR #1162)")
# Fenetre 17->23/11 ; le 19 est absent ; le 18 a REELLEMENT zero contribution.
part = {"2026-11-17": 100, "2026-11-18": 0, "2026-11-20": 200,
        "2026-11-21": 300, "2026-11-22": 50, "2026-11-23": 10}
sc = ga.summarize(part, date(2026, 11, 17), date(2026, 11, 23))
check("couverture comptee : 6 lus / 7 demandes",
      sc.get("covered") == 6 and sc.get("span_days") == 7, f"(got {sc})")
check("le jour absent est nomme", sc.get("absent") == ["2026-11-19"],
      f"(got {sc.get('absent')})")
check("absent ni actif ni inactif : 5 actifs sur 6 lus (le 18 est un vrai zero)",
      sc.get("active") == 5, f"(got {sc.get('active')})")
out_c = ga.render_text("x", date(2026, 11, 17), date(2026, 11, 23), sc,
                       "fragment-anonyme", None, None)
check("ligne de couverture en texte, absent != 0",
      "couverture: 6/7" in out_c and "2026-11-19" in out_c
      and "absent != 0" in out_c, f"(got {out_c!r})")
page_c = ga.render_html("x", date(2026, 11, 17), date(2026, 11, 23), sc,
                        {}, "fragment-anonyme", None, "t")
check("page HTML : couverture dite + cellule de trou dessinee",
      "couverture : 6/7" in page_c and "absent (hors fragment)" in page_c)

print("tendance — jours CALENDAIRES, jamais de somme autour d'un trou")
full = {f"2026-11-{d:02d}": 10 for d in range(9, 23)}     # 14 jours pleins
tr_full = (ga.summarize(full, date(2026, 11, 9), date(2026, 11, 22))
           .get("trend") or {})
check("14 j pleins : 7 j = 70, precedent = 70",
      tr_full.get("complete") is True and tr_full.get("sum") == 70
      and tr_full.get("prev_sum") == 70, f"(got {tr_full})")
hole = {k: v for k, v in full.items() if k != "2026-11-19"}   # trou dans les 7 j
sh = ga.summarize(hole, date(2026, 11, 9), date(2026, 11, 22))
tr_hole = sh.get("trend") or {}
check("trou dans les 7 derniers -> somme nulle-part, le trou nomme",
      tr_hole.get("complete") is False and tr_hole.get("sum") is None
      and tr_hole.get("absent") == ["2026-11-19"], f"(got {tr_hole})")
out_h = ga.render_text("x", date(2026, 11, 9), date(2026, 11, 22), sh,
                      "fragment-anonyme", None, None)
check("texte : 'incomplet' + le trou, aucun chiffre de tendance",
      "7 derniers jours: incomplet" in out_h and "2026-11-19" in out_h,
      f"(got {out_h!r})")
old_hole = {k: v for k, v in full.items() if k != "2026-11-10"}  # trou anterieur
tr_old = (ga.summarize(old_hole, date(2026, 11, 9), date(2026, 11, 22))
          .get("trend") or {})
check("trou hors des 7 j : 7 j = 70, comparaison retiree (pas un faux delta)",
      tr_old.get("complete") is True and tr_old.get("sum") == 70
      and tr_old.get("prev_sum") is None, f"(got {tr_old})")

print("main — fenetres CLI, repli, degradation exit 2")
backup_fetch = ga.fetch_fragment
FETCH_CALLS = []


def _fake_fragment(login, year=None):
    """Fragment aujourd'hui-relatif : les pins de fenetre ne sont pas des
    bombes a retardement (une date fixe quitte la fenetre --days un jour).
    Enregistre chaque vue demandee (None = sans parametres)."""
    FETCH_CALLS.append((login, year))
    if login == "gone":
        raise ValueError("fragment HTTP 404 pour gone")
    today = datetime.now(timezone.utc).date()
    parts = ['<h2 id="js-contribution-activity-description">120 '
             'contributions in the last year</h2>']
    for n in range(10):
        d = (today - timedelta(days=n)).isoformat()
        parts.append(td(d, 3 if n % 2 else 1, f"{n + 1} contributions on x."))
    return ga.parse_fragment("".join(parts))


ga.fetch_fragment = _fake_fragment
argv_backup = sys.argv
try:
    out = io.StringIO()
    sys.argv = ["github-activity.py", "--days", "3", "--json"]
    with contextlib.redirect_stdout(out):
        rc = ga.main()
    d = json.loads(out.getvalue())
    check("exit 0, source fragment-anonyme, clip 3 jours",
          rc == 0 and d["source"] == "fragment-anonyme"
          and d["span_days"] == 3 and len(d["days"]) == 3,
          f"(span {d['span_days']}, {len(d['days'])} jours)")
    check("h2_crosscheck present dans --json",
          d["h2_crosscheck"]["h2"] == 120 and "parsed" in d["h2_crosscheck"])
    check("fenetre dans l'annee glissante -> vue SANS parametres (1 fetch)",
          len(FETCH_CALLS) == 1 and FETCH_CALLS[0] == ("jsboige", None),
          f"(got {FETCH_CALLS})")

    out2 = io.StringIO()
    sys.argv = ["github-activity.py", "--json"]          # sans fenetre
    with contextlib.redirect_stdout(out2):
        rc2 = ga.main()
    d2 = json.loads(out2.getvalue())
    trailing = (datetime.now(timezone.utc).date()
                - timedelta(days=364)).isoformat()
    check("defaut = annee glissante 365 j (1 fetch)",
          rc2 == 0 and d2["span_days"] == 365 and d2["from"] == trailing,
          f"(span {d2['span_days']}, from {d2['from']})")

    out3 = io.StringIO()
    sys.argv = ["github-activity.py", "--days", "1", "--json"]
    with contextlib.redirect_stdout(out3):
        rc3 = ga.main()
    d3 = json.loads(out3.getvalue())
    check("--days 1 = 1 jour (le repli ne l'avale pas)",
          rc3 == 0 and d3["span_days"] == 1, f"(span {d3['span_days']})")

    # --- fragment d'un jour de RETARD (la forme que GitHub rend juste apres
    # minuit ou depuis un cache) : la fenetre n'est plus couverte.
    def _fake_stale(login, year=None):
        FETCH_CALLS.append((login, year))
        today = datetime.now(timezone.utc).date()
        parts = ['<h2 id="js-contribution-activity-description">7 '
                 'contributions in the last year</h2>']
        for n in range(1, 8):                     # la veille et avant, pas aujourd'hui
            d = (today - timedelta(days=n)).isoformat()
            parts.append(td(d, 1, "1 contribution on x."))
        return ga.parse_fragment("".join(parts))

    ga.fetch_fragment = _fake_stale
    err_c = io.StringIO()
    out_c = io.StringIO()
    sys.argv = ["github-activity.py", "--days", "1"]
    try:
        with contextlib.redirect_stdout(out_c), contextlib.redirect_stderr(err_c):
            rc_c = ga.main()
    except SystemExit as e:
        rc_c = e.code
    check("fenetre non couverte -> exit 2, aucun rapport qui lirait zero",
          rc_c == 2 and "couverture nulle" in err_c.getvalue()
          and out_c.getvalue() == "",
          f"(rc {rc_c}, err {err_c.getvalue()!r}, out {out_c.getvalue()!r})")

    out_c2 = io.StringIO()
    sys.argv = ["github-activity.py", "--days", "7"]
    with contextlib.redirect_stdout(out_c2):
        rc_c2 = ga.main()
    got_c2 = out_c2.getvalue()
    check("un jour de retard -> couverture 6/7 nommee, pas 'zero contribution'",
          rc_c2 == 0 and "couverture: 6/7" in got_c2, f"(rc {rc_c2}, got {got_c2!r})")
    ga.fetch_fragment = _fake_fragment

    tmpdir = tempfile.mkdtemp(prefix="gha-html-")
    page_path = os.path.join(tmpdir, "page.html")
    out4 = io.StringIO()
    sys.argv = ["github-activity.py", "--days", "5", "--html", page_path]
    with contextlib.redirect_stdout(out4):
        rc4 = ga.main()
    body = open(page_path, encoding="utf-8").read()
    check("--html ecrit la page", rc4 == 0 and os.path.getsize(page_path) > 0
          and "<!DOCTYPE html>" in body)

    err = io.StringIO()
    sys.argv = ["github-activity.py", "--login", "gone", "--days", "3"]
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            rc5 = ga.main()
    except SystemExit as e:
        rc5 = e.code
    check("degradation : exit 2, cause sur stderr",
          rc5 == 2 and "404" in err.getvalue(),
          f"(rc {rc5}, stderr {err.getvalue()!r})")

    sys.argv = ["github-activity.py", "--nonsense"]
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc6 = ga.main()
    except SystemExit as e:
        rc6 = e.code
    check("argument inconnu : exit 64", rc6 == 64, f"(rc {rc6})")

    print("fetch_window — fenetre HISTORIQUE -> vues parametrees par annee")
    FETCH_CALLS.clear()
    old = date(2024, 2, 1)
    ga.fetch_window("jsboige", old, date(2024, 3, 15))
    check("annee hors glissante -> vue parametree 2024",
          FETCH_CALLS == [("jsboige", 2024)], f"(got {FETCH_CALLS})")
    FETCH_CALLS.clear()
    ga.fetch_window("jsboige", date(2026, 1, 1),
                    datetime.now(timezone.utc).date())
    check("annee civile courante incluse dans la glissante -> sans params",
          FETCH_CALLS == [("jsboige", None)], f"(got {FETCH_CALLS})")
finally:
    ga.fetch_fragment = backup_fetch
    sys.argv = argv_backup

print()
if FAILS:
    print(f"FAILED: {len(FAILS)} -> {FAILS}")
    sys.exit(1)
print("all pins green")
