#!/usr/bin/env python3
"""partial_parts.py — declaration et lecture des parties de jour (#1152 c).

Depuis la decision c.7076270061 (fenetre roulante), `compress-captures.ps1
-SlotMode` packed toutes les 3 h les captures plus vieilles que W heures
(defaut 6) dans des PARTIES de jour `captures-<jour>-p<HHMM>[-<tag>].7z`,
la pase nocturne restant la passe finale du jour (`captures-<jour>.7z`).
Un jour complet = ses parties + son archive de jour.

Un lecteur qui ne scanne que les fichiers LOOSE du corpus sous-compte alors
silencieusement tout span packed : pour la fenetre demandee, les captures
d'un jour porte par des parties ne sont plus sur disque. Ce module rend
l'undercount EXPLICITE — meme doctrine que l'angle mort AUTONOMOUS (#933,
lib/blind_spot.py) : la formulation nomme l'INCONNU, jamais « pas de trafic ».

Trois services (AC 2 / AC 4 de la decision, plus le prechauffage #1195) :

  PARTIAL   — declaration declarative pour le lecteur qui n'ouvre PAS les
              parties (traffic-consumption, billed-attrib) : une ligne qui
              nomme le span non lu, pour que son « 0 » ne se lise pas comme
              un total.
  read_members() — extraction py7zr pour le lecteur qui doit etre EXACT
              (native-consumption --leak-policy, AC 4 : verdict identique
              avant/apres packing sur un jour rejoue).
  warm_first_open() — prechauffage de la PREMIERE OUVERTURE des fichiers
              extraits (#1195) : une ouverture par fichier, `workers` fils a
              la fois — l'attente a la premiere ouverture d'un fichier
              fraichement extrait ne parallelise pas dans le fil de
              l'appelant (mesure du 25/11 : 62,12 -> 8,41 ms par fichier).

Semantique de fenetre : le NOM d'une partie porte son jour et l'heure de sa
passe, pas l'etendue de son contenu (bornes = passe - W .. passe, non
encodables sans ouvrir). Le filtre est donc au JOUR — chevauchement honnete,
jamais plus fin que ce que le nom prouve.
"""

import os
import re
from datetime import timedelta

# captures-2026-11-22-p1147.7z / captures-2026-11-22-p1147-myia-po-2025.7z
# Le segment -p<4 chiffres> est reconnu le PREMIER partout (PS comme Python) :
# aucun tag de flotte ne matche ^p\d{4}$, donc pas d'ambiguite nom/tag.
PART_FN = re.compile(
    r"^captures-(?P<day>\d{4}-\d{2}-\d{2})-p(?P<slot>\d{4})"
    r"(?:-(?P<tag>[A-Za-z0-9._-]+))?\.7z$")

# L'archive de jour classique (passe nocturne) — pour les lecteurs d'archives
# qui doivent UNION jour + parties (AC 3).
DAY_ARCHIVE_FN = re.compile(r"^captures-(\d{4}-\d{2}-\d{2})(?:-[A-Za-z0-9._-]+)?\.7z$")

# Ou compress-captures.ps1 ecrit les archives : <corpus>\archive (defaut du
# script, Join-Path $CaptureDir "archive") — meme convention de dossier
# separat que <corpus>/reconcile pour blind_spot.
ARCHIVE_SUBDIR = "archive"

# Formulation AC 2 : nomme l'inconnu, jamais « pas de trafic » ni « total ».
PARTIAL_TEXT = ("day parts cover {span} and this reader does not open them — "
                "counts undercount that span, open the parts for exact totals")


def archive_dir(captures_dir):
    return os.path.join(captures_dir, ARCHIVE_SUBDIR)


