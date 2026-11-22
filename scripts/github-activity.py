#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Activite GitHub d'un profil, SANS quota GraphQL ni rendu des 50 k items (#1161).

La page https://github.com/<login> est devenue illisible pour un profil
dense (50 607 contributions sur un an) : le navigateur paie le rendu, pas
la donnee. Le quota GraphQL flotte, lui, est souvent en famine — la
demande user (22/11) : un chemin qui ne le consomme PAS. La page etant
publique, tout est lisible en anonyme :

  CHEMIN PAR DEFAUT (zero token, zero quota) — le fragment public
  https://github.com/users/<login>/contributions rend le calendrier des
  contributions cote serveur : chaque jour est une cellule
  `ContributionCalendar-day` (data-date + data-level) jumellee d'un
  <tool-tip for=...> portant le compte exact (« N contributions on ... »).
  Parse regex, aucun rendu. Un fetch = une fenetre (annee glissante sans
  parametre, ou annee civile via ?from=&to=) ; chaud, le CDN sert en
  ~0,6 s. Auto-controle : la somme parsee est confrontee au total H2 du
  fragment lui-meme — un ecart > 0,5 % est AFFICHE, jamais passe sous
  silence. Les totaux PAR TYPE (commit/PR/issue/review) n'existent pas
  dans le fragment : chemin --graphql seul, dit tel quel sinon.

  CHEMIN --graphql (opt-in, consomme le quota flotte) — GraphQL
  contributionsCollection via `gh api graphql` : jours + totaux par type.
  NUANCE mesuree (22/11) : le token flotte voit le profil COMME son
  proprietaire — contributions PRIVEES comprises (7 j : 2 564 GraphQL vs
  1 673 public). Le fragment anonyme reproduit la page publique, celle
  que l'habitude manualle rafraichissait ; --graphql est la vue pleine.

