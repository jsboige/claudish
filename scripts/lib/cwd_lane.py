#!/usr/bin/env python3
"""cwd_lane.py — LE parsing du cwd de preambule, une seule copie (#1055 item 2).

Extrait de capture-workspace-attribution.py, ou il etait ne et pince
(#328 M1 : les trois pieges y ont chacun une mesure), pour que
native-consumption.py --leak-policy cesse d'avoir un axe « lane » sans
copie PRIVEE du parsing — c'est exactement la divergence que lib/subagent_flag.py
(#1051) a fermee pour `cc_is_subagent` : deux copies d'un predicat a pieges
divergent, et celle qui diverge ment sans lever d'erreur.

Les trois pieges, mesures sur corpus :

  * SUFFIXE `(was ...)` — depuis ~2026-09-08 le preambule lit
    `d:\\dev\\CoursIA (was c:\\dev\\CoursIA)`. Couper sur le separateur sans
    retirer le suffixe rend `coursia)` : 38 des 300 corps echantillonnes
    ce jour-la, chaque workspace coupe en deux.
  * ANTISLASH AVANT LE `\\n` — un separateur litteral est `\\\\` et le
    saut de ligne JSON est `\\n` : dezapper `\\\\` EN PREMIER, sinon
    `d:\\dev\\new` se coupe en `d:`.
  * DERNIER MARQUEUR GAGNE — un corps peut citer un preambule plus ancien
    (tool_result, resume de compaction) ; le repertoire de la requete est
    le DERNIER.

Et la regle de sortie, qui n'est pas du parsing : le basename du cwd,
JAMAIS le chemin (arbitrage coordinateur 15/11). Un chemin est prive
(un identifiant d'utilisateur, de machine, d'organisation s'y lisent) ;
un nom de workspace est un axe de tableau.
"""

import re

MARKER = b"Primary working directory:"
WINDOW = 400
PREVIOUS = re.compile(r"\s+\((?:was|previously)\b[^)]*\)", re.IGNORECASE)
ABSOLUTE = re.compile(r"^(?:[A-Za-z]:[\\/]|[/\\])")
ROOT = "(root)"
UNPARSED = "(unparsed)"


def marker_line(body: bytes | str) -> str | None:
    """La ligne workspace du DERNIER preambule du corps, dezappee.

    Accepte bytes (lecture fichier de l'instrument canonique) et str (le
    pool de lecture de blind_spot rend du texte decode) — le marqueur et
    les echappements sont ASCII, la coercition est sans perte pour eux.
    """
    if isinstance(body, str):
        body = body.encode("utf-8", "replace")
    idx = body.rfind(MARKER)
    if idx < 0:
        return None
    chunk = body[idx + len(MARKER): idx + len(MARKER) + WINDOW].decode("utf-8", "replace")
    chunk = chunk.replace("\\\\", "\x00")          # a literal path separator
    chunk = chunk.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"')
    chunk = chunk.replace("\x00", "\\")
    line = chunk.split("\n", 1)[0].split('"', 1)[0]
    return line.strip().rstrip("\\").strip()


def lane_key(body: bytes | str):
    """(basename du cwd, vient_de_claude_code), ou (None, False) sans marqueur.

    Le basename est en MINUSCULES, comme l'instrument canonique : un axe de
    tableau se compare, pas se devine. None n'est pas un workspace : c'est
    « pas de preambule CC ici », et seul l'appelant sait quel seau non-CC
    (l'instrument canonique garde ses signatures Hermes, la leak-policy
    garde son seau (non-cc) unique).

    Le marqueur existe aussi DANS DU CODE QUOTE (un script ou un prompt qui
    discute de cette chaine) : une telle ligne n'est pas un repertoire, et
    le seau visible est UNPARSED — jamais un workspace fabrique sur un
    fragment de source.
    """
    line = marker_line(body)
    if line is None:
        return None, False
    path = PREVIOUS.sub("", line).strip()
    if not ABSOLUTE.match(path):
        return UNPARSED, True
    path = path.replace("\\", "/").rstrip("/")
    leaf = path.split("/")[-1].strip() if path else ""
    # Pas de retrait generique de ponctuation finale : un workspace peut
    # legitimement finir par `)`. Un rendu inconnu doit s'afficher comme
    # lui-meme, pas se fondre dans le seau voisin.
    return (leaf.lower() or ROOT), True