def list_parts(captures_dir):
    """[{day, slot, tag, fname, path}] — toutes les parties, triees
    (jour, slot, tag). Repertoire absent -> liste vide : le dossier est une
    source optionnelle, pas une erreur (corpus sans slot mode arme)."""
    out = []
    adir = archive_dir(captures_dir)
    try:
        names = os.listdir(adir)
    except OSError:
        return out
    for fn in names:
        m = PART_FN.match(fn)
        if not m:
            continue
        out.append({
            "day": m.group("day"), "slot": m.group("slot"),
            "tag": m.group("tag") or "", "fname": fn,
            "path": os.path.join(adir, fn)})
    out.sort(key=lambda r: (r["day"], r["slot"], r["tag"]))
    return out


def _days_between(w_start, w_end):
    """Jours (str yyyy-mm-dd) chevauchant [w_start, w_end) — tz-aware attendus."""
    d = w_start.date()
    out = set()
    while True:
        out.add(d.isoformat())
        if d >= w_end.date():
            break
        d += timedelta(days=1)
    return out


def parts_in_window(captures_dir, w_start, w_end):
    """Parties dont le JOUR chevauche la fenetre (granularite honnete, voir
    module docstring)."""
    days = _days_between(w_start, w_end)
    return [r for r in list_parts(captures_dir) if r["day"] in days]


def day_archives_for(captures_dir, day):
    """[archive de jour si presente] + parties du jour (slot croissant) —
    l'UNION qui fait un jour complet pour un lecteur d'archives (AC 3).
    Le <captures_dir> est le corpus (archive/ en est deduit) ; un lecteur qui
    tient ses propres repertoires liste avec list_parts + DAY_ARCHIVE_FN."""
    out = []
    adir = archive_dir(captures_dir)
    try:
        names = os.listdir(adir)
    except OSError:
        return out
    for fn in names:
        m = DAY_ARCHIVE_FN.match(fn)
        # une partie n'est PAS l'archive de jour (meme tete de regex) :
        # PART_FN reconnu d'abord, la section -p<slot> l'exclut.
        if m and m.group(1) == day and not PART_FN.match(fn):
            out.append(os.path.join(adir, fn))
            break
    out.extend(r["path"] for r in list_parts(captures_dir) if r["day"] == day)
    return out


def assess_many(capture_dirs, w_start, w_end, merged_paths=()):
    """assess() sur PLUSIEURS racines de corpus (#1180) — union dedupliquee
    par NOM de partie : une partie deplacee d'une racine a l'autre est UNE
    partie, pas deux. Un corpus reparti sur deux disques ne doit pas faire
    compter deux fois le meme jour, ni en oublier un."""
    if isinstance(capture_dirs, (str, os.PathLike)):
        capture_dirs = [capture_dirs]
    seen, parts = set(), []
    for d in capture_dirs:
        for r in parts_in_window(d, w_start, w_end):
            if r["fname"] in seen:
                continue
            seen.add(r["fname"])
            parts.append(r)
    merged = set(os.path.normcase(os.path.abspath(p)) for p in merged_paths)
    live = [r for r in parts
            if os.path.normcase(os.path.abspath(r["path"])) not in merged]
    days = sorted({r["day"] for r in live})
    return {"partial": bool(live), "parts": live, "days": days,
            "merged": len(merged)}


def assess(captures_dir, w_start, w_end, merged_paths=()):
    """-> {"partial": bool, "parts": [records], "days": [..], "merged": n}.

    merged_paths : chemins deja extraits et fusionnes par l'appelant (cas
    read_members) — une partie mergee n'est plus un undercount, elle sort du
    verdict PARTIAL.
    """
    return assess_many([captures_dir], w_start, w_end, merged_paths=merged_paths)


def render(captures_dir, w_start, w_end, merged_paths=(), res=None):
    """-> lignes a imprimer. Vide = rien a declarer (aucune partie non lue
    dans la fenetre) : un lecteur exact ne porte pas d'avertissement."""
    if res is None:
        res = assess(captures_dir, w_start, w_end, merged_paths=merged_paths)
    if not res["partial"]:
        return []
    span = res["days"][0] if len(res["days"]) == 1 else f"{res['days'][0]}..{res['days'][-1]}"
    return [
        f"  parts: {len(res['parts'])} day part(s) overlap the window "
        f"({', '.join(res['days'])})",
        f"  -> PARTIAL — {PARTIAL_TEXT.format(span=span)}",
    ]


