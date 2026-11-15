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
  archives  = archives outage-<M>-<start>_<end>.7z dont la fenetre
              [start, end] (UTC, encodee dans le nom) chevauche la fenetre
              demandee. Sources (union, dedoublonnee par nom) : --reconcile-dir
              (defaut : le dossier GDrive ou reconcile-outage-captures.ps1
              depose les archives — le corpus hub n'a PAS de reconcile/ local,
              #940) et <corpus>/reconcile (staging local d'un siege sidecar,
              qui garde sa copie apres l'upload GDrive).
  BLIND     = machine de la fleet avec nominal == 0 ET archives == 0.
              La formulation nomme l'INCONNU, jamais « pas de trafic ».

Charge : un listdir du repertoire + un listdir par repertoire d'archives + la
lecture des tetes (400 octets) des SEULS req-*.json dans la fenetre — sauf si
le lecteur tend deja ses comptes par machine (nominal_counts, le cas de
traffic-consumption.py qui lit chaque tete pour l'appariement).
"""

import os
import re
from concurrent.futures import ThreadPoolExecutor
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

# Ou reconcile-outage-captures.ps1 depose les archives ($GDriveDir + reconcile).
# Le corpus hub n'a pas de reconcile/ local : sans ce dossier separat, le demi-
# decompte « archives » du predicat BLIND ne mesure rien (#940 CR point 1).
GDRIVE_RECONCILE_DIR = r"G:\Mon Drive\MyIA\backups\claudish-captures\reconcile"


def default_reconcile_dir():
    """Repertoire d'archives par defaut : env CLAUDISH_RECONCILE_DIR (tests,
    siege sans G:) sinon le dossier GDrive du script de reconciliation."""
    return os.environ.get("CLAUDISH_RECONCILE_DIR") or GDRIVE_RECONCILE_DIR


# #997 — les tete-lectures passent en pool BORNE. Sur UNC, chaque ouverture
# coute ~95 ms (mesure ai-01 : 150 ouvertures = 14,27 s) : la passe serie du
# census et des verdicts depassait 30 min sur une fenetre de 8 h (exit 124
# avant tout verdict). Le plafond sert a diviser la LATENCE reseau, pas a
# ouvrir le corpus a 10 000 threads simultanes.
DEFAULT_HEAD_WORKERS = 16


def read_head(path, size=400):
    """Premiers `size` octets de `path` (tout le fichier si size=None),
    decode utf-8/replace, ou None sur OSError — le chemin serie faisait
    try/except + continue ; le None porte le meme sens, l'appelant decide.

    Lecture BINAIRE puis decode : equivalent au mode texte errors=replace
    pour les en-tetes ASCII parses ici (les regex ne voient pas \r\n), et
    `size` compte des octets, pas des caracteres.
    """
    try:
        with open(path, "rb") as fh:
            return (fh.read() if size is None else fh.read(size)).decode(
                "utf-8", errors="replace")
    except OSError:
        return None


def read_heads(paths, size=400, workers=DEFAULT_HEAD_WORKERS):
    """Tetes de `paths` -> liste dans L'ORDRE DES ENTREES, quel que soit
    l'ordre de completion (ex.map) : la sortie reste deterministe, identique
    a la passe serie. workers <= 1 -> chemin exactement serie, SANS pool :
    `--workers 1` est le temoin d'equivalence, pas un pool a un thread.
    Une OSError rend None a sa place (voir read_head).
    """
    if workers <= 1 or len(paths) <= 1:
        return [read_head(p, size) for p in paths]
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(lambda p: read_head(p, size), paths))


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


def outage_archives(corpus_dir, reconcile_dir=None):
    """{machine: [(start_dt, end_dt, fname), ...]} — toutes fenetres confondues.

    Sert deux roles : source de fleet (une archive prouve un sidecar) et
    decompte par fenetre. Sources = UNION dedoublonnee par nom de
    --reconcile-dir (dossier GDrive du script de reconciliation, #940) et de
    <corpus>/reconcile (staging local : le siege garde sa copie apres l'upload,
    et le dossier separat absent => fallback). Un repertoire absent rend
    simplement rien — le repertoire lui-meme est une source optionnelle, pas
    une erreur.
    """
    out = {}
    seen = set()
    dirs = []
    if reconcile_dir:
        dirs.append(reconcile_dir)
    dirs.append(os.path.join(corpus_dir, "reconcile"))
    for rdir in dirs:
        if not os.path.isdir(rdir):
            continue
        for fn in os.listdir(rdir):
            m = OUTAGE_FN.match(fn)
            if not m or fn in seen:
                continue
            start, end = _parse_tag(m.group("start")), _parse_tag(m.group("end"))
            if start is None or end is None:
                continue
            seen.add(fn)
            out.setdefault(m.group("machine"), []).append((start, end, fn))
    return out


def count_nominal_by_machine(corpus_dir, window_start, window_end,
                             workers=DEFAULT_HEAD_WORKERS):
    """{machine: n} des req-*.json dans la fenetre, par champ d'enveloppe.

    Tete de 400 octets : le champ machine vit en debut d'enveloppe (#98),
    avant le body. machine absente -> "" (trafic direct du hub, compte a part
    mais jamais BLIND : un client direct n'a pas de mode autonome).

    #997 : les tetes passent par read_heads (pool borne, `workers` threads).
    Le resultat est identique a la passe serie — aggregation par cle, une
    tete illisible (None) vaut le `continue` de l'OSError serie.
    """
    counts = {}
    try:
        names = os.listdir(corpus_dir)
    except OSError:
        return counts
    jobs = []
    for fn in names:
        m = REQ_FN.match(fn)
        if not m:
            continue
        dt = _parse_capture_ts(m.group(1))
        if dt is None or dt < window_start or dt >= window_end:
            continue
        jobs.append(os.path.join(corpus_dir, fn))
    for head in read_heads(jobs, size=400, workers=workers):
        if head is None:
            continue
        mm = MACHINE_FIELD.search(head)
        machine = mm.group(1) if mm else ""
        counts[machine] = counts.get(machine, 0) + 1
    return counts


def assess(corpus_dir, window_start, window_end, fleet_extra=(),
           reconcile_dir=None, nominal_counts=None,
           workers=DEFAULT_HEAD_WORKERS):
    """-> {machine: {"nominal": n, "archives": n, "blind": bool}}, + "" inclus.

    "" (direct) est rapporte mais jamais BLIND : un client direct du hub n'a
    pas de sidecar, donc pas d'angle mort. Une machine hors fleet et sans
    archive n'est pas claimee sidecar — l'absence d'une machine inconnue
    n'est pas un mensonge du corpus.

    nominal_counts : comptes {machine: n} deja etablis par le lecteur sur la
    MEME fenetre (traffic-consumption.py lit deja chaque tete req-* pour
    l'appariement — lui faire relire est le cout releve mesure sur UNC, #940).
    None -> census locale (tetes 400 o des seuls req-* dans la fenetre).
    """
    archives = outage_archives(corpus_dir, reconcile_dir)
    fleet = set(m for m in fleet_extra if m)
    fleet |= set(archives)
    if nominal_counts is None:
        nominal = count_nominal_by_machine(corpus_dir, window_start, window_end,
                                           workers=workers)
    else:
        nominal = dict(nominal_counts)
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


def render(corpus_dir, window_start, window_end, fleet_extra=(),
           reconcile_dir=None, res=None, workers=DEFAULT_HEAD_WORKERS):
    """-> liste de lignes a imprimer (section complete, vide = rien a dire).

    Fleet vide -> UNE ligne d'inactivite (une section silencieuse cacherait la
    capacite elle-meme). Chaque machine de la fenetre (fleet ou vue) est
    listee avec ses deux compteurs ; les BLIND ajoutent la formulation AC3.
    res : verdict assess() DEJA calcule (evite le double passage du lecteur
    qui appelle assess pour le JSON puis render pour le texte).
    """
    if res is None:
        res = assess(corpus_dir, window_start, window_end, fleet_extra,
                     reconcile_dir=reconcile_dir, workers=workers)
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


def section(corpus_dir, window_start, window_end, fleet_extra=(),
            reconcile_dir=None, workers=DEFAULT_HEAD_WORKERS):
    """-> lignes pretes a imprimer, en-tete de section inclus."""
    body = render(corpus_dir, window_start, window_end, fleet_extra,
                  reconcile_dir=reconcile_dir, workers=workers)
    head = ("== angle mort AUTONOMOUS (nominal 0 = peut-etre autonome "
            "non reconcile, pas forcement absence de trafic) ==")
    return [head] + body
