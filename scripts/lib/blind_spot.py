#!/usr/bin/env python3
"""blind_spot.py — declaration de l'angle mort AUTONOMOUS des lecteurs hub (#933).

Un corpus hub ne contient QUE les captures NOMINALES : une requete relayee par
un sidecar est capturee par le hub (champ `machine` preserve par le saut). Les
captures AUTONOMOUS d'un sidecar vivent sur SON disque, et n'atteignent le
corpus que par la reconciliation horaire (`reconcile/outage-<machine>-*.7z`,
#927) — au mieux une heure plus tard, seulement si le task -Register a tourne,
seulement quand l'operateur est connecte (LogonType Interactive).

Un lecteur qui affiche « 0 » pour une machine dans cette fenetre ment donc par
omission : « aucune capture » peut vouloir « pas de trafic » OU « autonome, pas
encore reconcilie » (#912 point 2, cas mesure 06/11 : une fenetre d'outage
entiere lue comme absence de trafic). Ce module rend la difference EXPLICITE.

Semantique (AC #933) :
  fleet     = machines declarees (--fleet, l'appelant connait sa flotte)
              U machines nommees par une archive reconcile/outage-*.7z presente
              (une machine qui a deja reconcile prouve qu'elle porte un sidecar).
              Aucune scan complet du corpus : les tete-lectures hors fenetre
              couteraient cher pour un signal que --fleet donne deja.
  nominal   = requetes req-*.json dans la fenetre dont l'enveloppe porte
              machine=<M> (toutes lanes confondues — tout req-* du corpus hub
              est une capture hub-side).
  archives  = archives reconcile/outage-<M>-<start>_<end>.7z dont la fenetre
              [start, end] (UTC, encodee dans le nom) chevauche la fenetre
              demandee.
  BLIND     = machine de la fleet avec nominal == 0 ET archives == 0.
              La formulation nomme l'INCONNU, jamais « pas de trafic ».

Charge : un listdir du repertoire + un listdir de reconcile/ + la lecture des
tetes (400 octets) des SEULS req-*.json dans la fenetre.
"""

import os
import re
from datetime import datetime, timezone

# Champ d'enveloppe #98 — la machine vit en tete du fichier req-*.
MACHINE_FIELD = re.compile(r'"machine"\s*:\s*"([^"]*)"')
# req-1-0001-2026-10-19T04-35-22-223Z-direct.json (suffixe src quelconque)
REQ_FN = re.compile(r"^req-\d+-\d+-(\d{4}-\d{2}-\d{2}T[\d\-]+Z)-.+\.json$")
# outage-myia-po-2024-20261019T043522_20261106T182443.7z — fenetre UTC encodee.
OUTAGE_FN = re.compile(
    r"^outage-(?P<machine>[A-Za-z0-9][A-Za-z0-9-]*)"
    r"-(?P<start>\d{8}T\d{6})_(?P<end>\d{8}T\d{6})\.7z$")

# Formulation AC3, verbatim : nomme l'inconnu, jamais « pas de trafic ».
BLIND_TEXT = ("no capture from {machine} in this window, "
              "outage traffic may not be reconciled yet")


