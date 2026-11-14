#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pins pour lane-daily-report.py (#1055 g3 / AC4).

Chaque pin défend une lecture qu'une implémentation plausible obtient FAUX :

  1. DURÉE = ts(resp) - ts(req), lus des NOMS de fichier — pas de la même
     source pour les deux (mélanger donnerait 0 systématique).
  2. TOKENS PAR MODÈLE SERVI — le modèle lu de l'en-tête resp (l'id RÉSOLU,
     jamais l'alias demandé dans le corps req).
  3. PROMPT = in + cache_read + cache_creation (le triplet cohérent #600),
     pas le seul input_tokens.
  4. UNE REQ SANS LANE N'EST PAS UNE LANE "" — exclue du rapport des lanes
     (une absence n'est pas un 0 mesurable, même règle que --harness-lanes).
  5. UN RESP SANS REQ APPARIÉ n'est attribué à AUCUNE lane — compté à part.
     L'appariement est (pid, reqN) + ts(resp) >= ts(req), celui de
     traffic-consumption.
  6. REFUS : stop et budget sont deux CAUSES distinctes ; un refus d'une
     AUTRE lane ne pollue pas la lane filtrée ; une ligne non-REFUSE ne
     compte pas.
  7. FILTRE TEMPOREL du journal : une ligne docker -t antérieure à la
     fenêtre est exclue, une ligne sans horodatage docker reste comptée
     (l'appelant a borné par `docker logs --since`).
  8. LANE FILTER : --lane n'exclut QUE les autres lanes, jamais les
     unpaired du décompte global.

Run: python scripts/tests/test_lane_daily_report.py
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ldr = _load("lane_daily_report", os.path.join(_HERE, "..", "lane-daily-report.py"))
tc = _load("traffic_consumption", os.path.join(_HERE, "..", "traffic-consumption.py"))

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def ts(minutes_ago):
    """Nom de fichier de capture : tirets, pas deux-points (capture_dt)."""
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)) \
        .strftime("%Y-%m-%dT%H-%M-%S-000Z")


def req_file(pid, reqn, minutes_ago, lane):
    env = ('"machine":"myia-po-2028","model":"nb-minimax",'
           '"workspace":"claudish",' + (f'"lane":"{lane}",' if lane is not None else "")
           + '"pid":%d,"body":' % pid)
    return ("req-%d-%d-%s.json" % (pid, reqn, ts(minutes_ago)),
            "{" + env + json.dumps(
                {"model": "nb-minimax", "messages": [{"role": "user", "content": "hi"}]}) + "}")


MSG_START = ('{"type":"message_start","message":{"usage":{"input_tokens":100,'
             '"cache_read_input_tokens":0,"cache_creation_input_tokens":0,'
             '"output_tokens":1}}}')
DELTA = ('{"type":"message_delta","usage":{"input_tokens":67,'
         '"cache_read_input_tokens":300,"cache_creation_input_tokens":0,'
         '"output_tokens":123}}')


def resp_file(pid, reqn, minutes_ago, model):
    hdr = "# parser=openai model=%s reqN=%d pid=%d\n" % (model, reqn, pid)
    body = ("data: " + MSG_START + "\n" + "data: " + DELTA + "\n")
    return ("resp-%d-r%04d-%s-openai-%s.sse" % (pid, reqn, ts(minutes_ago), model),
            hdr + body)


tmp = tempfile.mkdtemp(prefix="lane-report-")
try:
    # Lane nb-coder : 2 req sur 2 modèles, durées 10 s et 70 s.
    # req écrite il y a 12 min, resp il y a ~2 min -> ~10 min ; la seconde
    # req il y a ~70 s, resp il y a ~5 s. Les minutes entières du nom de
    # fichier font la durée EXACTE peu fiable -> les pins lisent la cohérence
    # (durée > 0, moyenne entre min et max), pas une valeur absolue.
    files = {}
    for fn, content in (
        req_file(100, 1, 12, "nb-coder"),
        req_file(100, 2, 2, "nb-coder"),
        req_file(100, 3, 30, None),          # pas de lane -> exclue
        req_file(100, 4, 5, "nb-coder"),     # req dont le resp manque
    ):
        files[fn] = content
    files[resp_file(100, 1, 2, "MiniMax-M3.1-Flash")[0]] = resp_file(100, 1, 2, "MiniMax-M3.1-Flash")[1]
    files[resp_file(100, 2, 1, "glm-5.3")[0]] = resp_file(100, 2, 1, "glm-5.3")[1]
    # resp sans req dans la fenêtre (pid différent) -> unpaired
    files[resp_file(200, 1, 1, "MiniMax-M3.1-Flash")[0]] = resp_file(200, 1, 1, "MiniMax-M3.1-Flash")[1]
    for fn, content in files.items():
        with open(os.path.join(tmp, fn), "w", encoding="utf-8") as fh:
            fh.write(content)

    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    rep = ldr.build_report(tmp, cutoff)

    print("build_report — lane unique, 2 modèles, lane-less exclue")
    check("une seule lane", sorted(rep["lanes"]) == ["nb-coder"],
          f"(got {sorted(rep['lanes'])})")
    e = rep["lanes"]["nb-coder"]
    check("2 requetes servies", e["n"] == 2, f"(got {e['n']})")
    check("modele servi = id resolu (pas l'alias)",
          sorted(e["models"]) == ["MiniMax-M3.1-Flash", "glm-5.3"],
          f"(got {sorted(e['models'])})")
    mm = e["models"]["MiniMax-M3.1-Flash"]
    check("prompt = triplet coherent 367 (67+300)", mm["inp"] == 367,
          f"(got {mm['inp']})")
    check("output terminal 123", mm["out"] == 123, f"(got {mm['out']})")
    ds = e["durations_s"]
    check("durees > 0 et toutes deux comptees", len(ds) == 2 and all(d > 0 for d in ds),
          f"(got {ds})")
    check("resp sans req apparie -> unpaired, jamais attribue",
          rep["unpaired"] == 1 and e["n"] == 2, f"(unpaired {rep['unpaired']})")

    print("build_report — filtre --lane")
    rep_f = ldr.build_report(tmp, cutoff, "glm-lane")
    check("lane filtree absente -> vide, unpaired compte quand meme",
          not rep_f["lanes"] and rep_f["unpaired"] == 1,
          f"(lanes {list(rep_f['lanes'])}, unpaired {rep_f['unpaired']})")

    print("parse_refusals — causes, lanes, bruit, fenetre")
    old = (datetime.now(timezone.utc) - timedelta(hours=30)).strftime(TS := "%Y-%m-%dT%H:%M:%S")
    log = "\n".join([
        "2026-11-14T16:35:29.123456789Z [claudish] [LaneBudget] REFUSE lane=nb-coder model=MiniMax-M3.1-Flash consumed=500000 >= 400000 (retry-after 3600s)",
        "2026-11-14T16:36:01.000000000Z [claudish] [LaneBudget] REFUSE lane=nb-coder model=glm-5.3 consumed=100 >= 90 (retry-after 60s)",
        "2026-11-14T16:36:40.000000000Z [claudish] [LaneStop] REFUSE lane=nb-coder (operator stop file present)",
        "2026-11-14T16:37:02.000000000Z [claudish] [LaneBudget] REFUSE lane=autre-lane model=x consumed=1 >= 1 (retry-after 1s)",
        "2026-11-14T16:37:40.000000000Z [claudish] [Request] model=nb-minimax handler=ComposedHandler",
        old + ".000000000Z [claudish] [LaneBudget] REFUSE lane=nb-coder model=vieux consumed=1 >= 1 (retry-after 1s)",
        "[LaneStop] REFUSE lane=sans-horodatage (operator stop file present)",
    ])
    ref = ldr.parse_refusals(log, cutoff)
    check("stop=1 budget=2 pour nb-coder",
          ref["nb-coder"]["stop"] == 1 and ref["nb-coder"]["budget"] == 2,
          f"(got {dict(ref.get('nb-coder', {}))})")
    check("autre lane isolee", ref["autre-lane"]["budget"] == 1,
          f"(got {dict(ref.get('autre-lane', {}))})")
    check("ligne hors fenetre exclue (30 h)", ref["nb-coder"]["budget"] == 2)
    check("ligne sans horodatage docker comptee",
          ref["sans-horodatage"]["stop"] == 1,
          f"(got {dict(ref.get('sans-horodatage', {}))})")
    check("ligne non-REFUSE ignoree", "model=vieux" not in str(ref))
    ref_f = ldr.parse_refusals(log, cutoff, "autre-lane")
    check("filtre lane : une seule lane en sortie",
          list(ref_f) == ["autre-lane"], f"(got {list(ref_f)})")

    print("render — un rapport vide est un rapport")
    out = ldr.render({}, {}, 0, 24.0, None)
    check("message d'absence explicite", "aucune requete" in out, f"(got {out!r})")
    out2 = ldr.render(rep["lanes"], ref, 1, 24.0, None)
    check("lane + cause budget + stop rendus",
          "== lane nb-coder" in out2 and "budget" in out2 and "stop" in out2)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("main — CR N1 : chemin --refusal-log absent = une ligne stderr, pas un silence")
import contextlib
import io
tmp2 = tempfile.mkdtemp(prefix="lane-report-n1-")
try:
    argv_backup, err, out = sys.argv, io.StringIO(), io.StringIO()
    sys.argv = ["lane-daily-report.py", "--dir", tmp2,
                "--refusal-log", os.path.join(tmp2, "absent.log")]
    try:
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            rc = ldr.main()
    finally:
        sys.argv = argv_backup
    check("exit 0 a chemin absent (un rapport vide est un rapport)", rc == 0)
    check("une ligne stderr nomme le chemin (refus non lus != zero refus)",
          "introuvable" in err.getvalue() and "absent.log" in err.getvalue(),
          f"(stderr={err.getvalue()!r})")
    check("le rapport reste rendu", "aucune requete" in out.getvalue(),
          f"(stdout={out.getvalue()[:120]!r})")
finally:
    shutil.rmtree(tmp2, ignore_errors=True)

print()
if FAILS:
    print(f"FAILED: {len(FAILS)} -> {FAILS}")
    sys.exit(1)
print("all pins green")