Sortie :
  texte (defaut)   — total fenetre, moyenne/j, top jours, tendance 7 j
  --html PAGE.html — page STATIQUE auto-suffisante (calendrier colore,
                     resume, tendance ; donnees embarquees, aucun fetch
                     a l'ouverture) — le remplacement local de la page
                     de profil qui casse
  --json           — {days: [{date, count}], source, ...} : cle de
                     jointure stage 2 (activite-par-coût avec les
                     lecteurs de consommation)

Degradation BRUYANTE : HTTP != 200, fragment sans jour, erreur GraphQL,
login inconnu -> message exact sur stderr + exit 2. Jamais un rapport
vide qui se lirait « zero activite ».

Usage:
  python scripts/github-activity.py --html %TEMP%/jsboige.html   # annee glissante
  python scripts/github-activity.py --days 30
  python scripts/github-activity.py --year 2026
  python scripts/github-activity.py --from 2026-11-01 --to 2026-11-22
  python scripts/github-activity.py --graphql                    # totaux par type
"""

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

DEFAULT_LOGIN = "jsboige"   # proprietaire de l'org flotte (jsboige/claudish)
FRAGMENT_URL = "https://github.com/users/{login}/contributions"
UA = "claudish-github-activity/1.0 (+local instrument, 1 fetch/window)"

TD_RE = re.compile(r'<td\b[^>]*class="ContributionCalendar-day"[^>]*>')
TD_ID_RE = re.compile(r'id="(contribution-day-component-[\d-]+)"')
TD_DATE_RE = re.compile(r'data-date="(\d{4}-\d{2}-\d{2})"')
TD_LEVEL_RE = re.compile(r'data-level="(\d)"')
TIP_RE = re.compile(
    r'<tool-tip[^>]*for="(contribution-day-component-[\d-]+)"[^>]*>\s*(.*?)\s*</tool-tip>',
    re.S)
TIP_NUM_RE = re.compile(r'^([\d,]+)\s+contributions?\s+on')
H2_RE = re.compile(
    r'id="js-contribution-activity-description"[^>]*>\s*([\d,]+)\s+contributions',
    re.S)

LEVEL_COLORS = ("#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39")


def parse_fragment(html):
    """Jours {date: count} + niveaux {date: level} + total H2 du fragment.

    Le compte vit dans le <tool-tip> jume (lien for=<id> <-> id=<id>) :
    « No contributions on November 23rd. » (0) ou « 1,234 contributions
    on July 2nd. ». L'ordre des attributs du <td> n'est pas garanti —
    chaque attribut est cherche dans le tag tel quel.
    """
    day_by_id = {}
    level_by_date = {}
    for m in TD_RE.finditer(html):
        tag = m.group(0)
        mid, mdate = TD_ID_RE.search(tag), TD_DATE_RE.search(tag)
        if not (mid and mdate):
            continue
        day_by_id[mid.group(1)] = mdate.group(1)
        mlvl = TD_LEVEL_RE.search(tag)
        if mlvl:
            level_by_date[mdate.group(1)] = int(mlvl.group(1))
    counts = {}
    for m in TIP_RE.finditer(html):
        text = re.sub(r'<[^>]+>', '', m.group(2)).strip()
        cid = m.group(1)
        if cid not in day_by_id:
            continue
        if text.startswith("No contributions"):
            counts[day_by_id[cid]] = 0
        else:
            n = TIP_NUM_RE.match(text)
            if n:
                counts[day_by_id[cid]] = int(n.group(1).replace(",", ""))
    h2 = H2_RE.search(html)
    h2_total = int(h2.group(1).replace(",", "")) if h2 else None
    if not counts:
        raise ValueError(
            "fragment sans jour lisible (structure GitHub changee ?) — "
            f"{len(day_by_id)} cellules, {len(html)} octets recus")
    return {"days": counts, "levels": level_by_date, "h2_total": h2_total}


def crosscheck_h2(parsed):
    """Somme parsee vs total H2 du MEME fragment. Ecart > 0,5 % : AFFICHE."""
    if parsed["h2_total"] is None:
        return None
    total = sum(parsed["days"].values())
    rel = abs(total - parsed["h2_total"]) / max(1, parsed["h2_total"])
    return {"parsed": total, "h2": parsed["h2_total"], "rel": rel,
            "ok": rel <= 0.005}


def fetch_fragment(login, year=None, retries=2):
    """Un GET anonyme : annee glissante (year=None) ou annee civile.

    Les vues parametrees 502-ent par accoups (mesure 22/11 : annee civile
    502 x3 en < 0,6 s pendant que la vue sans parametres sert en 200) —
    c'est la panne que le navigateur de la page de profil subit. Retry
    borne avec backoff court ; la vue SANS parametres (annee glissante)
    reste le chemin fiable, choisi par defaut par fetch_window.
    """
    import time
    url = FRAGMENT_URL.format(login=login)
    if year is not None:
        url += f"?from={year}-01-01T00:00:00Z&to={year}-12-31T00:00:00Z"
    last = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(1.0 * attempt)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read().decode("utf-8", errors="replace")
            return parse_fragment(body)
        except urllib.error.HTTPError as exc:
            last = f"fragment HTTP {exc.code} pour {login} (vue {url.rsplit('?', 1)[-1][:60]})"
            if exc.code == 404:
                raise ValueError(f"fragment HTTP 404 pour {login} — login inconnu")
        except urllib.error.URLError as exc:
            last = f"fragment injoignable: {exc.reason}"
    raise ValueError(f"{last} — {retries + 1} essais")


# ---- chemin GraphQL (opt-in --graphql : totaux par type) -----------------

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


def parse_response(text):
    """Reponse GraphQL -> jours + totaux par type. Bruyant si illisible."""
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
    return {"days": {d["date"]: d["count"] for d in days},
            "levels": {}, "totals": totals,
            "h2_total": int(cal.get("totalContributions") or 0)}


def gh_graphql(login, d_from, d_to):
    proc = subprocess.run(
        ["gh", "api", "graphql",
         "-F", f"login={login}",
         "-F", f"from={d_from.isoformat()}T00:00:00Z",
         "-F", f"to={d_to.isoformat()}T23:59:59Z",
         "-F", f"query={QUERY}"],
        capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise ValueError(f"gh api graphql a echoue (rc={proc.returncode}): "
                         f"{proc.stderr.strip()[:400]}")
    return proc.stdout


# ---- fenetres ------------------------------------------------------------

def years_spanning(d_from, d_to):
    """Annees civiles chevauchant [d_from, d_to] (1 fetch par annee)."""
    return list(range(d_from.year, d_to.year + 1))


def fetch_window(login, d_from, d_to, today=None):
    """Choisit le chemin de fetch le moins expose au 502 parametre.

    Fenetre incluse dans l'annee glissante -> vue SANS parametres (le
    chemin mesure fiable) + clip local. Sinon une vue parametree par
    annee civile chevauchante.
    """
    today = today or datetime.now(timezone.utc).date()
    trailing_start = today - timedelta(days=364)
    if d_from >= trailing_start and d_to <= today:
        return {None: fetch_fragment(login)}          # 1 fetch, sans params
    return {y: fetch_fragment(login, y) for y in years_spanning(d_from, d_to)}


def merge_parsed(parsed_by_year, d_from, d_to):
    """Fusionne les annees : jours dedupliques, bornes inclusives."""
    days, levels = {}, {}
    for _year, p in sorted(parsed_by_year.items()):
        for dt, c in p["days"].items():
            if d_from.isoformat() <= dt <= d_to.isoformat():
                days[dt] = c
        levels.update(p.get("levels") or {})
    return {"days": days, "levels": levels,
            "totals": next((p["totals"] for p in parsed_by_year.values()
                            if p.get("totals")), None)}


def summarize(days, d_from, d_to):
    ordered = sorted(days)
    return {"days": [{"date": d, "count": days[d]} for d in ordered],
            "sum": sum(days.values()),
            "span_days": (d_to - d_from).days + 1,
            "active": sum(1 for c in days.values() if c)}


# ---- rendus --------------------------------------------------------------

def render_text(login, d_from, d_to, s, source, totals, warn):
    lines = [
        f"{login} | {d_from} -> {d_to} ({s['span_days']} j) | source: {source}",
        f"contributions fenetre: {s['sum']:,} "
        f"({s['sum'] / max(1, s['span_days']):.0f}/j ; "
        f"{s['active']} j actifs / {s['span_days']})",
    ]
    if warn is not None:
        lines.append(f"H2 fragment: {warn['h2']:,} vs parse {warn['parsed']:,} "
                     f"(ecart {warn['rel']:.2%}){' OK' if warn['ok'] else ' — MEFIE-TOI'}")
    if totals:
        lines.append(" | ".join(f"{k.replace('total', '').replace('Contributions', '').lower()}: "
                                f"{v:,}" for k, v in totals.items()))
    else:
        lines.append("totaux par type: absents du fragment public "
                     "(chemin --graphql si necessaires)")
    top = sorted(s["days"], key=lambda d: -d["count"])[:5]
    if top:
        lines.append("top jours: " + " | ".join(f"{d['date']} {d['count']}"
                                                for d in top))
    n = len(s["days"])
    if n >= 7:
        last7 = sum(d["count"] for d in s["days"][-7:])
        prev7 = sum(d["count"] for d in s["days"][-14:-7]) if n >= 14 else None
        trend = ""
        if prev7 is not None:
            trend = f" (7 j precedent: {prev7:,}, {last7 - prev7:+,})"
        lines.append(f"7 derniers jours: {last7:,}{trend}")
    return "\n".join(lines)


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<title>{login} — activite GitHub</title>
<style>
 body {{ font-family: -apple-system, 'Segoe UI', sans-serif; margin: 2rem;
         color: #24292f; background: #fff; }}
 h1 {{ font-size: 1.3rem; }} .meta {{ color: #57606a; font-size: .85rem; }}
 .grid {{ display: grid; grid-auto-flow: column;
          grid-template-rows: repeat(7, 13px); gap: 3px; margin: 1rem 0;
          overflow-x: auto; padding-bottom: .5rem; }}
 .cell {{ width: 13px; height: 13px; border-radius: 2px; }}
 .stats {{ display: flex; gap: 2rem; flex-wrap: wrap; margin: 1rem 0; }}
 .stat b {{ display: block; font-size: 1.4rem; }}
 .stat span {{ color: #57606a; font-size: .8rem; }}
 table {{ border-collapse: collapse; font-size: .85rem; }}
 td, th {{ border: 1px solid #d0d7de; padding: 3px 10px; text-align: left; }}
 .warn {{ color: #9a6700; }}
</style></head><body>
<h1>{login} — activite GitHub</h1>
<p class="meta">fenetre {d_from} &rarr; {d_to} · source {source} ·
genere le {generated} · instrument local claudish (#1161), aucun appel a l'ouverture</p>
<div class="stats">
 <div class="stat"><b>{total:,}</b><span>contributions ({per_day:.0f}/j)</span></div>
 <div class="stat"><b>{active}</b><span>jours actifs / {span}</span></div>
 <div class="stat"><b>{last7:,}</b><span>7 derniers jours{trend}</span></div>
</div>
{warn_html}
<div class="grid">{cells}</div>
<table>{top_rows}</table>
<p class="meta">Les totaux par type (commits/PRs/issues) ne sont pas dans le
fragment public — <code>--graphql</code> pour les obtenir.</p>
</body></html>
"""