def _parse_capture_ts(ts):
    """`2026-11-06T18-24-43-488Z` -> datetime UTC (tirets, pas de deux-points)."""
    try:
        return datetime.strptime(ts[:19], "%Y-%m-%dT%H-%M-%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _parse_tag(tag):
    """`20261019T043522` -> datetime UTC."""
    try:
        return datetime.strptime(tag, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def outage_archives(corpus_dir):
    """{machine: [(start_dt, end_dt, fname), ...]} — toutes fenetres confondues.

    Sert deux roles : source de fleet (une archive prouve un sidecar) et
    decompte par fenetre. Un repertoire sans reconcile/ rend {} — le cas du
    corpus hub tant que les archives ne sont pas collectees centralement.
    """
    out = {}
    rdir = os.path.join(corpus_dir, "reconcile")
    if not os.path.isdir(rdir):
        return out
    for fn in os.listdir(rdir):
        m = OUTAGE_FN.match(fn)
        if not m:
            continue
        start, end = _parse_tag(m.group("start")), _parse_tag(m.group("end"))
        if start is None or end is None:
            continue
        out.setdefault(m.group("machine"), []).append((start, end, fn))
    return out


def count_nominal_by_machine(corpus_dir, window_start, window_end):
    """{machine: n} des req-*.json dans la fenetre, par champ d'enveloppe.

    Tete de 400 octets : le champ machine vit en debut d'enveloppe (#98),
    avant le body. machine absente -> "" (trafic direct du hub, compte a part
    mais jamais BLIND : un client direct n'a pas de mode autonome).
    """
    counts = {}
    try:
        names = os.listdir(corpus_dir)
    except OSError:
        return counts
    for fn in names:
        m = REQ_FN.match(fn)
        if not m:
            continue
        dt = _parse_capture_ts(m.group(1))
        if dt is None or dt < window_start or dt >= window_end:
            continue
        try:
            with open(os.path.join(corpus_dir, fn), "rb") as fh:
                head = fh.read(400).decode("utf-8", errors="replace")
        except OSError:
            continue
        mm = MACHINE_FIELD.search(head)
        machine = mm.group(1) if mm else ""
        counts[machine] = counts.get(machine, 0) + 1
    return counts


def assess(corpus_dir, window_start, window_end, fleet_extra=()):
    """-> {machine: {"nominal": n, "archives": n, "blind": bool}}, + "" inclus.

    "" (direct) est rapporte mais jamais BLIND : un client direct du hub n'a
    pas de sidecar, donc pas d'angle mort. Une machine hors fleet et sans
    archive n'est pas claimee sidecar — l'absence d'une machine inconnue
    n'est pas un mensonge du corpus.
    """
    archives = outage_archives(corpus_dir)
    fleet = set(m for m in fleet_extra if m)
    fleet |= set(archives)
    nominal = count_nominal_by_machine(corpus_dir, window_start, window_end)
    res = {}
    for machine in sorted(fleet | set(nominal)):
        n_arch = sum(
            1 for (s, e, _fn) in archives.get(machine, ())
            if s < window_end and e >= window_start)
        n_nom = nominal.get(machine, 0)
        res[machine] = {
            "nominal": n_nom,
            "archives": n_arch,
            "blind": bool(machine) and machine in fleet and n_nom == 0 and n_arch == 0,
        }
    return res


def render(corpus_dir, window_start, window_end, fleet_extra=()):
    """-> liste de lignes a imprimer (section complete, vide = rien a dire).

    Fleet vide -> UNE ligne d'inactivite (une section silencieuse cacherait la
    capacite elle-meme). Chaque machine de la fenetre (fleet ou vue) est
    listee avec ses deux compteurs ; les BLIND ajoutent la formulation AC3.
    """
    res = assess(corpus_dir, window_start, window_end, fleet_extra)
    if not res:
        return [
            "angle mort AUTONOMOUS: aucune machine flotte declaree "
            "(--fleet m1,m2) ni archive reconcile/ -> verification inactive"
        ]
    lines = []
    for machine, r in res.items():
        label = machine if machine else "(direct hub)"
        line = (f"  {label}: nominal {r['nominal']} req, "
                f"archives outage {r['archives']}")
        if r["blind"]:
            line += (f" -> BLIND — {BLIND_TEXT.format(machine=machine)}")
        lines.append(line)
    return lines


def section(corpus_dir, window_start, window_end, fleet_extra=()):
    """-> lignes pretes a imprimer, en-tete de section inclus."""
    body = render(corpus_dir, window_start, window_end, fleet_extra)
    head = ("== angle mort AUTONOMOUS (nominal 0 = peut-etre autonome "
            "non reconcile, pas forcement absence de trafic) ==")
    return [head] + body
