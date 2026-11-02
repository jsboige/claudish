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

Readings go to `~/.claudish/console-readings.jsonl` (machine-local, never in git):
one object per observation, so a series accumulates instead of being overwritten.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

READINGS = Path.home() / ".claudish" / "console-readings.jsonl"

# `role` says WHAT the console answers, which is the part every session lost.
# `auth` documents how the session is held, so a lost cookie is diagnosed rather
# than guessed (see docs/reference/subscription-consoles.md).
CONSOLES = [
    {
        "id": "minimax",
        "name": "MiniMax API Platform — Plan Usage",
        "url": "https://platform.minimax.io/console/usage",
        "role": "Fenêtre 5 h + quota hebdo (le mur qui arme haiku→sonnet). Source du relevé mono-observateur et de ~/.claudish/minimax-plan-watch.log.",
        "auth": "profil playwright persistant (session console longue durée)",
        "fields": ["5-hour %", "weekly %", "resets-in"],
    },
    {
        "id": "zai",
        "name": "Z.AI — GLM Coding Plan / Usage",
        "url": "https://z.ai/manage-apikey/coding-plan/personal/usage",
        "role": "Quota 5 h du Coding Plan (nominal de la lane sonnet), quota MCP, réinitialisations disponibles, tokens cumulés par modèle.",
        "auth": "OAuth chat.z.ai (Google) — le cookie se perd sans prévenir, la page renvoie alors un mur de connexion",
        "fields": ["5h quota %", "mcp quota %", "resets available", "tokens 7d/30d"],
    },
    {
        "id": "kimi",
        "name": "Kimi — Abonnement",
        "url": "https://www.kimi.ai/settings/subscription",
        "role": "Fenêtre 5 h ET fenêtre 7 jours du plan Code — c'est le 7 j qui a maxé depuis avant le week-end.",
        "auth": "session navigateur",
        "fields": ["5h %", "7d %", "resets-in", "total %"],
    },
    {
        "id": "deepseek",
        "name": "DeepSeek Platform — Usage",
        "url": "https://platform.deepseek.com/usage",
        "role": "Le PAYG réel : solde rechargé, coût 30 jours, requêtes et tokens. C'est le compteur de la facture.",
        "auth": "session navigateur",
        "fields": ["balance", "cost 30d", "requests 30d", "tokens 30d"],
    },
    {
        "id": "qwen",
        "name": "QwenCloud — Token Plan Usage",
        "url": "https://home.qwencloud.com/analytics/token-plan/individual",
        "role": "Quota MENSUEL du Token Plan (remise à zéro horodatée) — la lane restée murée jusqu'au 11/11.",
        "auth": "session navigateur (l'URL reçoit des paramètres de traçage, non nécessaires)",
        "fields": ["monthly remaining %", "reset time", "plan quota"],
    },
    {
        "id": "mistral",
        "name": "Mistral Admin — Abonnement",
        "url": "https://admin.mistral.ai/subscription",
        "role": "Forfait API inclus dans l'abonnement Pro (25,5 €/mois, remis à zéro le 1er du mois) — c'est ce budget qui rend le 402 'API budget exhausted'.",
        "auth": "session navigateur",
        "fields": ["included API allowance", "reset date", "used"],
    },
    {
        "id": "claude",
        "name": "claude.ai — Utilisation",
        "url": "https://claude.ai/new#settings/usage",
        "role": "Limite hebdomadaire du forfait Anthropic, réinitialisation, et crédits d'utilisation au-delà.",
        "auth": "session claude.ai",
        "fields": ["weekly warning", "reset day", "spend limit"],
    },
    {
        "id": "chatgpt",
        "name": "ChatGPT — Utilisation (Codex)",
        "url": "https://chatgpt.com/settings/usage?tab=overview",
        "role": "Limite hebdomadaire partagée Codex / Work / agents d'espace.",
        "auth": "session chatgpt.com",
        "fields": ["weekly remaining %", "resets-in"],
    },
    {
        "id": "copilot",
        "name": "GitHub — Copilot features",
        "url": "https://github.com/settings/copilot/features",
        "role": "Crédits AI mensuels du plan Pro (réservoir très peu entamé).",
        "auth": "session github.com",
        "fields": ["credits used / total", "reset date"],
    },
    # --- not yet opened by the user (02/11) ---
    {
        "id": "anthropic-payg",
        "name": "Anthropic Console — Billing / Usage",
        "url": "https://console.anthropic.com/settings/billing",
        "role": "PAYG Anthropic (différent du forfait claude.ai : c'est le compteur de l'API native).",
        "auth": "session console.anthropic.com (à authentifier)",
        "fields": ["credit balance", "usage 30d"],
        "todo": True,
    },
    {
        "id": "openai-payg",
        "name": "OpenAI Platform — Usage / Billing",
        "url": "https://platform.openai.com/usage",
        "role": "PAYG OpenAI (le plan hebdo de l'onglet chatgpt est un autre compteur).",
        "auth": "session platform.openai.com (à authentifier)",
        "fields": ["usage 30d", "cost", "credit balance"],
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
        print(f"  répond : {c['role']}")
        print(f"  auth   : {c['auth']}")
        print(f"  champs : {', '.join(c['fields'])}")
    print(f"\n{len(CONSOLES)} consoles ({sum(1 for c in CONSOLES if c.get('todo'))} restantes à ouvrir).")
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
    row = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "provider": args.provider,
        "values": values,
    }
    if args.note:
        row["note"] = args.note
    with READINGS.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps(row, ensure_ascii=False))
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
    lg.add_argument("--note")
    a = p.parse_args(argv)
    if a.cmd == "list":
        return cmd_list(a.json)
    if a.cmd == "urls":
        return cmd_urls()
    return cmd_log(a)


if __name__ == "__main__":
    raise SystemExit(main())
