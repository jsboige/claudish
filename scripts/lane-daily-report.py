#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Rapport quotidien par lane harnais — claudish #1055 g3 (AC4).

Pour chaque lane harnais (champ d'enveloppe `lane`, g1) sur une fenêtre
glissante : requêtes, tokens par modèle servi, refus par cause, durée
moyenne. C'est le « carnet » que le mandat nb-coder demande — le harnais
lit ses propres consommations, il ne devine pas.

Deux sources, deux vérités complémentaires :

  1. LE CORPUS DE CAPTURES (req-*/resp-*) — requêtes servies. Tout est lu
     par les lecteurs PARTAGÉS de traffic-consumption.py (load_requests,
     usage_of, pick_request) : aucune seconde copie d'un lecteur de capture
     (une copie dérive, mesuré #600). Durée = ts(resp) - ts(req), les deux
     lus du NOM de fichier (seconde près — suffisant pour un carnet).

  2. LE JOURNAL DU CONTENEUR — refus. Un refus de lane (g2 : budget ou stop)
     est admis AVANT logRequest : il n'écrit AUCUNE capture, la ligne stderr
     `[LaneBudget] REFUSE ...` / `[LaneStop] REFUSE ...` est sa seule trace.
     On exporte `docker logs -t <conteneur> > fichier` et on passe
     --refusal-log fichier. Les lignes préfixées d'un horodatage docker
     (`2026-11-14T16-35-29.123Z`) sont filtrées sur la fenêtre ; les lignes
     sans horodatage comptent toutes (l'appelant maîtrise sa fenêtre via
     `docker logs --since`).

Usage (exporter le journal du NOEUD QUI ADMET — CR B2 : l'admission de lane
tourne APRÈS le relais, donc pour un trafic relayé (client -> sidecar -> hub,
NOMINAL) les lignes REFUSE sont dans le journal du HUB ; le sidecar ne les
porte qu'en AUTONOMOUS) :
  docker logs -t claudish-proxy > %TEMP%/refusals.log
  python scripts/lane-daily-report.py --lane nb-coder --refusal-log %TEMP%/refusals.log
  python scripts/lane-daily-report.py --json            # toutes les lanes, 24 h

Exit 0 même à vide (une lane silencieuse est un rapport, pas une erreur).
"""

import argparse
import importlib.util
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone


def _load_traffic_consumption():
    """Le fichier porte un tiret — importable seulement par chemin."""
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "traffic-consumption.py")
    spec = importlib.util.spec_from_file_location("traffic_consumption", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_TC = _load_traffic_consumption()

# g2, packages/cli/src/fork/lane-budget.ts — admettre ces lignes au singulier
# ici, c'est les faire dériver de leur émetteur : le pin vit côté émetteur
# (lane-budget.test.ts) et côté lecteur (test_lane_daily_report.py) mais le
# FORMAT appartient à g2. Toute évolution du wording traverse les deux.
REFUSE_STOP = re.compile(r"\[LaneStop\] REFUSE lane=(\S+)")
REFUSE_BUDGET = re.compile(
    r"\[LaneBudget\] REFUSE lane=(\S+) model=(\S+) consumed=(\d+) >= (\d+)")
# Préfixe `docker logs -t` : 2026-11-14T16:35:29.123456789Z
DOCKER_TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})")
TS_IN = "%Y-%m-%dT%H:%M:%S"


def parse_refusals(text, cutoff_dt=None, lane_filter=None):
    """Lignes REFUSE -> {lane: {cause: n}} (cause = stop | budget).

    cutoff_dt None = pas de filtre temporel (lignes sans horodatage docker
    comprises). Une ligne non préfixée d'un horodatage docker est comptée :
    l'appelant a déjà borné le journal par `docker logs --since`.
    """
    out = defaultdict(lambda: defaultdict(int))
    for line in text.splitlines():
        m = REFUSE_BUDGET.search(line)
        cause, lane = "budget", m.group(1) if m else None
        if not m:
            m = REFUSE_STOP.search(line)
            cause, lane = "stop", m.group(1) if m else None
        if not m:
            continue
        if cutoff_dt is not None:
            tsm = DOCKER_TS.match(line)
            if tsm:
                try:
                    if datetime.strptime(tsm.group(1), TS_IN).replace(
                            tzinfo=timezone.utc) < cutoff_dt:
                        continue
                except ValueError:
                    pass
        if lane_filter and lane != lane_filter:
            continue
        out[lane][cause] += 1
    return out


def build_report(cdir, cutoff_dt, lane_filter=None):
    """Corpus -> {lane: {n, models: {model: {n, inp, out}}, durations_s: [...]},
    unpaired: n}. Un resp sans req apparié n'a pas de lane connue : compté à
    part, jamais attribué par défaut."""
    reqs = _TC.load_requests(cdir, cutoff_dt)
    lanes = defaultdict(lambda: {"n": 0,
                                 "models": defaultdict(lambda: {"n": 0, "inp": 0, "out": 0}),
                                 "durations_s": []})
    unpaired = 0
    for fn in os.listdir(cdir):
        rm = _TC.RESP_FN.match(fn)
        if not rm:
            continue
        dt = _TC.capture_dt(rm.group(1))
        if dt is None or dt < cutoff_dt:
            continue
        try:
            txt = _TC.read_head_tail(os.path.join(cdir, fn))
        except OSError:
            continue
        h = _TC.HDR.search(txt)
        if not h:
            continue
        model, reqn, pid = h.group(2), int(h.group(3)), int(h.group(4))
        tsm = _TC.RESP_TS.search(fn)
        req = _TC.pick_request(reqs.get((pid, reqn)) or [],
                               tsm.group(1) if tsm else None)
        if req is None:
            unpaired += 1
            continue
        lane = req.get("hlane") or ""
        if not lane or (lane_filter and lane != lane_filter):
            continue  # pas une lane harnais, ou pas celle demandée
        entry = lanes[lane]
        entry["n"] += 1
        u = _TC.usage_of(txt)
        m = entry["models"][model]
        m["n"] += 1
        if u:
            m["inp"] += u[0] + u[2] + u[3]  # prompt = in + cache read + cache cr
            m["out"] += u[1]
        req_dt = _TC.capture_dt(req["ts"])
        if req_dt is not None:
            entry["durations_s"].append(max(0.0, (dt - req_dt).total_seconds()))
    return {"lanes": lanes, "unpaired": unpaired}


def render(lanes, refusals, unpaired, hours, lane_filter):
    lines = []
    def fmt(n):
        return f"{n:,}".replace(",", " ")
    if not lanes and not refusals:
        lines.append(
            "aucune requete porteuse de lane harnais dans la fenetre"
            + (f" (filtre: {lane_filter})" if lane_filter else ""))
        lines.append(f"resp sans req appariee : {unpaired}")
        return "\n".join(lines)
    for lane in sorted(set(lanes) | set(refusals)):
        lines.append(f"== lane {lane} ({hours:.0f} h) ==")
        e = lanes.get(lane)
        if e:
            ds = e["durations_s"]
            if ds:
                lines.append(
                    f"  requetes servies : {e['n']} ; duree moyenne "
                    f"{sum(ds) / len(ds):.1f} s (min {min(ds):.1f} / max {max(ds):.1f})")
            else:
                lines.append(f"  requetes servies : {e['n']}")
            lines.append("  tokens par modele servi :")
            for model in sorted(e["models"]):
                m = e["models"][model]
                lines.append(
                    f"    {model:<32} {m['n']:>4} req   in {fmt(m['inp']):>12}"
                    f"   out {fmt(m['out']):>12}")
        else:
            lines.append("  requetes servies : 0")
        r = refusals.get(lane)
        if r:
            lines.append("  refus (journal) :")
            for cause in ("stop", "budget"):
                if r.get(cause):
                    lines.append(f"    {cause:<6} : {r[cause]}")
        lines.append("")
    lines.append(f"resp sans req appariee (hors lanes) : {unpaired}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dir", default=os.environ.get(
        "CLAUDISH_CAPTURE_DIR", r"D:\claudish-captures"))
    ap.add_argument("--hours", type=float, default=24.0)
    ap.add_argument("--lane", default="", help="une seule lane (defaut: toutes)")
    ap.add_argument("--refusal-log", default="",
                    help="export `docker logs -t <conteneur>` (defaut: aucun refus lu)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    cutoff_dt = datetime.now(timezone.utc) - timedelta(hours=args.hours)
    report = build_report(args.dir, cutoff_dt, args.lane or None)
    refusals = {}
    if args.refusal_log:
        # CR N1 — un chemin absent lu en silence lirait « zero refus » : une
        # ligne stderr, le rapport reste exact (refus non lus ≠ zéro refus).
        if not os.path.exists(args.refusal_log):
            print(f"lane-daily-report: --refusal-log introuvable, refus non lus : "
                  f"{args.refusal_log}", file=sys.stderr)
        else:
            with open(args.refusal_log, "r", encoding="utf-8", errors="replace") as fh:
                refusals = parse_refusals(fh.read(), cutoff_dt, args.lane or None)

    if args.json:
        print(json.dumps({
            "window_hours": args.hours,
            "lane_filter": args.lane or None,
            "lanes": {
                lane: {
                    "n": e["n"],
                    "models": {m: dict(v) for m, v in e["models"].items()},
                    "durations_s": e["durations_s"],
                } for lane, e in report["lanes"].items()
            },
            "refusals": {lane: dict(v) for lane, v in refusals.items()},
            "unpaired": report["unpaired"],
        }, ensure_ascii=False, indent=2))
    else:
        print(render(report["lanes"], refusals, report["unpaired"],
                     args.hours, args.lane or None))
    return 0


if __name__ == "__main__":
    sys.exit(main())