def render_html(login, d_from, d_to, s, levels, source, warn, generated):
    cells = []
    for d in s["days"]:
        lvl = min(4, levels.get(d["date"], 4 if d["count"] else 0))
        color = LEVEL_COLORS[lvl]
        cells.append(f'<div class="cell" style="background:{color}" '
                     f'title="{d["date"]}: {d["count"]}"></div>')
    top = sorted(s["days"], key=lambda x: -x["count"])[:10]
    rows = "".join(f"<tr><td>{d['date']}</td><td>{d['count']:,}</td></tr>"
                   for d in top)
    n = len(s["days"])
    last7 = sum(d["count"] for d in s["days"][-7:]) if n >= 7 else s["sum"]
    prev7 = (sum(d["count"] for d in s["days"][-14:-7])
             if n >= 14 else None)
    trend = f" ({last7 - prev7:+,} vs 7 j precedent)" if prev7 is not None else ""
    warn_html = ""
    if warn is not None and not warn["ok"]:
        warn_html = (f'<p class="warn">auto-controle : parse {warn["parsed"]:,} '
                     f'vs total fragment {warn["h2"]:,} (ecart {warn["rel"]:.2%})</p>')
    elif warn is not None:
        warn_html = (f'<p class="meta">auto-controle H2 : {warn["parsed"]:,} '
                     f'= fragment {warn["h2"]:,} (exact)</p>')
    return HTML_TEMPLATE.format(
        login=login, d_from=d_from, d_to=d_to, source=source,
        generated=generated, total=s["sum"],
        per_day=s["sum"] / max(1, s["span_days"]), active=s["active"],
        span=s["span_days"], last7=last7, trend=trend,
        cells="".join(cells), top_rows=rows, warn_html=warn_html)