def section(captures_dir, w_start, w_end, merged_paths=(), res=None):
    """-> lignes pretes a imprimer, en-tete inclus (vide = rien)."""
    body = render(captures_dir, w_start, w_end, merged_paths=merged_paths,
                  res=res)
    if not body:
        return []
    head = ("== fenetre PARTIELLE (jour en parties #1152 c, non ouvertes "
            "par ce lecteur) ==")
    return [head] + body


def read_members(paths, dest, keep=None):
    """Extrait les membres selectionnes de `paths` (parties et/ou archives de
    jour) vers `dest`, -> chemins extraits (os.walk, basenames uniques attendus
    — les captures n'ont pas de prefixe interne, mais l'arbre recree par
    l'extraction est traverse par securite).

    keep : callable(basename) -> bool (filtre avant extraction : c'est LUI qui
    borne le volume — fenetre ts du lecteur, prefxes req-/resp-). Une archive
    illisible ou py7zr absent leve — l'appelant decide de sa politique de
    degradation (PARTIAL), jamais de silence.

    Le caller possede dest (tempfile.mkdtemp sous %TEMP%) et le nettoie.
    """
    import py7zr

    for path in paths:
        with py7zr.SevenZipFile(path) as z:
            if keep is None:
                z.extractall(path=dest)
                continue
            targets = [n for n in z.getnames()
                       if keep(os.path.basename(n))]
            if targets:
                z.extract(targets=targets, path=dest)
    out = []
    for root, _dirs, files in os.walk(dest):
        for fn in files:
            out.append(os.path.join(root, fn))
    return out


# ---------------------------------------------------------------------------
# #1195 — prechauffage de la PREMIERE OUVERTURE des fichiers extraits
# ---------------------------------------------------------------------------

# Ce que le prechauffage lit : les octets qu'un lecteur d'archives garde d'une
# reponse (traffic-consumption.py : HEAD_BYTES 200 000 + TAIL_BYTES 100 000),
# et l'acces exact que la mesure du 25/11 a chronometre. Changer cette valeur
# change ce qui a ete mesure — re-mesurer alors (pin : test_partial_parts.py).
WARM_READ_BYTES = 300_000
WARM_POOL = 8


def _touch(path):
    """Ouvre `path` une premiere fois et lit sa tete -> octets lus."""
    with open(path, "rb") as fh:
        return len(fh.read(WARM_READ_BYTES))


def warm_first_open(paths, workers=WARM_POOL):
    """Ouvre chaque fichier de `paths` UNE fois, `workers` fils a la fois ->
    nombre de fichiers ouverts. Une erreur d'ouverture ne leve pas : le
    fichier est saute et n'est pas compte (le lecteur le retrouvera et
    appliquera SA politique).

    Mesure du 25/11 (2 000 membres REELS d'un jour du hub, tir en creux) : la
    premiere ouverture d'un fichier fraichement extrait coute 62,12 ms en
    serie (124,24 s d'horloge pour 0,86 s de CPU du processus — 0,7 %) et
    8,41 ms par un pool de 8 fils (x7,4) ; une fois les fichiers ouverts, la
    passe du lecteur tourne a 0,9 ms par reponse sur son propre CPU.

    Ce n'est pas une lecture : aucun octet n'est garde ni analyse, aucun
    decompte ne bouge — l'appelant relit chaque fichier avec ses regles.
    `workers` <= 1 : tout sur le fil de l'appelant — le chiffre en serie, et
    l'interrupteur.

    paths : chemins (str). workers : fils ; <= 1 = aucun pool.
    """
    if not workers or workers <= 1:
        n = 0
        for p in paths:
            try:
                _touch(p)
                n += 1
            except OSError:
                pass
        return n
    from concurrent.futures import ThreadPoolExecutor

    def one(path):
        try:
            _touch(path)
            return 1
        except OSError:
            return 0

    with ThreadPoolExecutor(workers) as ex:
        return sum(ex.map(one, paths))
