#!/usr/bin/env python3
"""Catalogue of the subscription / PAYG consoles, and a durable reading log.

Why this exists: the quota walls that drive the cascade are only legible from the
providers' own consoles, and every session used to rediscover which tab answers
which question. This script is the single source of that catalogue — the URLs, the
question each console answers, and the auth model. It never drives a browser: the
playwright MCP owns the profile, and a second process would fight it for the lock.

    python scripts/console-tabs.py list            # the catalogue, grouped by role
    python scripts/console-tabs.py urls            # bare URLs, one per line
    python scripts/console-tabs.py log --provider kimi --field "7d=100%" ...
                                                   # append a reading to the JSONL
    python scripts/console-tabs.py series --days 30
                                                   # consolidate the log into a table

Readings go to `~/.claudish/console-readings.jsonl` (machine-local, never in git):
one object per observation, so a series accumulates instead of being overwritten.

Two writers feed it, and they are deliberately different:
- `provider-consoles-reader.py` (outside this repo, on ai-01) appends the console text
  VERBATIM under `lines`, every `CONSOLE_SNAP_EVERY_S` (default 900 s). It observes; it
  does not parse — a reader that guessed would fabricate a measurement.
- `log` appends `values` an operator has already read off the page. `--observed-at`
  sets the INSTANT OF OBSERVATION, which is what `ts` means; a backfill without it
  would carry the call's clock and silently move a three-week-old figure to today.

`series` is the only place interpretation happens: it applies the declared
`FIELD_PATTERNS` to `lines`, and reports the consoles it could not read rather than
filling them with a default.

Every entry carries a `provenance` string, because the tab set MOVES: the user
opens and closes consoles, and a catalogue that presents an unobserved URL as
canonical sends the next session to a page with no session (2026-11-02 review).
`verbatim tab-NN, <instant>` means the URL was read off that open tab at that
instant; `jamais observé` means it is a standard console path still to confirm.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

READINGS = Path.home() / ".claudish" / "console-readings.jsonl"

# `role` says WHAT the console answers, which is the part every session lost.
# `auth` documents how the session is held, so a lost cookie is diagnosed rather
# than guessed (see docs/reference/subscription-consoles.md).
# `provenance` says WHEN the URL was last seen on a real tab — a catalogue that
# claims to be the single source must say what it observed and when.
CONSOLES = [
    {
        "id": "minimax",
        "name": "MiniMax API Platform — Plan Usage",
        "url": "https://platform.minimax.io/console/usage",
        "role": "Fenêtre 5 h + quota hebdo (le mur qui arme haiku→sonnet). Source du relevé mono-observateur et de ~/.claudish/minimax-plan-watch.log.",
        "auth": "profil playwright persistant (session console longue durée)",
        "fields": ["5-hour %", "weekly %", "resets-in"],
        "provenance": "verbatim tab-00, 2026-11-02 20:35 local",
    },
    {
        "id": "zai",
        "name": "Z.AI — GLM Coding Plan / Usage",
        "url": "https://z.ai/manage-apikey/coding-plan/personal/usage",
        "role": "Quota 5 h du Coding Plan (nominal de la lane sonnet), quota MCP, réinitialisations disponibles, tokens cumulés par modèle.",
        "auth": "OAuth chat.z.ai (Google) — le cookie se perd sans prévenir, la page renvoie alors un mur de connexion",
        "fields": ["5h quota %", "mcp quota %", "resets available", "tokens 7d/30d"],
        "provenance": "verbatim tab-01, 2026-11-02 20:35 local",
    },
    {
        "id": "kimi",
        "name": "Kimi — Abonnement",
        "url": "https://www.kimi.ai/settings/subscription",
        "role": "Fenêtre 5 h ET fenêtre 7 jours du plan Code — c'est le 7 j qui a maxé depuis avant le week-end.",
        "auth": "session navigateur",
        "fields": ["5h %", "7d %", "resets-in", "total %"],
        "provenance": "verbatim tab-02, 2026-11-02 20:35 local (absente des 11 onglets relevés par ai-01 à 09:46Z — la session a été rouverte depuis)",
    },
    {
        "id": "deepseek",
        "name": "DeepSeek Platform — Usage",
        "url": "https://platform.deepseek.com/usage",
        "role": "Le PAYG réel : solde rechargé, coût 30 jours, requêtes et tokens. C'est le compteur de la facture.",
        "auth": "session navigateur",
        "fields": ["balance", "cost 30d", "requests 30d", "tokens 30d"],
        "provenance": "verbatim tab-03, 2026-11-02 20:35 local",
    },
    {
        "id": "qwen",
        "name": "QwenCloud — Token Plan Usage",
        "url": "https://home.qwencloud.com/analytics/token-plan/individual",
        "role": "Quota MENSUEL du Token Plan (remise à zéro horodatée) — la lane restée murée jusqu'au 11/11.",
        "auth": "session navigateur (l'URL reçoit des paramètres de traçage, non nécessaires)",
        "fields": ["monthly remaining %", "reset time", "plan quota"],
        "provenance": "verbatim tab-06, 2026-11-02 20:35 local ; ai-01 a relevé le même jour à 09:46Z un second point d'entrée, modelstudio.console.alibabacloud.com/ap-southeast-1/subscription/token-plan/personal (tab-04) — les deux mènent au Token Plan, la session décide lequel répond",
    },
    {
        "id": "mistral",
        "name": "Mistral Admin — Abonnement",
        "url": "https://admin.mistral.ai/subscription",
        "role": "Forfait API inclus dans l'abonnement Pro (remis à zéro le 1er du mois) — c'est ce budget qui rend le 402 'API budget exhausted'.",
        "auth": "session navigateur",
        "fields": ["included API allowance", "reset date", "used"],
        "provenance": "verbatim tab-07, 2026-11-02 20:35 local",
    },
    {
        "id": "claude",
        "name": "claude.ai — Utilisation",
        "url": "https://claude.ai/new#settings/usage",
        "role": "Limite hebdomadaire du forfait Anthropic, réinitialisation, et crédits d'utilisation au-delà.",
        "auth": "session claude.ai",
        "fields": ["weekly warning", "reset day", "spend limit"],
        "provenance": "verbatim tab-05, 2026-11-02 20:35 local",
    },
    {
        "id": "chatgpt",
        "name": "ChatGPT — Utilisation (Codex)",
        "url": "https://chatgpt.com/settings/usage?tab=overview",
        "role": "Limite hebdomadaire partagée Codex / Work / agents d'espace.",
        "auth": "session chatgpt.com",
        "fields": ["weekly remaining %", "resets-in"],
        "provenance": "verbatim tab-04, 2026-11-02 20:35 local",
    },
    {
        "id": "copilot",
        "name": "GitHub — Copilot features",
        "url": "https://github.com/settings/copilot/features",
        "role": "Crédits AI mensuels du plan Pro (réservoir très peu entamé).",
        "auth": "session github.com",
        "fields": ["credits used / total", "reset date"],
        "provenance": "verbatim tab-08, 2026-11-02 20:35 local",
    },
    {
        "id": "openrouter",
        "name": "OpenRouter — Activity / Billing",
        "url": "https://openrouter.ai/workspaces/default/activity",
        "role": "PAYG agrégateur — ce que la flotte paie quand un étage direct est muré et que la route retombe sur `or@`/`openrouter@`.",
        "auth": "session openrouter.ai",
        "fields": ["credits remaining", "usage 30d", "per-model spend"],
        "provenance": "verbatim tab-10, 2026-11-02 09:46Z (relevé ai-01) — fermée au 20:35 local",
    },
    # --- not yet opened by the user (02/11) ---
    {
        "id": "anthropic-payg",
        "name": "Anthropic Console — Billing / Usage",
        "url": "https://console.anthropic.com/settings/billing",
        "role": "PAYG Anthropic (différent du forfait claude.ai : c'est le compteur de l'API native), alimenté par un crédit mensuel dont le niveau vit dans le relevé, pas ici.",
        "auth": "session console.anthropic.com (à authentifier)",
        "fields": ["credit balance", "usage 30d"],
        "provenance": "jamais observé — chemin standard du Console, à confirmer à la première ouverture",
        "todo": True,
    },
    {
        "id": "openai-payg",
        "name": "OpenAI Platform — Usage / Billing",
        "url": "https://platform.openai.com/settings/organization/usage",
        "role": "PAYG OpenAI (le plan hebdo de l'onglet chatgpt est un autre compteur).",
        "auth": "session platform.openai.com (à authentifier)",
        "fields": ["usage 30d", "cost", "credit balance"],
        "provenance": "verbatim tab-09, 2026-11-02 09:46Z (relevé ai-01) — chemin /settings/organization/usage, pas /usage",
        "todo": True,
    },
]


def cmd_list(as_json: bool = False) -> int:
    if as_json:
        print(json.dumps(CONSOLES, indent=2, ensure_ascii=False))
        return 0
    for c in CONSOLES:
        flag = "  [À AUTHENTIFIER]" if c.get("todo") else ""
        print(f"\n{c['id']} — {c['name']}{flag}")
        print(f"  url    : {c['url']}")
        print(f"  vu     : {c.get('provenance', 'provenance absente — à vérifier avant usage')}")
        print(f"  répond : {c['role']}")
        print(f"  auth   : {c['auth']}")
        print(f"  champs : {', '.join(c['fields'])}")
    print(f"\n{len(CONSOLES)} consoles ({sum(1 for c in CONSOLES if c.get('todo'))} restantes à ouvrir).")
    print("La liste d'onglets BOUGE : `vu` date la dernière observation réelle — une entrée")
    print("dont la provenance est ancienne se re-vérifie avant de rouvrir quoi que ce soit.")
    print(f"Relevés      : {READINGS}")
    print("Relevé d'une console : roosync playwright, onglet N, puis le probe JS de")
    print("docs/reference/subscription-consoles.md, puis `console-tabs.py log`.")
    return 0


def cmd_urls() -> int:
    for c in CONSOLES:
        if not c.get("todo"):
            print(c["url"])
    return 0


def cmd_log(args) -> int:
    try:
        values = dict(kv.split("=", 1) for kv in args.field)
    except ValueError:
        print("--field attend clé=valeur", file=sys.stderr)
        return 2
    READINGS.parent.mkdir(parents=True, exist_ok=True)
    # `ts` is the INSTANT OF OBSERVATION, not the instant of the call (03/11). The two
    # coincide for a live reading and diverge for a backfill: writing a three-week-old
    # console figure under today's clock fabricates a measurement nobody made, which is
    # the one thing a series must never do. A backfill therefore MUST pass --observed-at.
    ts = args.observed_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    row = {
        "ts": ts,
        "provider": args.provider,
        "values": values,
    }
    # The module docstring promises every entry carries a provenance, and until 03/11
    # `log` could not write one at all — the claim was prose, not a property.
    if args.provenance:
        row["provenance"] = args.provenance
    if args.note:
        row["note"] = args.note
    with READINGS.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps(row, ensure_ascii=False))
    return 0


# Declared extractors for the raw `lines` the console reader appends. They are few and
# explicit on purpose: an extractor that guesses produces a number nobody measured, and
# a series of those is worse than no series. Anything a pattern cannot read stays ABSENT
# and is reported as such — never filled with a default.
FIELD_PATTERNS = [
    ("pct", re.compile(r"(\d+(?:[.,]\d+)?)\s*%\s*(?:restants?|remaining)", re.I)),
    ("pct", re.compile(r"(\d+(?:[.,]\d+)?)\s*%")),
    ("reset", re.compile(
        r"(?:r[ée]initialisation|reset)[^\n]{0,40}?(?:dans|in)\s+([0-9]+\s*[jhd]\s*(?:et\s*)?[0-9]*\s*h?)", re.I)),
    ("credits", re.compile(r"([0-9][0-9\s.,]{2,}?)\s*cr[ée]dits?", re.I)),
    ("usd", re.compile(r"\$\s?([0-9][0-9.,]*)")),
]


def extract(lines) -> dict:
    """Pull declared fields out of a verbatim console dump; leave the rest absent."""
    out: dict = {}
    for key, pat in FIELD_PATTERNS:
        if key in out:
            continue
        for line in lines:
            m = pat.search(line)
            if m:
                out[key] = m.group(1).strip()
                break
    return out


def cmd_series(args) -> int:
    """Consolidate the ledger into one table over time."""
    if not READINGS.exists():
        print(f"aucun relevé : {READINGS}", file=sys.stderr)
        return 1
    rows = []
    for line in READINGS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            print(f"ligne illisible ignorée : {line[:80]}", file=sys.stderr)
    if args.provider:
        rows = [r for r in rows if r.get("provider") == args.provider]
    if args.days:
        cutoff = datetime.now(timezone.utc).timestamp() - args.days * 86400
        kept = []
        for r in rows:
            try:
                t = datetime.strptime(r["ts"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            except (KeyError, ValueError):
                kept.append(r)      # an unparseable stamp is kept and shown, not dropped
                continue
            if t.timestamp() >= cutoff:
                kept.append(r)
        rows = kept
    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0

    # Rows written by the console reader carry `lines` (verbatim, never interpreted);
    # rows written by `log` carry `values` (interpreted at the time, by a human).
    table, unresolved = [], {}
    for r in rows:
        fields = dict(r.get("values") or {})
        if "lines" in r:
            got = extract(r["lines"])
            for k, v in got.items():
                fields.setdefault(k, v)
            if not got:
                unresolved[r.get("provider", "?")] = unresolved.get(r.get("provider", "?"), 0) + 1
        table.append((r.get("ts", "?"), r.get("provider", "?"),
                      fields.get("pct", "—"), fields.get("reset", "—"),
                      fields.get("credits", "—"), fields.get("usd", "—"),
                      r.get("status", "")))
    table.sort(key=lambda t: t[0])
    w = max([len(t[1]) for t in table] + [8])
    print(f"{'ts':20}  {'provider':{w}}  {'%':>6}  {'reset':>12}  {'crédits':>9}  {'$':>8}  état")
    for t in table:
        print(f"{t[0]:20}  {t[1]:{w}}  {t[2]:>6}  {t[3]:>12}  {t[4]:>9}  {t[5]:>8}  {t[6]}")
    print(f"\n{len(table)} relevé(s) — source : {READINGS}")
    if unresolved:
        print("NON INTERPRÉTÉ (relevés présents, aucun champ reconnu) : "
              + ", ".join(f"{k} ×{v}" for k, v in sorted(unresolved.items())))
        print("  → ces lignes sont dans le fichier ; c'est l'extracteur qui ne les lit pas, "
              "pas la console qui n'a rien dit.")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    pl = sub.add_parser("list", help="catalogue lisible")
    pl.add_argument("--json", action="store_true")
    sub.add_parser("urls", help="une URL par ligne")
    lg = sub.add_parser("log", help="ajoute un relevé")
    lg.add_argument("--provider", required=True)
    lg.add_argument("--field", action="append", default=[], metavar="CLÉ=VALEUR")
    lg.add_argument("--observed-at", dest="observed_at", metavar="YYYY-MM-DDTHH:MM:SSZ",
                    help="instant de l'OBSERVATION (obligatoire pour un relevé rétroactif : "
                         "sans lui, le relevé porte l'heure de l'appel et fabrique une mesure)")
    lg.add_argument("--provenance", help="d'où vient le chiffre (onglet, archive, page lue)")
    lg.add_argument("--note")
    sr = sub.add_parser("series", help="consolide le journal en une table dans la durée")
    sr.add_argument("--provider")
    sr.add_argument("--days", type=int, help="ne garde que les N derniers jours")
    sr.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    if a.cmd == "list":
        return cmd_list(a.json)
    if a.cmd == "urls":
        return cmd_urls()
    if a.cmd == "series":
        return cmd_series(a)
    return cmd_log(a)


if __name__ == "__main__":
    raise SystemExit(main())
