#!/usr/bin/env python3
"""subagent_flag.py — LE predicat `cc_is_subagent`, une seule copie (#1051).

Trois etats, jamais deux : True (sous-agent), False (tour principal),
None (aucune preuve — JAMAIS devine). Un predicat qui ne sait pas dire
« je ne sais pas » se lit comme un resultat : c'est l'histoire de ce
drapeau, qui a oscille trois fois dans native-consumption.py.

  * `"cc_is_subagent" in raw` — toujours VRAI : le litteral est cite dans le
    CLAUDE.md du depot, donc dans le prompt systeme de chaque session
    claudish (piege T4 de docs/reference/ops-scripts.md) ;
  * `"cc_is_subagent":\\s*true` (commit f9695305) — toujours FAUX sur le
    corpus reel : la cle JSON de `metadata` n'existe pas dans les captures
    (mesure #334 B1 sur 60 req-* : `user_id` rend exactement
    (account_uuid, device_id, session_id) et ne porte jamais le drapeau) ;
  * `cc_is_subagent(?:"\\s*:\\s*|=)true` — re-toujours VRAI, pour la raison
    du premier.

La forme REELLE est le segment `x-anthropic-billing-header:` du bloc
system : `cc_is_subagent=true` y est un k=v, et l'en-tete present SANS le
drapeau signe un tour principal. Deux gardes :

  * le DERNIER segment gagne — le vrai bloc system est serialise APRES
    messages (piege 2 de live-consumption.py), donc un echo cite dans la
    conversation vient AVANT et ne peut pas ecraser la vraie valeur ;
  * la cle JSON n'est lue qu'en REPLI, quand aucun segment n'existe : c'est
    la seule autre forme vue, et elle n'est jamais echoee en prose.

Extrait de live-consumption.py, ou il etait ne et teste (#334 B1), pour que
native-consumption.py et lui cessent de diverger.
"""

import re

BILLING_MARKER = b"x-anthropic-billing-header:"
# Le segment s'arrete a la fin de la chaine JSON (guillemet ou antislash) :
# un match est le run k=v de l'en-tete, jamais ce qui suit dans le fichier.
BILLING_SEG_RE = re.compile(r'x-anthropic-billing-header:\s*([^"\\]*)')
BILLING_KV_RE = re.compile(r"(\w+)=([^;]*)")
# Forme de repli : une cle JSON, jamais un litteral cite en prose (le
# CLAUDE.md ecrit `cc_is_subagent=true`, sans guillemets ni deux-points).
JSON_KEY_RE = re.compile(r'"cc_is_subagent"\s*:\s*true')


def fields_to_verdict(pairs):
    """k=v d'un run d'en-tete -> {'sub': bool, 'workload': str|None}, ou None."""
    if not pairs:
        return None
    return {"sub": pairs.get("cc_is_subagent", "").strip() == "true",
            "workload": pairs.get("cc_workload", "").strip() or None}


def billing_fields_of(raw):
    """Verdict du DERNIER segment billing-header de `raw`, None si absent.

    None n'est pas « pas de sous-agent » : c'est « aucun en-tete dans ce
    texte ». Seul l'appelant sait s'il a lu assez du fichier pour conclure.
    """
    fields = None
    for seg in BILLING_SEG_RE.finditer(raw):
        verdict = fields_to_verdict(dict(BILLING_KV_RE.findall(seg.group(1))))
        if verdict is not None:
            fields = verdict
    return fields


def subagent_flag(raw):
    """True / False / None — le predicat partage des deux chemins (#1051)."""
    verdict = billing_fields_of(raw)
    if verdict is not None:
        return verdict["sub"]
    return True if JSON_KEY_RE.search(raw) else None