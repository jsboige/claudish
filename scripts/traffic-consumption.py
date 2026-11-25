#!/usr/bin/env python3
"""traffic-consumption.py — tableau de consommation flotte par lane (Epic #41, Phase 1).

Source : les captures du hub (req-*.json + resp-*.sse). Sortie : rollup par
lane provider x bucket (cron / interactive / agent-sdk / other), avec tokens
in/out, cache read/creation, hit-rate et debit/h sur la fenetre.

Usage:
  python scripts/traffic-consumption.py --hours 3
  python scripts/traffic-consumption.py --hours 24 --machines
  python scripts/traffic-consumption.py --hours 24 --json      # pour le join Phase 3
  python scripts/traffic-consumption.py --per-day --json       # serie par jour (#1161)
  python scripts/traffic-consumption.py --from-archive 2026-11-22
      # #1161 — UN jour lu depuis son archive, UNE fois, ajoute a la serie
      # persistante (~/.claudish/traffic-days.json). Corpus du hub : en creux
      # 05-07Z seulement, un jour par appel.

PIEGES encodes (mesures Epic #41 + harness-injection-measure.py) :
1) (pid, reqN) n'est PAS unique — le compteur repart a 0 a chaque redemarrage
   du container. On indexe par CLE -> LISTE horodatee et on tranche par le
   temps : la requete PRECEDE sa reponse (derniere candidate <= resp_ts).
2) GLM (wire openai) emet un bloc usage ZERO avant le vrai : la selection du
   triplet coherant (piege 6) ne choisit jamais le bloc zero — son enonce
   d'entree est vide (in+cr+cc = 0).
3) Les lanes wire-openai (GLM, DeepSeek, Qwen-api) ne rapportent PAS de cache
   : hit% = n/a (pas 0%) — c'est une absence de donnee, pas un echec de cache.
4) Le bucket vient du bloc system `x-anthropic-billing-header:` de la REQUETE
   (cc_workload=cron en flag ~33%, cc_entrypoint ~100%). Couverture partielle
   de cc_workload = semantique de flag : absent signifie "pas cron".
   Reconciliation : le bucket "other" inclut les probes/ingress non-CC ; si
   cc_entrypoint manque sur une requete CC, on surclasse "other" — mesure
   24/08 : 0 cas sur l'echantillon.
5) Les fichiers geants (1 Mo+) ont leur dernier message_delta AU-DELA de la
   tete lue : on lit tete 200 Ko + queue 100 Ko, jamais seulement la tete.
6) (#600, le defect G10 de #328) Les compteurs d'ENTREE d'une capture sont lus
   comme UN triplet coherant, JAMAIS champ par champ : message_start porte une
   graine (input_tokens = tour precedent de la session) et le message_delta
   terminal porte le triplet coherent avec le decoupage cache applique — le
   max par champ melange deux instantanes jamais emis ensemble et double le
   prompt (mesure 22/10 : graine 250 494 + triplet terminal 117 316 -> x3,1 ;
   11/42 captures locales gonflees > 5 %). Regle PARTAGEE avec
   lane-out-trend.py (scan_usage/select_usage, ai-01 review #414) : le
   DERNIER bloc d'enonce d'entree non vide (in+cr+cc > 0) gagne ENTIERS ;
   message_start tient lieu si le stream est mort avant lui. output_tokens
   reste la valeur terminale (cumulatif monotone). La jonction tete+queue du
   piege 5 peut couper une ligne data: en deux : scan_usage l'ignore (JSON
   indecodable), le bloc terminal vit dans la queue.
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from collections import Counter, defaultdict

REQ_FN = re.compile(r"^req-(\d+)-(\d+)-(.+)\.json$")
RESP_FN = re.compile(r"^resp-\d+-r\d+-(\d{4}-\d{2}-\d{2}T[\d-]+Z)-(.+)\.sse$")
HDR = re.compile(r"^#\s*parser=(\S+)\s+model=(\S+)\s+reqN=(\d+)\s+pid=(\d+)", re.M)
RESP_TS = re.compile(r"resp-\d+-r\d+-(\d{4}-\d{2}-\d{2}T[\d-]+Z)-")

MACHINE_FIELD = re.compile(r'"machine"\s*:\s*"([^"]*)"')
# Modele DEMANDE : le `model` de l'enveloppe (request-logger.ts le siege a
# moins de 400 octets du debut, avant tout champ fourni par le client). La
# recherche est bornee au debut de la tete : dans le corps, un `"model"` d'un
# resultat d'outil ne doit pas gagner. Sert le decompte des sans-reponse.
MODEL_FIELD = re.compile(r'"model"\s*:\s*"([^"]+)"')
REQ_ENVELOPE_BYTES = 4096
# #1055 — lane harnais (champ enveloppe, TOUJOURS ecrit cote proxy depuis
# #1055 : "" = pas de lane, cle absente = capture pre-#1055). La recherche est
# BORNEE a la zone avant "body" : sur un corpus pre-#1055, une occurrence de
# "lane" dans le corps (resultat d'outil web, message) ne doit pas gagner.
LANE_FIELD = re.compile(r'"lane"\s*:\s*"([^"]*)"')
BILLING_EP = re.compile(r"cc_entrypoint=([^;\s]+)")
BILLING_WL = re.compile(r"cc_workload=([^;\s]+)")
# #98: champs d'attribution persistes dans l'enveloppe (avant le body dans le
# fichier => premier match = champ enveloppe quand present ; fallback regex du
# bloc billing pour les captures pre-#98).
ENTRYPOINT_FIELD = re.compile(r'"entrypoint"\s*:\s*"([^"]*)"')
WORKLOAD_FIELD = re.compile(r'"workload"\s*:\s*"([^"]*)"')

HEAD_BYTES = 200_000
TAIL_BYTES = 100_000
REQ_HEAD_BYTES = 150_000


def _load_bare_roles():
    import importlib.util
    from pathlib import Path

    p = Path(__file__).resolve().parent / "lib" / "bare_roles.py"
    spec = importlib.util.spec_from_file_location("bare_roles", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_lane_out_trend():
    """Lecteur d'usage partage avec lane-out-trend.py (#600 — une seule copie
    de la regle du triplet coherant, jamais deux qui derivent). Nom de fichier
    dashé : pas importable en module, spec_from_file_location comme
    lib/bare_roles.py."""
    import importlib.util
    from pathlib import Path

    p = Path(__file__).resolve().parent / "lane-out-trend.py"
    spec = importlib.util.spec_from_file_location("lane_out_trend", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_blind_spot():
    """Declaration de l'angle mort AUTONOMOUS (#933) — lib partagee avec
    native-consumption.py et billed-attrib.py, une seule copie."""
    import importlib.util
    from pathlib import Path

    p = Path(__file__).resolve().parent / "lib" / "blind_spot.py"
    spec = importlib.util.spec_from_file_location("blind_spot", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_partial_parts():
    """Parties de jour #1152 c (declaration PARTIAL) — lib partagee avec
    native-consumption.py et billed-attrib.py, une seule copie."""
    import importlib.util
    from pathlib import Path

    p = Path(__file__).resolve().parent / "lib" / "partial_parts.py"
    spec = importlib.util.spec_from_file_location("partial_parts", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_LOT = _load_lane_out_trend()


# Lane provider par nom de modele servit (l'en-tete resp porte le modele FINAL).
LANES = [
    (re.compile(r"^glm-"), "gc@ GLM Coding"),
    (re.compile(r"^MiniMax", re.I), "mmc@ MiniMax"),
    (re.compile(r"^qwen", re.I), "qwen-token-plan"),
    (re.compile(r"^deepseek", re.I), "ds@ PAYG"),
    # #564: survives minor/major bumps — `gpt-5.6-sol` pinned the lane, `gpt-6.1-sol`
    # (post-#307 served id) fell through to an unnamed lane.
    (re.compile(r"^gpt-[5-9][.\d]*-sol|^codex", re.I), "cx@ Sol (OpenAI Pro)"),
    (re.compile(r"^claude-"), "native-anthropic"),
    # #555: a bare role name as the SERVED model only happens on the native lane
    # (every other lane serves its resolved target id); the native pin (#218)
    # normally rewrites it to `claude-*`, this catches the unpinned case.
    # Vocabulaire canonique partagé avec harness-injection-measure.py
    # (lib/bare_roles.py) — muter la constante rougit les deux suites (#583 note).
    (_load_bare_roles().BARE_ROLE_RE, "native-anthropic"),
]
# Les lanes wire-openai ne rapportent aucun champ de cache (piege 3).
NO_CACHE_LANES = {"gc@ GLM Coding", "ds@ PAYG"}


def lane_for(model):
    for rx, lane in LANES:
        if rx.match(model):
            return lane
    return model


def capture_dt(ts):
    """`2026-08-20T19-10-11-203Z` -> datetime UTC (tIRETS, pas de deux-points)."""
    try:
        return datetime.strptime(ts[:19], "%Y-%m-%dT%H-%M-%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def usage_of(text):
    """Triplet d'usage COHERANT pour une capture (#600, defect G10 de #328).

    Delegue au lecteur partage de lane-out-trend.py : le max PAR CHAMP est
    interdit pour les compteurs d'entree (mesure : graine message_start
    (244812, 0, 0) + delta terminal (67, 244800, 0) -> les maxima lus 489612
    ou le triplet coherent terminal vaut 244867 — le decoupage cache a DEPLACE
    la masse, il ne l'a pas doublee). Selection : le DERNIER bloc d'enonce
    d'entree non vide (in+cr+cc > 0) gagne ENTIERS ; si le stream est mort
    avant lui, le triplet de message_start tient lieu, coherant, jamais mixe.
    output_tokens garde la valeur TERMINALE (cumulative monotone : egale le
    max, mais le contrat est « terminal », pas « plus grand »). Le cas GLM
    « usage zero puis le vrai » (piege 2) est couvert par construction : un
    bloc zero n'a pas d'enonce d'entree, il n'est jamais choisi.

    Retourne (in, out, cache_read, cache_creation), ou None si la capture ne
    porte AUCUN bloc d'usage.
    """
    blocks, _line_fail = _LOT.scan_usage(text)
    if not blocks:
        return None
    chosen, out = _LOT.select_usage(blocks)
    if chosen is None:
        # tout bloc zero-seed : aucun enonce d'entree — lu 0, pas None
        # (None = « la capture ne parle pas d'usage », un autre compteur)
        return (0, out or 0, 0, 0)
    return (chosen["in"], out or 0, chosen["cr"], chosen["cc"])


def read_head_tail(path, head=HEAD_BYTES, tail=TAIL_BYTES):
    with open(path, "rb") as fh:
        head_txt = fh.read(head).decode("utf-8", errors="replace")
        size = fh.seek(0, 2)
        if size <= head:
            return head_txt
        if size <= head + tail:
            fh.seek(head)
            return head_txt + fh.read().decode("utf-8", errors="replace")
        fh.seek(size - tail)
        return head_txt + fh.read(tail).decode("utf-8", errors="replace")


def bucket_of(info):
    """4 buckets : cron / interactive / agent-sdk / other."""
    if info["wl"] == "cron":
        return "cron"
    ep = info["ep"]
    if ep and ep.startswith("sdk"):
        return "agent-sdk"
    if ep:
        return "interactive"
    return "other"


def load_requests(cdir, cutoff_dt, seen=None, until_dt=None, names=None):
    """(pid, reqN) -> liste horodatee de dicts {ts, machine, ep, wl}.

    On ne lit que la TETE du fichier : machine + bloc billing system sont
    toujours en debut de corps (system precede messages/tools sur le wire
    anthropique). Le JSON complet (jusqu'a 1 Mo) ne sert a rien ici.

    seen (#1180) : noms deja consommes par une autre racine de corpus — mute
    ici, partage avec la boucle resp de main(), pour que l'union de plusieurs
    `--dir` soit dedupliquee par NOM de fichier (premiere racine gagne).

    until_dt : borne haute EXCLUSIVE (None = pas de borne) — le mode
    --from-archive (#1161) lit un JOUR, [minuit, minuit).
    names : le contenu DEJA LISTE de `cdir` — collect() liste chaque racine une
    fois pour etablir la couverture. Absent -> liste ici (contrat d'origine
    des lecteurs qui importent cette fonction).
    """
    if seen is None:
        seen = set()
    reqs = defaultdict(list)
    for fn in (os.listdir(cdir) if names is None else names):
        if fn in seen:
            continue
        m = REQ_FN.match(fn)
        if not m:
            continue
        dt = capture_dt(m.group(3))
        if dt is None or dt < cutoff_dt:
            continue
        if until_dt is not None and dt >= until_dt:
            continue
        seen.add(fn)
        try:
            with open(os.path.join(cdir, fn), "rb") as fh:
                head = fh.read(REQ_HEAD_BYTES).decode("utf-8", errors="replace")
        except OSError:
            continue
        mm = MACHINE_FIELD.search(head)
        em = ENTRYPOINT_FIELD.search(head) or BILLING_EP.search(head)
        wm = WORKLOAD_FIELD.search(head) or BILLING_WL.search(head)
        # #1055 — borné à l'enveloppe (avant "body") : voir LANE_FIELD.
        env = head[: head.find('"body"')] if '"body"' in head else head
        lm = LANE_FIELD.search(env)
        dm = MODEL_FIELD.search(head[:REQ_ENVELOPE_BYTES])
        reqs[(int(m.group(1)), int(m.group(2)))].append({
            "ts": m.group(3),
            "machine": mm.group(1) if mm else "",
            "ep": em.group(1) if em else "",
            "wl": wm.group(1) if wm else "",
            "hlane": lm.group(1) if lm else "",
            "model": dm.group(1) if dm else "",
        })
    for v in reqs.values():
        v.sort(key=lambda d: d["ts"])
    return reqs


def pick_request(candidates, resp_ts):
    if not candidates:
        return None
    if resp_ts is None:
        return candidates[-1] if len(candidates) == 1 else None
    avant = [d for d in candidates if d["ts"] <= resp_ts]
    return avant[-1] if avant else None


def fmt_int(n):
    return f"{n:,}".replace(",", " ")


def root_coverage(dirs, errors=None, listed=None):
    """(#1180, review ai-01 finding 1) ce que le lecteur a VU des racines
    demandees — pas ce qu'on lui a demande. Une racine est couverte si son
    `listdir` reussit ; celle qui leve (absente, hors d'acces) est
    `uncovered` et se nomme sur STDOUT, pas seulement sur stderr : un lecteur
    qui ne lit que stdout verrait sinon `dirs=2` — l'angle mort que #1180
    existe pour interdire.

    -> {"requested": [racines], "covered": [racines], "uncovered": [racines]}
    errors (dict, optionnel) : rempli {racine: "<Type>: <message>"} pour les
    racines non couvertes — le texte de l'erreur sert au refus, jamais a la
    cle `coverage` (sa forme est celle de la review : trois listes).
    listed (#1181) : la liste qui a DEJA servi a lire, [(racine, noms)].
    Presente -> la couverture est celle de CETTE lecture, pas d'une seconde
    liste prise apres coup (une racine qui lache entre les deux se declarerait
    couverte sans avoir ete lue).
    """
    if listed is not None:
        covered = [d for d, _names in listed]
        read = set(covered)
        return {"requested": list(dirs), "covered": covered,
                "uncovered": [d for d in dirs if d not in read]}
    covered, uncovered = [], []
    for d in dirs:
        try:
            os.listdir(d)
        except OSError as exc:
            uncovered.append(d)
            if errors is not None:
                errors[d] = f"{type(exc).__name__}: {exc}"
        else:
            covered.append(d)
    return {"requested": list(dirs), "covered": covered, "uncovered": uncovered}


def coverage_line(coverage):
    """`COVERAGE dirs=<lues>/<demandees>[ uncovered=<racine>,<racine>]` —
    le nombre de racines LUES sur le nombre DEMANDEES ; les non-lues sont
    nommées sur la ligne."""
    line = (f"COVERAGE dirs={len(coverage['covered'])}/"
            f"{len(coverage['requested'])}")
    if coverage["uncovered"]:
        line += " uncovered=" + ",".join(coverage["uncovered"])
    return line


def build_days(per_day, corpus_dirs, cutoff_dt, now_dt, reqs, fleet,
               reconcile_dir, opened=False, only=False, coverage=None):
    """Serie par JOUR UTC (#1161 stage 2, grain producteur) — la consommation
    que `activity-cost-join.py` met en regard des contributions GitHub.

    -> [{"date", "n", "in", "out", "cache_create", "cache_read",
         "partial"?, "partial_reasons"?, "blind"?, "blind_machines"?,
         "source"?, "archive"?, "loose_residual"?, "coverage"?}]

    Un jour n'est emis que s'il PORTE une mesure (resp lue) ou une
    DECLARATION (partie de jour / archive de jour, #1152 c) : un jour sans
    rien n'est pas un zero de consommation, il est absent — le joiner le
    nomme `activity-only` au lieu d'inventer un inEq nul.

    corpus_dirs : racines du corpus (#1180). Les DECLARATIONS sont l'union
    des racines dedupliquee par NOM — la premiere racine gagne, comme
    assess_many : un jour packe sur un second disque n'est pas oublie, une
    partie presente deux fois n'est pas comptee deux fois. L'angle mort
    (archives outage, repertoire reconcile) se lit sous la PREMIERE racine.

    partial : jour courant (pas fini), premier jour de la fenetre (coupe au
    cutoff, pas a minuit), et tout jour dont les captures sont packees en
    parties ou en archive de jour — en lecture LOOSE ce lecteur ne les ouvre
    pas (la lecture exacte est native-consumption --leak-policy). Jamais
    ratio-able.

    opened : l'appelant A ouvert les parties et l'archive du jour (mode
    --from-archive) : les declarations « packe » ne sont alors pas un non-lu,
    la ligne porte source="archive" (provenance ajoutee par l'appelant).
    only : n'emettre que les jours PORTEURS d'une mesure — le mode
    --from-archive lit UN jour, il n'emet pas les declarations des autres.

    blind : predicat de lib/blind_spot.py applique au JOUR (machine de la
    flotte a 0 nominal ET 0 archive ce jour = inconnu, pas zero) ; archives
    listees UNE fois pour toute la serie, la regle reste celle de la lib.
    coverage (#1180) : objet de root_coverage. Une racine NON LUE marque
    CHAQUE jour `uncovered-roots:<n>` — le jour vient d'un corpus a demi lu,
    le joiner le refuse comme tout `partial` ; jamais un ratio en silence.
    """
    cdir = corpus_dirs[0]
    pp = _load_partial_parts()
    part_days = Counter()
    arch_days = set()
    if not (opened and only):
        seen = set()
        for _d in corpus_dirs:
            try:
                names = os.listdir(pp.archive_dir(_d))
            except OSError:
                continue
            for fn in names:
                if fn in seen:
                    continue
                seen.add(fn)
                m = pp.PART_FN.match(fn)
                if m:
                    part_days[m.group("day")] += 1
                    continue
                m = pp.DAY_ARCHIVE_FN.match(fn)
                if m:
                    arch_days.add(m.group(1))

    bs = _load_blind_spot()
    archives = bs.outage_archives(cdir, reconcile_dir)

    nom_by_day = defaultdict(Counter)
    for lst in reqs.values():
        for r in lst:
            dt = capture_dt(r["ts"])
            if dt is not None:
                nom_by_day[dt.date().isoformat()][r["machine"]] += 1

    today = now_dt.date().isoformat()
    cutoff_day = cutoff_dt.date().isoformat()
    midnight = cutoff_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    starts_at_midnight = cutoff_dt == midnight

    declared = {d for d in part_days if d >= cutoff_day}
    declared |= {d for d in arch_days if d >= cutoff_day}
    days = []
    for day in (sorted(per_day) if only else sorted(set(per_day) | declared)):
        tot = per_day.get(day) or dict(n=0, inp=0, out=0, cread=0, ccre=0)
        row = {"date": day, "n": tot["n"], "in": tot["inp"], "out": tot["out"],
               "cache_create": tot["ccre"], "cache_read": tot["cread"]}
        reasons = []
        if day == today:
            reasons.append("current-day")
        if day == cutoff_day and not starts_at_midnight:
            reasons.append("window-start")
        if not opened:
            if part_days.get(day):
                reasons.append(f"packed:{part_days[day]}-parts")
            if day in arch_days:
                reasons.append("day-archive")
        if coverage and coverage["uncovered"]:
            reasons.append(f"uncovered-roots:{len(coverage['uncovered'])}")
        if reasons:
            row["partial"] = True
            row["partial_reasons"] = reasons
        d0 = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        d1 = d0 + timedelta(days=1)
        res = bs.assess(cdir, max(d0, cutoff_dt), min(d1, now_dt), fleet,
                        reconcile_dir=reconcile_dir,
                        nominal_counts=dict(nom_by_day.get(day, {})),
                        archives=archives)
        blind_m = sorted(m for m, r in res.items() if r["blind"])
        if blind_m:
            row["blind"] = True
            row["blind_machines"] = blind_m
        if opened:
            row["source"] = "archive"
        days.append(row)
    return days


def request_accounting(reqs, answered, bound_dt=None, max_paired_lag_s=None):
    """Requetes lues, repondues, sans reponse — et OU tombent les sans-reponse.

    Une requete = un fichier req-* (cle (pid, reqN, estample)). Repondue = au
    moins une resp l'a choisie (pick_request) ; une requete servie par deux
    fichiers de reponse (un changement de fournisseur en cours de flux rouvre
    un analyseur) compte UNE fois. Sans reponse = le proxy n'a ferme aucun
    analyseur pour elle : refus amont terminal, refus local, abandon du client
    avant les en-tetes, ecriture perdue. Le lecteur ne dit PAS la cause — il
    dit qui, quel modele, a quelle heure : une cause se lit dans ce portrait.

    Sixieme mecanisme (review ai-01 du 24/11) : un resp-* est horodate a la
    FERMETURE du flux et collect() borne les deux tetes a [cutoff, until). Une
    requete admise avant until dont le flux ferme APRES until tombe donc dans
    `unanswered` par construction — ce n'est pas un refus. Sa taille se mesure,
    sans constante choisie : `unanswered_tail` compte les sans-reponse admis a
    moins de L de la borne haute, L = le plus grand ecart requete->reponse
    observe parmi les paires APPARIEES de la meme lecture ; en mode live
    (until=None) la borne est la resp la plus recente lue. `unanswered_residue`
    est le reste. Les deux valent None quand L n'est pas mesurable (aucune
    paire appariee, aucune resp) : une absence, jamais un zero. Le miroir a la
    borne basse est `files.unpaired` — le meme flux a cheval sur minuit, vu de
    l'autre tete. La classe n'est ni une cause par requete ni un majorant
    strict : un flux plus long que tout lag apparie reste dans le residu, et
    un lag apparie aberrant (une resp tombee sur une requete plus ancienne de
    la meme cle) elargit la classe — L se lit avec le decompte.

    Le 22/11 (lecture archive du 24/11) : 65 120 req-* contre 63 915 resp-*.
    C'est un ecart de FICHIERS ; le nombre de requetes concernees est celui
    d'ici, et il ne s'en deduisait pas.

    -> {"total", "answered", "unanswered", "unanswered_tail",
        "unanswered_residue", "tail_from", "max_paired_lag_s",
        "by_machine", "by_model", "by_hour", "by_bucket"}
       — chaque by_* : {cle : {requests, unanswered}}.
    """
    def tally(key_of):
        t = defaultdict(lambda: {"requests": 0, "unanswered": 0})
        for (pid, reqn), lst in reqs.items():
            for r in lst:
                row = t[key_of(r)]
                row["requests"] += 1
                if (pid, reqn, r["ts"]) not in answered:
                    row["unanswered"] += 1
        return {k: t[k] for k in sorted(t)}

    total = sum(len(lst) for lst in reqs.values())
    unanswered = total - len(answered)
    # La queue de fenetre : ce qu'une fermeture apres la borne expliquerait.
    tail = residue = None
    tail_from = None
    if bound_dt is not None and max_paired_lag_s is not None:
        tail_from = bound_dt - timedelta(seconds=max_paired_lag_s)
        tail = 0
        for (pid, reqn), lst in reqs.items():
            for r in lst:
                if (pid, reqn, r["ts"]) in answered:
                    continue
                r_dt = capture_dt(r.get("ts") or "")
                if r_dt is not None and r_dt >= tail_from:
                    tail += 1
        tail = min(tail, unanswered)
        residue = unanswered - tail
    return {"total": total, "answered": len(answered), "unanswered": unanswered,
            "unanswered_tail": tail, "unanswered_residue": residue,
            "tail_from": tail_from.isoformat() if tail_from else None,
            "max_paired_lag_s": max_paired_lag_s,
            "by_machine": tally(lambda r: r.get("machine") or "direct"),
            "by_model": tally(lambda r: r.get("model") or "(none)"),
            "by_hour": tally(lambda r: (r.get("ts") or "?")[11:13]),
            "by_bucket": tally(bucket_of)}


def collect(dirs, cutoff_dt, until_dt=None, per_day=False):
    """LE scan : l'union des racines (#1180), dedupliquee par NOM de fichier
    (premiere racine gagne). Une seule copie des regles de lecture — la
    fenetre loose et le mode --from-archive passent tous les deux par ici.

    until_dt : borne haute EXCLUSIVE de la fenetre (None = pas de borne) ;
    le mode --from-archive lit un JOUR, [minuit, minuit).

    -> {"files", "lanes", "machines", "hlanes", "per_day", "reqs",
        "first_dt", "last_dt", "coverage"}
    """
    # #1180 + review ai-01 sur #1181 — chaque racine est LISTEE une fois, ici.
    # Une racine que listdir refuse est NON COUVERTE : collect() la nomme sur
    # stderr, l'appelant la declare via root_coverage (ligne COVERAGE + cle
    # `coverage` du JSON), jamais lue comme un corpus vide. Le dedup par nom de
    # fichier est partage par les tetes req et la boucle resp (1re racine gagne).
    listed = []        # (racine, noms) — une entree par racine LUE
    for _d in dirs:
        try:
            listed.append((_d, os.listdir(_d)))
        except OSError as exc:
            print(f"warning: capture dir unreadable ({exc}) -> not covered",
                  file=sys.stderr)
    # (la ligne « nothing was counted (exit 2) » est celle du main() de la
    # fenetre loose, la ou l'exit code se decide — pas ici : collect() sert
    # aussi le mode archive, qui refuse avec ses propres mots.)

    seen = set()
    reqs = defaultdict(list)
    for _d, _names in listed:
        for k, v in load_requests(_d, cutoff_dt, seen=seen, until_dt=until_dt,
                                  names=_names).items():
            reqs[k].extend(v)
    for v in reqs.values():
        v.sort(key=lambda d: d["ts"])

    lanes = defaultdict(lambda: defaultdict(lambda: dict(n=0, inp=0, out=0, cread=0, ccre=0)))
    machines = defaultdict(lambda: defaultdict(lambda: dict(n=0, inp=0, out=0, cread=0, ccre=0)))
    # #1055 — cle = "<lane harnais> | <machine>" : la lane harnais seule ne
    # suffit pas (deux sieges peuvent porter le meme harnais), la machine seule
    # ne distingue pas le harnais du reste du siege.
    hlanes = defaultdict(lambda: defaultdict(lambda: dict(n=0, inp=0, out=0, cread=0, ccre=0)))
    # NE PAS appeler cette variable per_day : le parametre est le boolean, et un
    # defaultdict VIDE est faux : `if per_day:` n'accumulerait jamais.
    by_day = defaultdict(lambda: dict(n=0, inp=0, out=0, cread=0, ccre=0)) if per_day else {}
    n_resp = n_paired = n_unpaired = n_nousage = 0
    first_dt = last_dt = None
    max_paired_lag_s = None   # L de la queue de fenetre (request_accounting)
    answered = set()     # (pid, reqN, estample) des requetes qu'une resp a choisies

    # #1180 — resp de toutes les racines LUES, union dedupliquee par nom de
    # fichier (premiere racine gagne).
    _resp_files = []
    for _d, _names in listed:
        for fn in _names:
            if fn in seen:
                continue
            seen.add(fn)
            if fn.startswith("resp-") and fn.endswith(".sse"):
                _resp_files.append((_d, fn))

    for _d, fn in _resp_files:
        rm = RESP_FN.match(fn)
        if not rm:
            continue
        dt = capture_dt(rm.group(1))
        if dt is None or dt < cutoff_dt:
            continue
        if until_dt is not None and dt >= until_dt:
            continue
        n_resp += 1
        if first_dt is None or dt < first_dt:
            first_dt = dt
        if last_dt is None or dt > last_dt:
            last_dt = dt
        path = os.path.join(_d, fn)
        try:
            txt = read_head_tail(path)
        except OSError:
            continue
        h = HDR.search(txt)
        if not h:
            continue
        model, reqn, pid = h.group(2), int(h.group(3)), int(h.group(4))
        tsm = RESP_TS.search(fn)
        req = pick_request(reqs.get((pid, reqn)) or [], tsm.group(1) if tsm else None)
        if req is None:
            n_unpaired += 1
            info = {"machine": "(unpaired)", "ep": "", "wl": "", "hlane": ""}
            bucket = "other"
        else:
            n_paired += 1
            bucket = bucket_of(req)
            info = req
            answered.add((pid, reqn, req["ts"]))
            # L (review 24/11) : l'ecart requete->reponse des paires APPARIEES
            # de CETTE lecture. La resp est horodatee a la fermeture du flux :
            # son retard mesure la fenetre dans laquelle une requete sans
            # reponse peut etre un flux encore ouvert a la borne, pas un refus.
            req_dt = capture_dt(req.get("ts") or "")
            if req_dt is not None:
                lag_s = (dt - req_dt).total_seconds()
                if lag_s >= 0 and (max_paired_lag_s is None or lag_s > max_paired_lag_s):
                    max_paired_lag_s = lag_s
        u = usage_of(txt)
        if not u:
            n_nousage += 1
            inp = out = cread = ccre = 0
        else:
            inp, out, cread, ccre = u
        lane = lane_for(model)
        keys = [(lanes, lane), (machines, f"{lane} | {info['machine'] or 'direct'}")]
        # #1055 — le rollup harnais n'accumule que les requetes porteuses d'une
        # lane harnais declaree (une absence n'est pas un 0 mesurable).
        if info.get("hlane"):
            keys.append((hlanes, f"{info['hlane']} | {info['machine'] or 'direct'}"))
        if per_day:
            drow = by_day[dt.date().isoformat()]
            drow["n"] += 1
            drow["inp"] += inp
            drow["out"] += out
            drow["cread"] += cread
            drow["ccre"] += ccre
        for table, key in keys:
            r = table[key][bucket]
            r["n"] += 1
            r["inp"] += inp
            r["out"] += out
            r["cread"] += cread
            r["ccre"] += ccre

    # La borne haute de la lecture : `until` du mode jour, sinon la resp la
    # plus recente lue (mode live) — jamais un « maintenant » implicite.
    bound_dt = until_dt if until_dt is not None else last_dt
    return {"files": {"resp": n_resp, "paired": n_paired, "unpaired": n_unpaired,
                      "no_usage": n_nousage},
            "requests": request_accounting(reqs, answered, bound_dt=bound_dt,
                                           max_paired_lag_s=max_paired_lag_s),
            "lanes": lanes, "machines": machines, "hlanes": hlanes,
            "per_day": by_day, "reqs": reqs,
            "first_dt": first_dt, "last_dt": last_dt,
            "coverage": root_coverage(dirs, listed=listed)}


def emit_report(res, *, args, dirs, cdir, cutoff_dt, now_dt, window_hours, fleet,
                rdir, blind, partial, days, coverage,
                day_title="== par jour UTC (--per-day, #1161) ==",
                day_provenance=False, extra=None):
    """Le rapport (JSON ou texte) d'UN scan — rendu une seule fois, partage par
    la fenetre loose et le mode --from-archive (qui ajoute sa cle `series`).
    coverage : l'objet de root_coverage — cle `coverage` du JSON et ligne
    `COVERAGE` du texte, les deux comptent les racines LUES, pas demandees."""
    lanes, machines, hlanes = res["lanes"], res["machines"], res["hlanes"]
    first_dt, last_dt = res["first_dt"], res["last_dt"]
    span_h = ((last_dt - first_dt).total_seconds() / 3600) if (first_dt and last_dt and last_dt > first_dt) else window_hours
    files = res["files"]

    if args.json:
        doc = {
            "window_hours": window_hours,
            "covered_from": first_dt.isoformat() if first_dt else None,
            "covered_to": last_dt.isoformat() if last_dt else None,
            "covered_span_hours": round(span_h, 3),
            # #1180 — ce run a reellement lu `covered` parmi `requested` ;
            # `uncovered` nomme les racines refusees par listdir
            "coverage": coverage,
            "files": files,
            "requests": res.get("requests"),
            "lanes": {k: v for k, v in lanes.items()},
            "machines": {k: v for k, v in machines.items()} if args.machines else None,
            "harness_lanes": {k: v for k, v in hlanes.items()} if args.harness_lanes else None,
            "blind_spot": {k: v for k, v in blind.items()} or None,
            "partial_parts": ({"partial": partial["partial"],
                               "days": partial["days"]}
                              if partial["partial"] else None),
            "days": days,
        }
        if extra:
            doc.update(extra)
        print(json.dumps(doc, indent=2))
        return

    total_out = sum(r["out"] for b in lanes.values() for r in b.values())
    # Fenetre a 0 resp (sidecar NOMINAL : les captures vont au hub) : la
    # couverture se NOMME vide, elle ne crashe pas au format d'une date
    # inexistante — un instrument doit rendre un verdict sur un corpus vide.
    if first_dt and last_dt:
        couv = f"couverture {first_dt:%H:%M} -> {last_dt:%H:%M}Z ({span_h:.2f} h)"
    else:
        couv = "couverture (aucune resp dans la fenetre)"
    print(f"fenetre: {window_hours}h demandees | {couv}")
    print(coverage_line(coverage))
    print(f"resp: {files['resp']} | appariees: {files['paired']} | non appariees: {files['unpaired']} | sans usage: {files['no_usage']}")
    _rq = res.get("requests")
    if _rq:
        _pct = 100.0 * _rq["unanswered"] / _rq["total"] if _rq["total"] else 0.0
        print(f"req: {fmt_int(_rq['total'])} | repondues: {fmt_int(_rq['answered'])} | "
              f"sans reponse: {fmt_int(_rq['unanswered'])} ({_pct:.1f} %)")
        if _rq.get("unanswered_tail") is not None:
            print(f"sans reponse, queue de fenetre: {fmt_int(_rq['unanswered_tail'])} "
                  f"(admises a partir de {_rq['tail_from']}, L = "
                  f"{_rq['max_paired_lag_s']:.0f} s mesure sur les paires lues) | "
                  f"reste: {fmt_int(_rq['unanswered_residue'])}")
        else:
            print("sans reponse, queue de fenetre: non mesurable (aucune paire "
                  "appariee dans la lecture) — une absence, pas un zero")
    pp = _load_partial_parts()
    for _line in pp.section(cdir, cutoff_dt, now_dt, res=partial):
        print(_line)
    print()
    hdr = f"{'lane':24} {'bucket':12} {'req':>6} {'in_tok':>13} {'out_tok':>12} {'cache_rd':>13} {'cache_wr':>12} {'hit%':>5} {'in/h':>13} {'out/h':>12}"
    print(hdr)
    print("-" * len(hdr))
    for lane in sorted(lanes):
        lane_n = lane_out = lane_inp = 0
        for bucket in ("cron", "interactive", "agent-sdk", "other"):
            r = lanes[lane].get(bucket)
            if not r:
                continue
            lane_n += r["n"]
            lane_out += r["out"]
            lane_inp += r["inp"]
            if r["cread"] or r["ccre"]:
                denom = r["cread"] + r["ccre"] + r["inp"]
                hit = f"{100.0 * r['cread'] / denom:4.0f}%" if denom else " n/a"
            else:
                hit = " n/a" if lane in NO_CACHE_LANES else "  0%"
            print(f"{lane:24} {bucket:12} {r['n']:>6} {fmt_int(r['inp']):>13} {fmt_int(r['out']):>12} "
                  f"{fmt_int(r['cread']):>13} {fmt_int(r['ccre']):>12} {hit:>5} "
                  f"{fmt_int(int(r['inp'] / span_h)):>13} {fmt_int(int(r['out'] / span_h)):>12}")
        r_all = {"inp": lane_inp, "out": lane_out}
        print(f"{lane:24} {'TOTAL':12} {lane_n:>6} {fmt_int(r_all['inp']):>13} {fmt_int(r_all['out']):>12} "
              f"{'':>13} {'':>12} {'':>5} {fmt_int(int(r_all['inp'] / span_h)):>13} {fmt_int(int(r_all['out'] / span_h)):>12}")
        print()

    if args.machines:
        print("== par lane x machine ==")
        for key in sorted(machines):
            tot = {k: sum(r[k] for r in machines[key].values()) for k in ("n", "inp", "out")}
            print(f"  {key:46} req {tot['n']:>6}  in {fmt_int(tot['inp']):>13}  out {fmt_int(tot['out']):>12}")

    # #1055 — le rollup harnais se render MEME sans requete porteuse quand le
    # drapeau est passe : la ligne "aucune requete porteuse de lane harnais"
    # nomme l'absence (l'enveloppe ne porte pas encore le champ, ou le harnais
    # n'a pas tourne) au lieu d'un tableau absent qu'on lirait comme un 0.
    if args.harness_lanes:
        print()
        print("== par lane harnais (#1055) ==")
        if not hlanes:
            print("  aucune requete porteuse de lane harnais dans la fenetre")
        for key in sorted(hlanes):
            tot = {k: sum(r[k] for r in hlanes[key].values()) for k in ("n", "inp", "out", "cread", "ccre")}
            print(f"  {key:46} req {tot['n']:>6}  in {fmt_int(tot['inp']):>13}  out {fmt_int(tot['out']):>12}"
                  f"  cache_rd {fmt_int(tot['cread']):>13}")

    # #933 : la section se render meme sans --machines — une absence lue comme
    # un 0 est le mensonge que ce rapport existe pour empecher.
    print()
    bs = _load_blind_spot()
    for line in bs.render(cdir, cutoff_dt, now_dt, fleet,
                          reconcile_dir=rdir, res=blind):
        print(line)

    if days is not None:
        print_days(days, day_title, provenance=day_provenance)

    print(f"\ntotal out_tok fenetre: {fmt_int(total_out)} | debit moyen out: {fmt_int(int(total_out / span_h))}/h")


def print_days(days, title, provenance=False):
    """La serie par jour, en texte — tableau, regle de lecture, et (mode
    --from-archive) une ligne de provenance par jour lu depuis son archive."""
    print("\n" + title)
    if not days:
        print("  aucune mesure ni declaration de jour dans la fenetre — "
              "serie vide, pas une consommation nulle")
        return
    dhdr = (f"{'date':12} {'req':>6} {'in_tok':>13} {'out_tok':>12} "
            f"{'cache_rd':>13} {'cache_wr':>12}  flags")
    print(dhdr)
    print("-" * len(dhdr))
    for d in days:
        flags = list(d.get("partial_reasons") or [])
        if d.get("blind"):
            flags.append("BLIND:" + ",".join(d.get("blind_machines") or []))
        print(f"{d['date']:12} {d['n']:>6} {fmt_int(d['in']):>13} "
              f"{fmt_int(d['out']):>12} {fmt_int(d['cache_read']):>13} "
              f"{fmt_int(d['cache_create']):>12}  "
              f"{','.join(flags) if flags else '-'}")
    print("lecture: un jour `partial` (jour courant, coupe de fenetre, "
          "parties/archive non ouvertes) ou BLIND n'est jamais ratio — "
          "il nomme un non-mesure, pas un zero.")
    if provenance:
        print_provenance(days)


def print_provenance(days):
    """Une ligne par jour lu depuis son archive : de quelle archive, quand,
    combien de membres, combien de loose fusionne, de combien de racines du
    corpus — la trace de la lecture."""
    for d in days:
        a = d.get("archive")
        if d.get("source") != "archive" or not a:
            continue
        files = ", ".join(f"{n} ({fmt_int(s)} o)" for n, s in a.get("files", []))
        cov = d.get("coverage")
        roots = ""
        if cov:
            roots = (f" ; racines du corpus couvertes {len(cov['covered'])}/"
                     f"{len(cov['requested'])}")
        print(f"provenance {d['date']} : {files} ; lue le {a.get('read_at')} ; "
              f"{a.get('members', '?')} membres ; residu loose du jour fusionne : "
              f"{d.get('loose_residual', 0)} fichier(s){roots}")


# ---------------------------------------------------------------------------
# #1161 stage 2 — --from-archive : UN jour, lu UNE fois, dans la serie
# ---------------------------------------------------------------------------

SERIES_SCHEMA = "traffic-days/1"
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ARCHIVE_TITLE = "== serie par jour UTC (--from-archive, #1161) =="


def default_series_path():
    """La serie persistante vit avec les autres etats durables du harnais
    (~/.claudish : cache catalogue, journaux, watermarks) — jamais dans le
    depot, jamais dans le corpus lu."""
    return os.path.join(os.path.expanduser("~"), ".claudish", "traffic-days.json")


def default_extract_root():
    """<depot>/.tmp (gitignore, le disque du depot) ; sinon le dossier
    temporaire du systeme."""
    root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".tmp")
    try:
        os.makedirs(root, exist_ok=True)
        return root
    except OSError:
        return tempfile.gettempdir()


def day_arg(value):
    """Type argparse de --from-archive : UN jour ISO, valide."""
    if not DAY_RE.match(value):
        raise argparse.ArgumentTypeError(f"jour attendu au format YYYY-MM-DD, recu {value!r}")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise argparse.ArgumentTypeError(f"jour invalide : {value!r}")
    return value


def load_series(path):
    """-> (series, erreur|None). Absent -> serie vide. Present mais illisible
    ou d'un autre schema -> erreur : rien n'est alors ecrit par-dessus."""
    if not os.path.exists(path):
        return {"schema": SERIES_SCHEMA, "updated": None, "days": []}, None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as exc:
        return None, f"serie illisible ({path}) : {exc} — rien n'est ecrit"
    ok = (isinstance(doc, dict) and doc.get("schema") == SERIES_SCHEMA
          and isinstance(doc.get("days"), list)
          and all(isinstance(r, dict) and isinstance(r.get("date"), str)
                  for r in doc["days"]))
    if not ok:
        return None, (f"serie d'un autre schema ({path}) : attendu schema={SERIES_SCHEMA} "
                      f"et days=[{{date, ...}}] — rien n'est ecrit par-dessus")
    return doc, None


def write_series(path, series):
    """Remplacement ATOMIQUE : fichier temporaire dans le meme dossier, puis
    os.replace — la serie n'est jamais a moitie ecrite."""
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(series, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def free_space_ok(need, free):
    """Le volume DECLARE tient dans l'espace libre — marge de 5 % + 1 Gio.
    Un disque plein a mi-extraction n'est pas un echec de lecture, c'est un
    disque du poste pris en otage : la garde est AVANT la premiere ecriture."""
    return free >= int(need * 1.05) + (1 << 30)


def day_member_filter(day):
    """keep(basename) des membres du jour — la regle de groupement de
    compress-captures.ps1 ($rx), mot pour mot : le JOUR DU NOM de fichier
    (premiere date suivie de T, avant l'heure). C'est ce filtre qui borne ce
    que read_members extrait."""
    rx = re.compile(r"^(?:req|resp)-.*?(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}")

    def keep(base):
        m = rx.match(base)
        return m is not None and m.group(1) == day
    return keep


def day_archive_paths(dirs, pp, day):
    """Archives du jour = union des racines dedupliquee par NOM (premiere
    racine gagne), la regle de assess_many — une archive copiee sur deux
    disques est UNE archive. Triees par nom : la provenance est stable."""
    out, seen = [], set()
    for d in dirs:
        for p in pp.day_archives_for(d, day):
            name = os.path.basename(p)
            if name in seen:
                continue
            seen.add(name)
            out.append(p)
    return sorted(out, key=os.path.basename)


def declared_members(paths, keep):
    """LISTING seul (en-tete 7z, aucun membre decomprime) : -> (nb de membres
    que `keep` garde, octets declares). Sert la garde d'espace disque et la
    provenance. py7zr manquant -> ImportError ; archive illisible -> l'erreur
    de py7zr. L'extraction, elle, reste lib/partial_parts.read_members."""
    import py7zr

    n = total = 0
    for path in paths:
        with py7zr.SevenZipFile(path) as z:
            for info in z.list():
                if info.is_directory or not keep(os.path.basename(info.filename)):
                    continue
                n += 1
                total += info.uncompressed
    return n, total


def archive_set(paths):
    """[(nom, taille)] des archives du jour — l'etat EXACT qui decide si un
    jour deja lu doit l'etre a nouveau : un fichier de plus, un octet de
    plus (des retardataires rajoutes par la passe nocturne suivante) = une
    autre archive."""
    return [[os.path.basename(p), os.path.getsize(p)] for p in paths]


def from_archive(args, dirs, pp, bs):
    """#1161 stage 2 — `--from-archive <jour>` : lit UN jour depuis son
    archive, UNE seule fois, et l'ajoute a la serie persistante.

    Forme (b) incrementale (decision du coordinateur, File 23d) : le corpus
    loose du hub ne porte que le jour courant ; un jour passe ne se lit que
    depuis son archive (~0,75 Gio de SMB par jour). Donc UN jour par appel,
    jamais plusieurs, et sur le corpus du hub en creux 05-07Z seulement — le
    CLI n'accepte qu'un jour : « plusieurs jours d'un coup » ne s'ecrit pas.

    Contrat :
      - le jour = ses captures telles que le packer les a groupees (archive
        de jour + parties du jour, union des racines) PLUS ce qui du jour
        reste loose dans les racines (un retardataire retenu ouvert a la
        passe nocturne) — sinon la ligne sous-compterait sans le dire ;
      - les regles de lecture sont celles du scan loose (collect) : aucune
        seconde copie des decomptes ;
      - un jour deja present, lu de la meme archive (memes noms ET memes
        tailles), n'est PAS relu : sortie 0, zero octet lu du corpus ;
      - une archive qui a CHANGE depuis la lecture n'est pas relue d'office
        (sortie 2, la ligne est conservee) : --reread l'exige ;
      - aucune archive pour le jour = sortie 2, jamais une ligne a zero ;
      - une racine du corpus ILLISIBLE (#1180) = sortie 2 AVANT toute lecture :
        la ligne persiste, un jour lu d'un demi-corpus n'est pas une mesure,
        et le refus ne coute pas la lecture ; la ligne ecrite porte `coverage`
        (racines demandees / lues / non lues), comme le rapport.

    Sortie 0 : jour lu, ou jour deja present. Sortie 2 : rien lu.
    """
    day = args.from_archive
    cdir = dirs[0]
    jm = args.json

    def say(text):
        """Progression et verdicts : stdout en mode texte, stderr en mode
        --json (stdout reste du JSON pur)."""
        print(text, file=sys.stderr if jm else sys.stdout, flush=True)

    def refuse(text):
        print(f"traffic-consumption: {text}", file=sys.stderr)
        return 2

    why = {}
    cov = root_coverage(dirs, why)
    if cov["uncovered"]:
        return refuse("racine de corpus illisible — un jour lu d'un demi-corpus "
                      "n'est pas une mesure (#1180), rien n'est ecrit : "
                      + " ; ".join(f"{r} ({why[r]})" for r in cov["uncovered"]))

    def show_series():
        if jm:
            print(json.dumps({"series": meta, "days": series["days"]}, indent=2))
        else:
            print_days(series["days"], ARCHIVE_TITLE, provenance=True)

    series_path = args.series_file or default_series_path()
    series, err = load_series(series_path)
    if err:
        return refuse(err)

    paths = day_archive_paths(dirs, pp, day)
    cur = archive_set(paths)
    row0 = next((r for r in series["days"] if r["date"] == day), None)
    status = "read"
    prev = []
    if row0 is not None and row0.get("source") == "archive":
        prev = [list(x) for x in (row0.get("archive") or {}).get("files", [])]
        if prev == cur:
            status = "already-present"
        elif args.reread:
            status = "reread"
        else:
            status = "archive-changed"

    meta = {"path": series_path, "schema": SERIES_SCHEMA, "day": day,
            "status": status, "days_in_series": len(series["days"])}

    if status == "already-present":
        a = row0.get("archive") or {}
        read = ", ".join(f"{n} ({fmt_int(s)} o)" for n, s in a.get("files", []))
        say(f"lecture archive {day} : DEJA PRESENTE dans la serie — pas relue "
            f"(zero octet lu du corpus)")
        say(f"  lue le {a.get('read_at')} de {read}")
        say(f"  serie : {series_path} ({len(series['days'])} jour(s))")
        show_series()
        return 0

    if status == "archive-changed":
        def _names(files):
            return ", ".join(f"{n} ({fmt_int(s)} o)" for n, s in files) or "(absente)"
        say(f"lecture archive {day} : ARCHIVE CHANGEE depuis la lecture — pas relue, "
            f"la ligne de la serie est conservee telle que lue")
        say(f"  lue         : {_names(prev)}")
        say(f"  aujourd'hui : {_names(cur)}")
        resid0 = row0.get("loose_residual", 0)
        if resid0:
            say(f"  la ligne avait fusionne {resid0} fichier(s) loose du jour : l'ajout "
                f"peut n'etre que leur repacking")
        say("  --reread pour relire (un jour, une lecture de plus sur le corpus)")
        meta["read_from"] = prev
        show_series()
        return 2

    if not paths:
        say(f"lecture archive {day} : AUCUNE ARCHIVE — ni archive de jour ni partie "
            f"sous {pp.archive_dir(cdir)} (jour encore loose, ou hors retention) : "
            f"rien a lire, pas une consommation nulle")
        show_series()
        return 2

    d0 = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    d1 = d0 + timedelta(days=1)
    now_dt = datetime.now(timezone.utc)
    if d0 >= now_dt:
        say(f"lecture archive {day} : jour a venir — rien a lire")
        show_series()
        return 2
    until_dt = min(d1, now_dt)
    fleet = [m.strip() for m in args.fleet.split(",") if m.strip()]
    rdir = args.reconcile_dir or bs.default_reconcile_dir()
    keep = day_member_filter(day)

    try:
        n_members, need = declared_members(paths, keep)
    except ImportError:
        return refuse("py7zr est requis pour --from-archive (pip install --user py7zr) — "
                      "il vit dans le site utilisateur : ne pas lancer l'outil sous python -I")
    except Exception as exc:  # noqa: BLE001 — l'archive se NOMME, elle ne relance pas
        return refuse(f"archive du jour illisible ({', '.join(n for n, _ in cur)}) : "
                      f"{type(exc).__name__}: {exc} — rien n'est ecrit dans la serie")
    if not n_members:
        return refuse(f"archive(s) du jour sans aucun membre req-/resp- a son nom "
                      f"({', '.join(n for n, _ in cur)}) — rien a lire, pas une "
                      f"consommation nulle")

    root = args.extract_root or default_extract_root()
    try:
        free = shutil.disk_usage(root).free
    except OSError as exc:
        return refuse(f"racine d'extraction illisible ({root}) : {exc}")
    if not free_space_ok(need, free):
        return refuse(f"espace insuffisant sur {root} : {fmt_int(need)} o declares a "
                      f"extraire, {fmt_int(free)} o libres (marge 5 % + 1 Gio) — rien "
                      f"n'est ecrit ; --extract-root <disque>")

    dest = os.path.join(root, "traffic-days", day)
    if os.path.isdir(dest):
        # un run tue laisse l'extraction derriere lui (le finally n'a pas
        # tourne). Regenerable : l'archive du jour est la, lue plus bas.
        say(f"extraction interrompue retrouvee sous {dest} — remplacee")
        shutil.rmtree(dest, ignore_errors=True)
        if os.path.exists(dest):
            return refuse(f"extraction interrompue sous {dest} impossible a supprimer — "
                          f"rien n'est ecrit ; a liberer a la main")
    try:
        os.makedirs(dest)
    except OSError as exc:
        return refuse(f"racine d'extraction inutilisable ({dest}) : {exc}")

    t0 = time.time()
    resid = 0
    try:
        say(f"lecture archive {day} : {status.upper()} — {len(paths)} archive(s) "
            f"({', '.join(fmt_int(s) + ' o' for _, s in cur)}) ; {n_members} membres "
            f"({fmt_int(need)} o declares) a extraire vers {dest}")
        try:
            pp.read_members(paths, dest, keep=keep)
        except Exception as exc:  # noqa: BLE001 — echec de lecture, pas une ligne
            return refuse(f"extraction echouee ({type(exc).__name__}: {exc}) — rien "
                          f"n'est ecrit dans la serie")
        t1 = time.time()
        say(f"  extrait en {t1 - t0:.0f} s")

        # residu loose du jour (retardataires de la passe nocturne) : copie
        # locale, l'archive gagne sur l'homonyme — le scan reste 100 % local.
        for _d in dirs:
            try:
                names = os.listdir(_d)
            except OSError as exc:
                say(f"  warning: racine illisible ({exc}) — son residu loose du jour "
                    f"n'est pas dans la ligne")
                continue
            for fn in names:
                if not keep(fn) or os.path.exists(os.path.join(dest, fn)):
                    continue
                try:
                    shutil.copy2(os.path.join(_d, fn), os.path.join(dest, fn))
                    resid += 1
                except OSError as exc:
                    say(f"  warning: residu loose {fn} illisible ({exc})")
        say(f"  residu loose du jour fusionne : {resid} fichier(s)")

        # #1195 — prechauffage de la PREMIERE OUVERTURE. collect ouvre chaque
        # fichier une premiere fois, en serie : mesure du 25/11, 62,12 ms par
        # fichier pour 0,7 % de CPU du processus — de l'attente, pas du
        # travail. Ouvrir ces memes fichiers en pool d'abord ne change AUCUN
        # decompte : collect les relit tous, avec ses regles. Un echec du
        # prechauffage ne fait pas echouer la lecture.
        # Review ai-01 25/11 (7161871992) : la PREPARATION (lister, trier) et
        # sa duree vivent DANS la branche armee ET dans la garde. Desactive,
        # rien n'est liste ni chronometre et `seconds.warm` reste exactement
        # 0 — sinon « off » n'est pas une comparaison serie propre. Une
        # preparation qui leve est un warning, jamais un scan perdu.
        t_w0 = time.time()
        warm_seconds = 0.0
        t_scan0 = t_w0
        if args.warm_pool > 1:
            try:
                effective = pp.bound_workers(args.warm_pool)
                warm_files = pp.warm_candidates(dest)
                warmed = pp.warm_first_open(warm_files, effective)
                t_scan0 = time.time()
                say(f"  prechauffe en {t_scan0 - t_w0:.0f} s : {warmed} fichier(s) "
                    f"ouvert(s) une premiere fois par {effective} fils")
            except Exception as exc:  # le scan reste la lecture, pas le prechauffage
                t_scan0 = time.time()
                say(f"  warning: prechauffage abandonne ({type(exc).__name__}: {exc})")
            warm_seconds = t_scan0 - t_w0
        else:
            say(f"  prechauffage desactive (--warm-pool {args.warm_pool})")

        res = collect([dest], d0, until_dt=until_dt, per_day=True)
        t2 = time.time()
        say(f"  scanne en {t2 - t_scan0:.0f} s : {res['files']['resp']} resp, "
            f"{res['files']['paired']} appariees, {res['files']['unpaired']} non appariees")

        rows = build_days(res["per_day"], dirs, d0, now_dt, res["reqs"], fleet, rdir,
                          opened=True, only=True, coverage=cov)
        if not rows:
            return refuse(f"aucune reponse lue pour le {day} ({n_members} membres "
                          f"extraits) — rien n'est ecrit : pas une consommation nulle")
        row = rows[0]
        read_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        row["archive"] = {"files": cur, "read_at": read_at, "members": n_members,
                          "declared_bytes": need,
                          "seconds": {"extract": round(t1 - t0, 1),
                                      "warm": round(warm_seconds, 1),
                                      "scan": round(t2 - t_scan0, 1)}}
        row["loose_residual"] = resid
        # la ligne persiste seule (le rapport non) : elle garde ce qu'elle a
        # ete lue — racines demandees, lues, non lues (#1180, review ai-01)
        row["coverage"] = cov
        series["days"] = sorted([r for r in series["days"] if r["date"] != day] + [row],
                                key=lambda r: r["date"])
        series["updated"] = read_at
        try:
            write_series(series_path, series)
        except OSError as exc:
            return refuse(f"serie non ecrite ({series_path}) : {exc}")
    finally:
        shutil.rmtree(dest, ignore_errors=True)
        if os.path.exists(dest):
            print(f"traffic-consumption: WARNING extraction non supprimee : {dest} "
                  f"({fmt_int(need)} o declares) — a liberer a la main", file=sys.stderr)

    meta["days_in_series"] = len(series["days"])
    meta["loose_residual"] = resid
    say(f"  serie : {series_path} ({len(series['days'])} jour(s)) — {day} "
        f"{'remplace' if row0 is not None else 'ajoute'}")
    _nominal = Counter(v["machine"] for lst in res["reqs"].values() for v in lst)
    blind = bs.assess(cdir, d0, until_dt, fleet, reconcile_dir=rdir,
                      nominal_counts=_nominal)
    # les parties du jour sont LUES ici : une partie mergee n'est plus un
    # sous-compte (merged_paths), le verdict PARTIAL ne la nomme pas.
    partial = pp.assess_many(dirs, d0, until_dt, merged_paths=paths)
    emit_report(res, args=args, dirs=dirs, cdir=cdir, cutoff_dt=d0, now_dt=until_dt,
                window_hours=24.0, fleet=fleet, rdir=rdir, blind=blind,
                partial=partial, days=series["days"], coverage=cov,
                day_title=ARCHIVE_TITLE, day_provenance=True, extra={"series": meta})
    return 0


def main():
    # #1195 (review ai-01 25/11) — charge avant l'analyseur : la borne de
    # --warm-pool se lit sur la constante (aide ET refus), jamais recopiee —
    # une borne recopiee derive.
    pp = _load_partial_parts()
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--hours", type=float, default=24.0)
    ap.add_argument("--dir", action="append", default=None,
                    help="racine du corpus de captures ; REPETABLE (#1180) — "
                         "union dedupliquee par nom de fichier, premiere racine "
                         "gagne. Defaut : $CLAUDISH_CAPTURE_DIR ou "
                         "D:\\claudish-captures")
    ap.add_argument("--json", action="store_true", help="sortie JSON machine-lisible (Phase 3)")
    ap.add_argument("--machines", action="store_true", help="rollup supplementaire par lane x machine")
    ap.add_argument("--harness-lanes", action="store_true",
                    help="rollup supplementaire par lane harnais (#1055 — champ "
                         "enveloppe 'lane', ex. nb-coder ; les requetes sans lane "
                         "harnais sont exclues du rollup, pas de la table principale)")
    ap.add_argument("--fleet", default="",
                    help="machines sidecar attendues (separees par des virgules) — "
                         "active l'avertissement d'angle mort AUTONOMOUS (#933)")
    ap.add_argument("--reconcile-dir", default="",
                    help="dossier des archives outage-*.7z (defaut : GDrive du "
                         "script de reconciliation, env CLAUDISH_RECONCILE_DIR ; "
                         "<corpus>/reconcile reste source additionnelle, #940)")
    ap.add_argument("--per-day", action="store_true",
                    help="serie par jour UTC (#1161 stage 2) : cle `days` du "
                         "JSON, et table par jour en mode texte — le contrat lu "
                         "par activity-cost-join.py (partial/blind compris)")
    ap.add_argument("--from-archive", metavar="YYYY-MM-DD", default=None, type=day_arg,
                    help="(#1161 stage 2) lit UN jour depuis son archive (archive "
                         "de jour + parties du jour, union des racines, plus ce qui "
                         "du jour reste loose) et l'ajoute a la serie persistante ; "
                         "implique --per-day, --hours ignore. Un jour deja present "
                         "n'est PAS relu. UN jour par appel — sur le corpus du hub, "
                         "en creux 05-07Z seulement")
    ap.add_argument("--series-file", default=None, metavar="FILE",
                    help="serie persistante, schema traffic-days/1 (defaut : "
                         + default_series_path() + ") — le fichier que "
                         "activity-cost-join.py --consumption lit")
    ap.add_argument("--extract-root", default=None, metavar="DIR",
                    help="racine LOCALE de l'extraction du jour (defaut : <depot>/.tmp, "
                         "sinon le dossier temporaire) ; supprimee en fin de lecture")
    ap.add_argument("--reread", action="store_true",
                    help="relire un jour deja present dont l'archive a change depuis la "
                         "lecture (sans lui : sortie 2, rien n'est relu)")
    ap.add_argument("--warm-pool", type=int, default=pp.WARM_POOL, metavar="N",
                    help="(#1195) avec --from-archive : fils qui ouvrent une PREMIERE "
                         "fois chaque fichier extrait avant le scan — l'attente de "
                         "premiere ouverture (62 ms par fichier, mesure du 25/11) se "
                         "parallelise ; le scan relit tout avec ses regles et aucun "
                         "decompte ne bouge. 0 ou 1 = desactive, et alors rien n'est "
                         "liste ni chronometre (le chiffre en serie reste atteignable) ; "
                         f"0..{pp.WARM_POOL_MAX} — hors borne : refus, sortie 2")
    args = ap.parse_args()
    # #1195 (review ai-01 25/11) — la borne est APPLIQUEE : un entier hors
    # [0, WARM_POOL_MAX] est refuse ici, avant toute lecture d'archive.
    if not 0 <= args.warm_pool <= pp.WARM_POOL_MAX:
        ap.error(f"--warm-pool {args.warm_pool} : attendu 0..{pp.WARM_POOL_MAX} "
                 f"(0 ou 1 = desactive ; {pp.WARM_POOL_MAX} fils au plus — le "
                 f"prechauffage divise une attente par fichier)")
    # #1180 — `--dir` repetable : la PREMIERE racine reste le corpus de
    # reference (archive/ et reconcile/ gardent leur sens), les suivantes
    # n'ajoutent que leurs captures loose.
    dirs = args.dir or [os.environ.get("CLAUDISH_CAPTURE_DIR",
                                       r"D:\claudish-captures")]
    cdir = dirs[0]
    bs = _load_blind_spot()

    if args.from_archive:
        return from_archive(args, dirs, pp, bs)

    cutoff = datetime.now(timezone.utc).timestamp() - args.hours * 3600
    cutoff_dt = datetime.fromtimestamp(cutoff, tz=timezone.utc)

    res = collect(dirs, cutoff_dt, per_day=args.per_day)
    reqs = res["reqs"]
    # #1180 (review ai-01) — les racines LUES se comptent sur stdout et dans
    # le JSON ; une racine illisible marque chaque jour (build_days). La
    # couverture est celle de la liste qui a servi a lire (#1181, une seule
    # liste par racine) — jamais d'une seconde liste prise apres coup.
    cov = res["coverage"]
    # 2 = aucune racine demandee n'a pu etre lue (voir COVERAGE) : rien n'a
    # ete compte, un rc 0 se lirait comme un corpus sans trafic
    rc = 0 if cov["covered"] else 2
    if rc:
        print("error: no capture dir could be read -> nothing was counted "
              "(exit 2)", file=sys.stderr)

    # #933 — l'angle mort AUTONOMOUS se declare, il ne se lit pas comme un 0 :
    # fleet declaree (+ archives outage, dossier GDrive du script de
    # reconciliation) avec 0 nominal et 0 archive dans la fenetre = BLIND.
    # Coram la fenetre DEMANDEE (cutoff -> maintenant). Les comptes nominaux
    # viennent de load_requests (il a deja lu chaque tete req-* pour
    # l'appariement) — pas de relecture (#940).
    fleet = [m.strip() for m in args.fleet.split(",") if m.strip()]
    now_dt = datetime.now(timezone.utc)
    _rdir = args.reconcile_dir or bs.default_reconcile_dir()
    _nominal = Counter(v["machine"] for lst in reqs.values() for v in lst)
    blind = bs.assess(cdir, cutoff_dt, now_dt, fleet,
                      reconcile_dir=_rdir, nominal_counts=_nominal)

    # #1152 c — un jour packed en parties est absent du corpus loose que ce
    # lecteur scanne : l'undercount se DECLARE (ligne PARTIAL), il ne se lit
    # jamais comme un total. La lecture exacte est le merge de
    # native-consumption --leak-policy.
    # #1180 — union des racines LUES, dedupliquee par nom de partie
    partial = pp.assess_many(cov["covered"], cutoff_dt, now_dt)

    days = (build_days(res["per_day"], dirs, cutoff_dt, now_dt, reqs, fleet, _rdir,
                       coverage=cov)
            if args.per_day else None)

    emit_report(res, args=args, dirs=dirs, cdir=cdir, cutoff_dt=cutoff_dt,
                now_dt=now_dt, window_hours=args.hours, fleet=fleet, rdir=_rdir,
                blind=blind, partial=partial, days=days, coverage=cov)
    return rc


if __name__ == "__main__":
    sys.exit(main())