# ---- CLI -----------------------------------------------------------------

def main():
    args = sys.argv[1:]
    login = DEFAULT_LOGIN
    d_from = d_to = None
    window_given = False
    as_json = html_path = None
    use_graphql = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--login" and i + 1 < len(args):
            login = args[i + 1]; i += 2
        elif a == "--days" and i + 1 < len(args):
            n = int(args[i + 1]); i += 2
            today = datetime.now(timezone.utc).date()
            d_to, d_from = today, today - timedelta(days=n - 1)
            window_given = True
        elif a == "--year" and i + 1 < len(args):
            y = int(args[i + 1]); i += 2
            d_from = date(y, 1, 1)
            d_to = min(date(y, 12, 31), datetime.now(timezone.utc).date())
            window_given = True
        elif a == "--from" and i + 1 < len(args):
            d_from = datetime.strptime(args[i + 1], "%Y-%m-%d").date(); i += 2
            window_given = True
        elif a == "--to" and i + 1 < len(args):
            d_to = datetime.strptime(args[i + 1], "%Y-%m-%d").date(); i += 2
            window_given = True
        elif a == "--json":
            as_json = True; i += 1
        elif a == "--html" and i + 1 < len(args):
            html_path = args[i + 1]; i += 2
        elif a == "--graphql":
            use_graphql = True; i += 1
        else:
            sys.stderr.write(f"argument inconnu: {a}\n")
            sys.exit(64)
    today = datetime.now(timezone.utc).date()
    if d_to is None:
        d_to = today
    if d_from is None:
        # defaut = la vue « page de profil » : annee glissante, 1 fetch
        d_from = today
    if d_from > d_to:
        sys.stderr.write(f"fenetre inversee: {d_from} > {d_to}\n")
        sys.exit(64)
    d_to = min(d_to, today)
    if not window_given:          # defaut = la vue « page de profil »
        d_from = d_to - timedelta(days=364)   # annee glissante, 1 fetch

    try:
        if use_graphql:
            rep = parse_response(gh_graphql(login, d_from, d_to))
            parsed_by_year, source = {None: rep}, "graphql"
            warn = None
        else:
            parsed_by_year = fetch_window(login, d_from, d_to)
            warns = []
            for p in parsed_by_year.values():
                w = crosscheck_h2(p)
                if w is not None:
                    warns.append(w)
            source = "fragment-anonyme"
            # auto-controle : le pire ecart des fragments charges
            warn = max(warns, key=lambda w: w["rel"]) if warns else None
    except ValueError as exc:
        # Bruyant et lisible : pas de traceback, pas de rapport vide.
        sys.stderr.write(f"github-activity: {exc}\n")
        sys.exit(2)

    merged = merge_parsed(parsed_by_year, d_from, d_to)
    s = summarize(merged["days"], d_from, d_to)

    if html_path:
        generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        page = render_html(login, d_from, d_to, s, merged["levels"],
                           source, warn, generated)
        with open(html_path, "w", encoding="utf-8") as fh:
            fh.write(page)
        print(f"page ecrite: {html_path}")
    if as_json:
        print(json.dumps({"login": login, "from": d_from.isoformat(),
                          "to": d_to.isoformat(), "source": source,
                          "span_days": s["span_days"], "total": s["sum"],
                          "totals": merged["totals"],
                          "h2_crosscheck": warn,
                          "days": s["days"]}, ensure_ascii=False))
    else:
        print(render_text(login, d_from, d_to, s, source, merged["totals"], warn))
    return 0


if __name__ == "__main__":
    sys.exit(main())
