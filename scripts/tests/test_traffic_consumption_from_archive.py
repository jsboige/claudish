#!/usr/bin/env python3
"""Pins for traffic-consumption.py --from-archive (#1161 stage 2, AC c).

File 23d: "`--per-day --from-archive <jour>` lit UNE archive de jour, une
seule fois. Il ajoute ce jour à un fichier de série persistant (`days:[…]`) ;
un jour déjà présent n'est pas relu."

  A1  read — the day's row carries the archived captures' usage, a
      `source: archive` provenance, and NO partial flag (the parts and the
      archive are OPENED here); the extraction dir is gone afterwards
  A2  THE PIN — a day already present is NOT read again: the archive is
      overwritten with garbage of the SAME byte length (any read would
      fail), the call must still exit 0 and the row stay identical
  A3  a changed archive (stragglers appended by a later nightly pass) is
      not re-read on its own — exit 2, row untouched; --reread reads it
  A4  no archive for the day — exit 2, no series file, never a zero row
  A5  a foreign or unreadable series file — exit 2, file byte-identical
  A6  a stale extraction dir (a killed run) is swept before the read
  A7  the loose residual of the day is merged into the row and counted;
      another day's loose capture and another day's archive members are not
  A7b a turn straddling midnight — the response is counted on its own day
      and declared unpaired, never lost, never attributed
  A8  the free-space guard — a pure function, pinned at its boundary
  A9  several roots — the day's archives are the union deduplicated by name
  A10 ratio-able — the series file feeds activity-cost-join (AC c), the day
      gets a ratio and no partial flag
  A11 coverage (#1180, review ai-01) — the report and the persisted row carry
      the same `coverage {requested, covered, uncovered}`; an unreadable root
      refuses BEFORE the archive is opened (a poison archive stays unopened)

Real py7zr archives, real subprocess runs — py7zr lives in the user site on
the seats, so neither this process nor its children run under `-I`.

Run: python scripts/tests/test_traffic_consumption_from_archive.py
"""

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS = os.path.join(_HERE, "..")
_TOOL = os.path.join(_SCRIPTS, "traffic-consumption.py")
_JOIN = os.path.join(_SCRIPTS, "activity-cost-join.py")

FAILS = []

# A fixed PAST day: no pin here depends on the run hour.
DAY = "2026-11-02"
OTHER = "2026-11-03"
NOWHERE = "2999-01-01"

# The seeded message_start + coherent terminal delta of
# test_traffic_consumption_usage.py: usage_of() -> (in=67, out=123, cr=244800,
# cc=100).
SSE = (
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,'
    '"cache_read_input_tokens":0,"cache_creation_input_tokens":0,'
    '"output_tokens":0}}}\n'
    'data: {"type":"message_delta","usage":{"input_tokens":67,'
    '"cache_read_input_tokens":244800,"cache_creation_input_tokens":100,'
    '"output_tokens":123}}\n'
)


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_SCRIPTS, relpath))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def pair_names(pid, reqn, day, hhmm, lag=7):
    """Noms de la FORME REELLE (request-logger.ts, response-capture.ts) : la
    requete est nommee a l'admission (millisecondes, suffixe = source), la
    reponse a la FERMETURE du flux — plus tard, suffixe = parser + modele.
    Deux estamples EGALES ne s'apparient pas (la regle est « requete <=
    reponse » sur des chaines de suffixes differents) : une fixture qui
    donnerait le meme estample aux deux fichiers fabriquerait des non-appariees."""
    rq = f"req-{pid}-{reqn:04d}-{day}T{hhmm[:2]}-{hhmm[2:]}-00-123Z-direct.json"
    rs = (f"resp-{pid}-r{reqn:04d}-{day}T{hhmm[:2]}-{hhmm[2:]}-{lag:02d}-456Z"
          f"-openai-sse-glm-5.3.sse")
    return rq, rs


def write_pair(folder, pid, reqn, day, hhmm, machine="myia-po-2023"):
    rq, rs = pair_names(pid, reqn, day, hhmm)
    with open(os.path.join(folder, rq), "w") as fh:
        fh.write('{"machine":"%s","entrypoint":"cli","workload":"cron","lane":"",'
                 '"body":{"messages":[]}}' % machine)
    with open(os.path.join(folder, rs), "w") as fh:
        fh.write(f"# parser=openai-sse model=glm-5.3 reqN={reqn} pid={pid}\n" + SSE)


def write_half(folder, pid, reqn, day, hhmm, which):
    """La moitie d'une paire (`which` = "req" | "resp") — un tour a cheval sur
    minuit se lit depuis deux archives. -> le dossier."""
    rq, rs = pair_names(pid, reqn, day, hhmm)
    os.makedirs(folder, exist_ok=True)
    if which == "req":
        with open(os.path.join(folder, rq), "w") as fh:
            fh.write('{"machine":"myia-po-2023","entrypoint":"cli","workload":"cron","lane":"",'
                     '"body":{"messages":[]}}')
    else:
        with open(os.path.join(folder, rs), "w") as fh:
            fh.write(f"# parser=openai-sse model=glm-5.3 reqN={reqn} pid={pid}\n" + SSE)
    return folder


def pack(archive, folder, extra_members=()):
    """Real 7z archive: every file of `folder` as a flat member, plus the
    named extra members."""
    import py7zr

    os.makedirs(os.path.dirname(archive), exist_ok=True)
    with py7zr.SevenZipFile(archive, "w") as z:
        for fn in sorted(os.listdir(folder)):
            z.write(os.path.join(folder, fn), arcname=fn)
        for name, body in extra_members:
            z.writestr(body, arcname=name)


_SRC_N = [0]


def build(tmp, n=3, extra_members=(), name="corpus"):
    """A corpus whose DAY lives in its day archive (n pairs), plus decoys.
    `name` : le sous-dossier du corpus — le meme nom reconstruit l'archive
    EN PLACE (un changement d'archive), un autre nom isole un corpus."""
    root = os.path.join(tmp, name)
    _SRC_N[0] += 1
    src = os.path.join(tmp, "src%d" % _SRC_N[0])
    os.makedirs(src)
    for i in range(n):
        write_pair(src, 100 + i, 1, DAY, "100%d" % i)
    decoys = [("README.txt", b"not a capture\n"),
              (pair_names(500, 1, OTHER, "0900")[1], b"x" * 10)]
    pack(os.path.join(root, "archive", f"captures-{DAY}.7z"), src,
         extra_members=list(decoys) + list(extra_members))
    return root


def run(root, series, work, *extra, roots=None):
    roots = roots or [root]
    args = [sys.executable, _TOOL, "--reconcile-dir", os.path.join(work, "no-reconcile"),
            "--series-file", series, "--extract-root", work]
    for r in roots:
        args += ["--dir", r]
    return subprocess.run(args + list(extra), capture_output=True, text=True)


def read_day(root, series, work, *extra, roots=None):
    return run(root, series, work, "--from-archive", DAY, "--json", *extra, roots=roots)


def row_of(series_path, day=DAY):
    if not os.path.exists(series_path):
        return None, None
    with open(series_path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    return next((r for r in doc["days"] if r["date"] == day), None), doc


def main():
    try:
        import py7zr  # noqa: F401
    except ImportError:
        print("SKIP — py7zr absent on this seat")
        return 0

    tmp = tempfile.mkdtemp(prefix="fromarch-")
    try:
        print("A1 — lecture : la ligne du jour vient de l'archive, prouvée")
        work = os.path.join(tmp, "w1")
        os.makedirs(work)
        root = build(tmp)
        arch = os.path.join(root, "archive", f"captures-{DAY}.7z")
        series = os.path.join(work, "traffic-days.json")
        out = read_day(root, series, work)
        check("rc=0", out.returncode == 0, out.stderr[-600:] + out.stdout[-300:])
        doc = json.loads(out.stdout)
        check("stdout = JSON pur (la progression est sur stderr)",
              doc.get("series", {}).get("status") == "read", sorted(doc))
        row, stored = row_of(series)
        check("serie ecrite (schema traffic-days/1)", stored.get("schema") == "traffic-days/1", stored.keys())
        check("un seul jour dans la serie", [r["date"] for r in stored["days"]] == [DAY],
              [r["date"] for r in stored["days"]])
        check("ligne de la serie = ligne du rapport", row == doc["days"][-1], (row, doc["days"]))
        check("source = archive", row.get("source") == "archive", row)
        check("valeurs des captures archivees (3 resp)", (row["n"], row["in"], row["out"]) == (3, 201, 369), row)
        check("cache du triplet", (row["cache_create"], row["cache_read"]) == (300, 734400), row)
        check("NON partial : l'archive est OUVERTE ici", "partial" not in row, row)
        check("provenance : l'archive du jour, sa taille, 6 membres, date de lecture",
              [n for n, _ in row["archive"]["files"]] == [f"captures-{DAY}.7z"]
              and row["archive"]["files"][0][1] == os.path.getsize(arch)
              and row["archive"]["members"] == 6 and len(row["archive"]["read_at"]) == 20,
              row.get("archive"))
        check("les leurres ne sont pas extraits (membre sans nom de capture, jour voisin)",
              row["archive"]["members"] == 6, row["archive"]["members"])
        check("rapport : fenetre = le jour", doc["window_hours"] == 24.0
              and doc["covered_from"].startswith(DAY + "T10:00") , doc["covered_from"])
        check("repertoire d'extraction supprime",
              not os.path.exists(os.path.join(work, "traffic-days", DAY)),
              os.listdir(os.path.join(work, "traffic-days")) if os.path.isdir(os.path.join(work, "traffic-days")) else "-")

        print("A1b — mode texte de la lecture, et l'angle mort au grain du jour")
        workb = os.path.join(tmp, "w1b")
        os.makedirs(workb)
        seriesb = os.path.join(workb, "traffic-days.json")
        txt = run(root, seriesb, workb, "--from-archive", DAY, "--fleet", "myia-po-2099")
        check("rc=0", txt.returncode == 0, txt.stderr[-400:])
        for needle in (f"lecture archive {DAY} : READ", "extrait en",
                       "residu loose du jour fusionne : 0 fichier(s)", "scanne en",
                       "== serie par jour UTC (--from-archive, #1161) ==",
                       "provenance " + DAY, "total out_tok fenetre"):
            check(f"texte : {needle!r} present", needle in txt.stdout, txt.stdout[-700:])
        rowb, _ = row_of(seriesb)
        check("--per-day est implique (pas de drapeau passe) : la serie est ecrite",
              rowb is not None and rowb.get("source") == "archive", rowb)
        check("fleet muette -> jour BLIND (regle de lib/blind_spot.py au grain du jour)",
              (rowb or {}).get("blind") is True and (rowb or {}).get("blind_machines") == ["myia-po-2099"],
              rowb)
        check("texte : BLIND nomme dans la table", "BLIND:myia-po-2099" in txt.stdout,
              txt.stdout[-500:])

        print("A2 — L'EPINGLE : un jour deja present n'est pas relu")
        size = os.path.getsize(arch)
        with open(arch, "r+b") as fh:
            fh.seek(32)
            fh.write(b"\x00" * (size - 32))          # meme LONGUEUR, plus une archive
        assert os.path.getsize(arch) == size
        before = open(series, "rb").read()
        out = read_day(root, series, work)
        check("rc=0 alors que l'archive est un poison de meme taille (donc : pas relue)",
              out.returncode == 0, out.stderr[-400:])
        doc = json.loads(out.stdout)
        check("statut already-present", doc["series"]["status"] == "already-present", doc["series"])
        check("fichier de serie byte-identique", open(series, "rb").read() == before)
        check("message : pas relue, zero octet lu du corpus",
              "DEJA PRESENTE" in out.stderr and "pas relue" in out.stderr, out.stderr[-300:])
        txt = run(root, series, work, "--from-archive", DAY)
        check("mode texte, rc=0 et table de la serie rendue",
              txt.returncode == 0 and "== serie par jour UTC (--from-archive, #1161) ==" in txt.stdout
              and DAY in txt.stdout, txt.stdout[-300:])
        check("mode texte : provenance rendue", "provenance " + DAY in txt.stdout, txt.stdout[-300:])

        print("A3 — archive changee : pas de relecture d'office ; --reread l'exige")
        root = build(tmp, n=4)                       # un retardataire de plus
        assert os.path.getsize(arch) != size
        out = read_day(root, series, work)
        check("rc=2 sans --reread", out.returncode == 2, out.returncode)
        check("statut archive-changed, les deux etats nommes",
              "ARCHIVE CHANGEE" in out.stderr and "lue" in out.stderr and "aujourd'hui" in out.stderr,
              out.stderr[-500:])
        check("ligne de la serie intacte", row_of(series)[0] == json.loads(before)["days"][0])
        out = read_day(root, series, work, "--reread")
        check("--reread : rc=0, statut reread", out.returncode == 0
              and json.loads(out.stdout)["series"]["status"] == "reread", out.stderr[-400:])
        row, stored = row_of(series)
        check("--reread : la ligne porte le retardataire (4 resp), toujours UNE ligne",
              row["n"] == 4 and len(stored["days"]) == 1, (row["n"], len(stored["days"])))
        out = read_day(root, series, work)
        check("puis deja present de nouveau", out.returncode == 0
              and json.loads(out.stdout)["series"]["status"] == "already-present", out.returncode)

        print("A4 — aucune archive pour le jour : sortie 2, pas de fichier de serie, jamais un zero")
        work4 = os.path.join(tmp, "w4")
        os.makedirs(work4)
        series4 = os.path.join(work4, "traffic-days.json")
        out = run(root, series4, work4, "--from-archive", NOWHERE, "--json")
        check("rc=2", out.returncode == 2, out.returncode)
        check("AUCUNE ARCHIVE nommee, 'pas une consommation nulle'",
              "AUCUNE ARCHIVE" in out.stderr and "pas une consommation nulle" in out.stderr,
              out.stderr[-300:])
        check("aucun fichier de serie cree", not os.path.exists(series4), series4)
        check("aucune extraction", not os.path.exists(os.path.join(work4, "traffic-days")))
        bad = run(root, series4, work4, "--from-archive", "2026-13-45", "--json")
        check("jour invalide refuse par argparse", bad.returncode == 2 and "YYYY-MM-DD" in bad.stderr,
              bad.stderr[-200:])
        bad = run(root, series4, work4, "--from-archive", "20261102", "--json")
        check("jour sans tirets refuse", bad.returncode == 2 and "YYYY-MM-DD" in bad.stderr,
              bad.stderr[-200:])
        check("UN jour par appel : le drapeau est a valeur unique (jamais une liste)",
              "--from-archive" in open(_TOOL, encoding="utf-8").read()
              and 'metavar="YYYY-MM-DD", default=None, type=day_arg' in open(_TOOL, encoding="utf-8").read()
              and 'add_argument("--from-archive", action="append"' not in open(_TOOL, encoding="utf-8").read())

        print("A5 — serie illisible ou d'un autre schema : sortie 2, fichier intact")
        work5 = os.path.join(tmp, "w5")
        os.makedirs(work5)
        for label, body in (("garbage", b"{not json"),
                            ("autre schema", json.dumps({"schema": "other/9", "days": []}).encode()),
                            ("jours sans date", json.dumps({"schema": "traffic-days/1",
                                                            "days": [{"n": 1}]}).encode())):
            series5 = os.path.join(work5, "traffic-days.json")
            with open(series5, "wb") as fh:
                fh.write(body)
            out = read_day(root, series5, work5)
            check(f"{label} : rc=2", out.returncode == 2, out.returncode)
            check(f"{label} : fichier byte-identique, message 'rien n'est ecrit'",
                  open(series5, "rb").read() == body and "rien n'est ecrit" in out.stderr,
                  out.stderr[-300:])
            check(f"{label} : aucune ligne ajoutee (stdout vide)", out.stdout == "", out.stdout[:200])
        check("pas de fichier temporaire laisse", not os.path.exists(
            os.path.join(work5, "traffic-days.json.tmp")), os.listdir(work5))

        print("A6 — extraction interrompue retrouvee : balayee avant la lecture")
        work6 = os.path.join(tmp, "w6")
        stale = os.path.join(work6, "traffic-days", DAY)
        os.makedirs(stale)
        # un fantome qui COMPTERAIT s'il survivait au balayage : nom et tete valides
        ghost_rq, ghost_rs = pair_names(999, 1, DAY, "1500")
        with open(os.path.join(stale, ghost_rs), "w") as fh:
            fh.write("# parser=openai-sse model=glm-5.3 reqN=1 pid=999\n" + SSE)
        series6 = os.path.join(work6, "traffic-days.json")
        out = read_day(root, series6, work6)
        check("rc=0", out.returncode == 0, out.stderr[-400:])
        check("nommee sur stderr", "extraction interrompue retrouvee" in out.stderr, out.stderr[-300:])
        check("le fantome n'est pas dans la ligne (4 resp, pas 5)",
              row_of(series6)[0]["n"] == 4, row_of(series6)[0])
        check("dossier d'extraction supprime", not os.path.exists(stale))

        print("A7 — residu loose du jour fusionne ; un autre jour ne compte pas")
        work7 = os.path.join(tmp, "w7")
        os.makedirs(work7)
        root7 = build(tmp, n=2, name="corpus7")
        write_pair(root7, 700, 1, DAY, "2359")              # retardataire du jour
        write_pair(root7, 701, 1, OTHER, "0001")            # le jour voisin, loose
        series7 = os.path.join(work7, "traffic-days.json")
        out = read_day(root7, series7, work7)
        check("rc=0", out.returncode == 0, out.stderr[-400:])
        row, _ = row_of(series7)
        check("2 archivees + 1 residu = 3 resp", row["n"] == 3, row)
        check("residu loose declare : 2 fichiers (req + resp)",
              row["loose_residual"] == 2 and "residu loose du jour fusionne : 2 fichier(s)" in out.stderr,
              (row.get("loose_residual"), out.stderr[-300:]))
        check("le jour voisin n'entre ni dans la ligne ni dans la serie",
              len(row_of(series7)[1]["days"]) == 1, row_of(series7)[1]["days"])
        series7b = os.path.join(work7, "traffic-days-b.json")
        out = read_day(root7, series7b, work7, "--hours", "0.5")
        rowb, _ = row_of(series7b)
        check("--hours ignore : meme jour complet (le jour, pas une fenetre de 0,5 h)",
              out.returncode == 0 and (rowb["n"], rowb["in"], rowb["out"]) == (row["n"], row["in"], row["out"]),
              (out.returncode, rowb))

        print("A7b — un tour a cheval sur minuit : la reponse est comptee, non appariee, jamais perdue")
        # La requete part la veille (archive de la veille), la reponse arrive
        # le jour (archive du jour) : le packer range chaque fichier sous la
        # date de SON nom. Lue depuis l'archive du jour, la reponse est comptee
        # (le triplet d'usage vit dans la reponse) et non appariee (pas de
        # machine -> other).
        work7c = os.path.join(tmp, "w7c")
        os.makedirs(work7c)
        eve = "2026-11-01"
        root7c = os.path.join(tmp, "corpus7c")
        day_src = write_half(os.path.join(tmp, "mid-day-720"), 720, 1, DAY, "1000", "req")
        write_half(day_src, 720, 1, DAY, "1000", "resp")
        write_half(day_src, 710, 1, DAY, "0001", "resp")
        pack(os.path.join(root7c, "archive", f"captures-{DAY}.7z"), day_src)
        pack(os.path.join(root7c, "archive", f"captures-{eve}.7z"),
             write_half(os.path.join(tmp, "mid-eve-710"), 710, 1, eve, "2359", "req"))
        series7c = os.path.join(work7c, "traffic-days.json")
        out = read_day(root7c, series7c, work7c)
        doc = json.loads(out.stdout) if out.returncode == 0 else {}
        check("rc=0", out.returncode == 0, out.stderr[-400:])
        check("la reponse de 00:00:01 est comptee (n=2) et declaree non appariee (1)",
              doc.get("days", [{}])[-1].get("n") == 2 and doc.get("files", {}).get("unpaired") == 1
              and doc.get("files", {}).get("paired") == 1, (doc.get("days"), doc.get("files")))
        check("seul le jour demande entre dans la serie (la veille n'est pas lue)",
              [r["date"] for r in doc.get("days", [])] == [DAY], [r["date"] for r in doc.get("days", [])])

        print("A8 — garde d'espace disque (fonction pure)")
        tc = _load("traffic_consumption", "traffic-consumption.py")
        need = 33_000_000_000
        edge = int(need * 1.05) + (1 << 30)
        check("un octet sous la marge = refuse", tc.free_space_ok(need, edge - 1) is False)
        check("a la marge = accepte", tc.free_space_ok(need, edge) is True)
        check("marge = 5 % + 1 Gio (a l'octet d'arrondi pres)",
              abs(edge - need - (1_650_000_000 + (1 << 30))) <= 1, edge - need)
        check("besoin nul = 1 Gio minimum", tc.free_space_ok(0, (1 << 30) - 1) is False
              and tc.free_space_ok(0, 1 << 30) is True)
        keep = tc.day_member_filter(DAY)
        check("filtre = la regle de groupement du packer (jour du NOM)",
              keep(f"req-1-0001-{DAY}T10-00-00-123Z-direct.json")
              and keep(f"resp-1-r0001-{DAY}T23-59-59-456Z-openai-sse-glm-5.3.sse")
              and not keep(f"resp-1-r0001-{OTHER}T00-00-01-456Z-openai-sse-glm-5.3.sse")
              and not keep("README.txt") and not keep("archive/resp-1-r1-x.sse"))

        print("A9 — plusieurs racines : union des archives du jour, dedupliquee par nom")
        work9 = os.path.join(tmp, "w9")
        os.makedirs(work9)
        root9 = build(tmp, n=2, name="corpus9")
        root9b = os.path.join(tmp, "corpus-b")
        shutil.copytree(os.path.join(root9, "archive"), os.path.join(root9b, "archive"))
        part = os.path.join(tmp, "part")
        os.makedirs(part)
        write_pair(part, 800, 1, DAY, "1200")
        pack(os.path.join(root9b, "archive", f"captures-{DAY}-p0900.7z"), part)
        series9 = os.path.join(work9, "traffic-days.json")
        out = read_day(root9, series9, work9, roots=[root9, root9b])
        check("rc=0", out.returncode == 0, out.stderr[-400:])
        row, _ = row_of(series9)
        names = [n for n, _ in row["archive"]["files"]]
        check("archive de jour (une fois) + partie de la 2e racine",
              names == [f"captures-{DAY}-p0900.7z", f"captures-{DAY}.7z"], names)
        check("les membres des deux archives comptent (2 + 1 resp)",
              row["n"] == 3 and row["archive"]["members"] == 6, (row["n"], row["archive"]))
        check("pas de verdict PARTIEL : la partie du jour est LUE",
              json.loads(out.stdout)["partial_parts"] is None, out.stdout[-400:])

        print("A10 — ratio-able : la serie alimente activity-cost-join (AC c)")
        act = os.path.join(tmp, "activity.json")
        with open(act, "w") as fh:
            json.dump({"login": "jsboige", "from": DAY, "to": OTHER, "source": "fragment",
                       "span_days": 2, "coverage": {"covered": 2, "span_days": 2, "absent": []},
                       "days": [{"date": DAY, "count": 12}, {"date": OTHER, "count": 5}]}, fh)
        joined = subprocess.run([sys.executable, _JOIN, "--activity", act,
                                 "--consumption", series9, "--json"],
                                capture_output=True, text=True)
        check("rc=0", joined.returncode == 0, joined.stderr[-400:])
        rows = {r["date"]: r for r in json.loads(joined.stdout)["rows"]}
        check("le jour lu a un ratio, sans partial",
              rows[DAY]["ratio"] == round(12 / ((1.25 * 300 + 0.1 * 3 * 244800 + 5 * 369) / 1000.0), 4)
              and "partial" not in rows[DAY]["flags"], rows.get(DAY))
        check("le jour sans consommation est nomme activity-only, pas un zero",
              "activity-only" in rows[OTHER]["flags"] and rows[OTHER]["ratio"] is None,
              rows.get(OTHER))

        print("A11 — couverture (#1180, review ai-01) : la ligne persiste ce qu'elle a "
              "lu ; une racine illisible refuse AVANT de payer")
        work11 = os.path.join(tmp, "w11")
        os.makedirs(work11)
        series11 = os.path.join(work11, "traffic-days.json")
        out = read_day(root9, series11, work11)
        check("rc=0", out.returncode == 0, out.stderr[-400:])
        doc = json.loads(out.stdout)
        one = {"requested": [root9], "covered": [root9], "uncovered": []}
        check("cle `coverage` du rapport = {requested, covered, uncovered}",
              doc.get("coverage") == one, doc.get("coverage"))
        row11, _ = row_of(series11)
        check("la ligne de la serie porte le MEME objet (elle persiste seule)",
              row11.get("coverage") == one, row11.get("coverage"))
        series11b = os.path.join(work11, "traffic-days-b.json")
        txt = run(root9, series11b, work11, "--from-archive", DAY, roots=[root9, root9b])
        check("deux racines lues : rc=0", txt.returncode == 0, txt.stderr[-400:])
        check("stdout : COVERAGE dirs=2/2, sans `uncovered=`",
              "COVERAGE dirs=2/2" in txt.stdout and "uncovered=" not in txt.stdout,
              txt.stdout[:300])
        check("provenance : racines du corpus couvertes 2/2",
              "racines du corpus couvertes 2/2" in txt.stdout, txt.stdout[-700:])
        two = {"requested": [root9, root9b], "covered": [root9, root9b], "uncovered": []}
        check("la ligne porte ses deux racines",
              row_of(series11b)[0].get("coverage") == two, row_of(series11b)[0].get("coverage"))
        ghost = os.path.join(tmp, "ghost-root")            # absente : illisible
        # 2e racine illisible, archive VALABLE sous la 1re : sans le refus, le
        # jour serait lu et INSCRIT — une ligne d'un demi-corpus, sans trace.
        series11c = os.path.join(work11, "traffic-days-c.json")
        out = read_day(root9, series11c, work11, roots=[root9, ghost])
        check("2e racine illisible : rc=2", out.returncode == 2, (out.returncode, out.stderr[-300:]))
        check("2e racine : refus qui nomme la racine, 'rien n'est ecrit', aucune serie, stdout vide",
              ghost in out.stderr and "racine de corpus illisible" in out.stderr
              and "rien n'est ecrit" in out.stderr and not os.path.exists(series11c)
              and out.stdout == "", (out.stderr[-400:], os.path.exists(series11c), out.stdout[:100]))
        # 1re racine illisible, archive POISON de meme longueur sous la 2e (A2) :
        # toute ouverture echouerait sur « archive du jour illisible » — le
        # refus doit nommer la RACINE, preuve que l'archive n'a pas ete ouverte.
        root11 = build(tmp, n=2, name="corpus11")
        arch11 = os.path.join(root11, "archive", f"captures-{DAY}.7z")
        size11 = os.path.getsize(arch11)
        with open(arch11, "r+b") as fh:
            fh.seek(32)
            fh.write(b"\x00" * (size11 - 32))
        assert os.path.getsize(arch11) == size11
        series11d = os.path.join(work11, "traffic-days-d.json")
        out = read_day(ghost, series11d, work11, roots=[ghost, root11])
        check("1re racine illisible : rc=2", out.returncode == 2, (out.returncode, out.stderr[-300:]))
        check("1re racine : l'archive POISON n'a pas ete ouverte (le refus nomme la racine)",
              ghost in out.stderr and "racine de corpus illisible" in out.stderr
              and "archive du jour illisible" not in out.stderr
              and "extrait en" not in out.stderr, out.stderr[-500:])
        check("1re racine : aucune serie ecrite", not os.path.exists(series11d), series11d)
        left = os.path.join(work11, "traffic-days")
        check("aucune extraction laissee", not os.path.exists(left) or os.listdir(left) == [],
              os.listdir(left) if os.path.exists(left) else "-")

        # A12 — requetes sans reponse : un ecart de FICHIERS n'est pas un nombre
        # de requetes. Deux req-* seuls s'ajoutent aux 3 paires du corpus.
        print("A12 — requetes sans reponse : comptees, situees, jamais causees")
        lone1, lone2 = pair_names(700, 1, DAY, "1030")[0], pair_names(701, 1, DAY, "1031")[0]
        body1 = ('{"machine":"myia-po-2027","model":"kimi-k2.5","entrypoint":"cli",'
                 '"workload":"interactive","lane":"","body":{"model":"glm-5.3"}}')
        body2 = '{"src":"direct","body":{"model":"deepseek-r1","messages":[]}}'
        root12 = build(tmp, n=3, extra_members=[(lone1, body1.encode()), (lone2, body2.encode())],
                       name="corpus12")
        work12 = os.path.join(tmp, "w12")
        os.makedirs(work12)
        out = read_day(root12, os.path.join(work12, "traffic-days.json"), work12)
        check("A12 rc=0", out.returncode == 0, out.stderr[-500:])
        rq = json.loads(out.stdout).get("requests")
        check("5 requetes, 3 repondues, 2 sans reponse",
              rq and (rq["total"], rq["answered"], rq["unanswered"]) == (5, 3, 2), rq)
        check("par machine : la sans-reponse est situee",
              rq and rq["by_machine"] == {"direct": {"requests": 1, "unanswered": 1},
                                          "myia-po-2023": {"requests": 3, "unanswered": 0},
                                          "myia-po-2027": {"requests": 1, "unanswered": 1}},
              rq and rq["by_machine"])
        check("par modele DEMANDE : l'enveloppe gagne, pas le corps",
              rq and rq["by_model"] == {"(none)": {"requests": 3, "unanswered": 0},
                                        "deepseek-r1": {"requests": 1, "unanswered": 1},
                                        "kimi-k2.5": {"requests": 1, "unanswered": 1}},
              rq and rq["by_model"])
        check("par heure UTC et par bucket",
              rq and rq["by_hour"] == {"10": {"requests": 5, "unanswered": 2}}
              and rq["by_bucket"] == {"cron": {"requests": 3, "unanswered": 0},
                                      "interactive": {"requests": 1, "unanswered": 1},
                                      "other": {"requests": 1, "unanswered": 1}},
              rq and (rq["by_hour"], rq["by_bucket"]))
        check("la cause n'est pas inventee : aucune cle de cause",
              rq and not [k for k in rq if "cause" in k or "reason" in k], rq and sorted(rq))
        out = run(root12, os.path.join(work12, "traffic-days-b.json"), work12, "--from-archive", DAY)
        check("rapport texte : la ligne req | repondues | sans reponse",
              out.returncode == 0
              and "req: 5 | repondues: 3 | sans reponse: 2 (40.0 %)" in out.stdout,
              (out.returncode, out.stdout[-500:]))

        # A12b (review ai-01 du 24/11, finding 1) — le SIXIEME mecanisme : un
        # resp-* est horodate a la FERMETURE du flux, et collect() borne les
        # deux tetes. Une requete admise avant la borne dont le flux ferme
        # apres elle est « sans reponse » PAR CONSTRUCTION. Elle se rapporte a
        # part (la queue de fenetre), et L se mesure sur les paires appariees
        # de la meme lecture — aucune constante choisie.
        print("A12b — flux ferme apres la borne : queue de fenetre, pas residu")
        tc = _load("tc", "traffic-consumption.py")
        tail_dir = os.path.join(tmp, "tail")
        os.makedirs(tail_dir)

        def put(folder, fn, text):
            with open(os.path.join(folder, fn), "w") as fh:
                fh.write(text)

        def req_text(machine="myia-po-2023"):
            return ('{"machine":"%s","entrypoint":"cli","workload":"cron","lane":"",'
                    '"body":{"messages":[]}}' % machine)

        def resp_text(pid, reqn):
            return f"# parser=openai-sse model=glm-5.3 reqN={reqn} pid={pid}\n" + SSE

        # paire A : admise 12:00:00, flux ferme 12:04:00 -> L = 240 s
        put(tail_dir, "req-900-0001-2026-11-22T12-00-00-123Z-direct.json", req_text())
        put(tail_dir, "resp-900-r0001-2026-11-22T12-04-00-456Z-openai-sse-glm-5.3.sse",
            resp_text(900, 1))
        # paire B : admise 23:58:00, flux ferme le lendemain 00:01:30
        put(tail_dir, "req-901-0001-2026-11-22T23-58-00-123Z-direct.json", req_text("myia-po-2027"))
        put(tail_dir, "resp-901-r0001-2026-11-23T00-01-30-456Z-openai-sse-glm-5.3.sse",
            resp_text(901, 1))
        d22 = datetime(2026, 11, 22, tzinfo=timezone.utc)
        d23 = d22 + timedelta(days=1)
        r1 = tc.collect([tail_dir], d22, until_dt=d23)["requests"]
        check("A12b fenetre du 22/11 : 2 requetes, 1 repondue, 1 sans reponse (reproduit)",
              (r1["total"], r1["answered"], r1["unanswered"]) == (2, 1, 1),
              {k: r1[k] for k in ("total", "answered", "unanswered")})
        check("A12b L = le plus grand ecart requete->reponse des paires lues (240 s), "
              "et la borne qui en decoule (23:56:00)",
              r1["max_paired_lag_s"] == 240
              and r1["tail_from"] == "2026-11-22T23:56:00+00:00",
              (r1["max_paired_lag_s"], r1["tail_from"]))
        check("A12b LA PIN — elle tombe dans la queue de fenetre, pas dans le residu",
              (r1["unanswered_tail"], r1["unanswered_residue"]) == (1, 0),
              (r1["unanswered_tail"], r1["unanswered_residue"]))
        r2 = tc.collect([tail_dir], d22, until_dt=d23 + timedelta(minutes=5))["requests"]
        check("A12b fenetre elargie de 5 min : la meme paire est repondue, plus rien en queue",
              (r2["answered"], r2["unanswered"], r2["unanswered_tail"]) == (2, 0, 0),
              {k: r2[k] for k in ("answered", "unanswered", "unanswered_tail")})
        early = os.path.join(tmp, "tail-early")
        os.makedirs(early)
        for fn in os.listdir(tail_dir):
            shutil.copy(os.path.join(tail_dir, fn), early)
        put(early, "req-902-0001-2026-11-22T03-00-00-123Z-direct.json", req_text())
        r3 = tc.collect([early], d22, until_dt=d23)["requests"]
        check("A12b une sans-reponse loin de la borne reste du residu",
              (r3["unanswered"], r3["unanswered_tail"], r3["unanswered_residue"]) == (2, 1, 1),
              {k: r3[k] for k in ("unanswered", "unanswered_tail", "unanswered_residue")})
        r4 = tc.collect([tail_dir], d22)["requests"]
        check("A12b mode live (until=None) : borne = la resp la plus recente lue, "
              "la paire a cheval est repondue",
              (r4["answered"], r4["unanswered"], r4["tail_from"])
              == (2, 0, "2026-11-22T23:57:30+00:00"),
              {k: r4[k] for k in ("answered", "unanswered", "tail_from")})
        lonely = os.path.join(tmp, "tail-lonely")
        os.makedirs(lonely)
        put(lonely, "req-903-0001-2026-11-22T10-00-00-123Z-direct.json", req_text())
        r5 = tc.collect([lonely], d22, until_dt=d23)["requests"]
        check("A12b aucune paire appariee : la queue est NON MESURABLE (None), jamais 0",
              r5["unanswered"] == 1 and r5["unanswered_tail"] is None
              and r5["unanswered_residue"] is None and r5["tail_from"] is None, r5)

        # A12c (review ai-01 du 24/11, finding 2) — la borne de 4 Kio
        # (REQ_ENVELOPE_BYTES) : aucun `model` dans les 4 premiers Kio, puis un
        # `"model"` d'entree d'outil APRES. Sans la borne, le mutant
        # `MODEL_FIELD.search(head)` lit « sonnet » et fabrique un modele demande.
        print("A12c — borne de l'enveloppe : un model d'outil apres 4 Kio ne gagne pas")
        pad = "x" * 4300
        body4k = ('{"machine":"myia-po-2024","entrypoint":"cli","workload":"interactive","lane":"",'
                  '"body":{"messages":[{"role":"user","content":"' + pad + '"},'
                  '{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1",'
                  '"name":"Task","input":{"description":"d","prompt":"p","model":"sonnet"}}]}]}}')
        check("A12c fixture : aucun model avant 4 Kio, un apres",
              '"model"' not in body4k[:4096] and '"model":"sonnet"' in body4k[4096:],
              body4k.find('"model"'))
        name4k = "req-800-0001-%sT10-40-00-123Z-direct.json" % DAY
        root4k = build(tmp, n=1, extra_members=[(name4k, body4k.encode())], name="corpus4k")
        work4k = os.path.join(tmp, "w4k")
        os.makedirs(work4k)
        out = read_day(root4k, os.path.join(work4k, "traffic-days.json"), work4k)
        rq4 = json.loads(out.stdout).get("requests") if out.returncode == 0 else None
        check("A12c rc=0 et 2 requetes lues (la paire du jour + la fixture)",
              out.returncode == 0 and rq4 and rq4["total"] == 2, (out.returncode, out.stderr[-400:]))
        check("A12c LA PIN — cle (none) : le model d'outil apres 4 Kio n'est pas le modele demande",
              rq4 and rq4["by_model"] == {"(none)": {"requests": 2, "unanswered": 1}},
              rq4 and rq4["by_model"])
        check("A12c la machine d'enveloppe est toujours lue (la borne ne coupe que le modele)",
              rq4 and rq4["by_machine"] == {"myia-po-2023": {"requests": 1, "unanswered": 0},
                                            "myia-po-2024": {"requests": 1, "unanswered": 1}},
              rq4 and rq4["by_machine"])

        # P — le profil du scan, en mode synthetique (aucune capture lue) : la
        # voie archive entiere, trois phases, top 5 avec parts, rien laisse.
        print("P — archive-scan-profile --synthetic : trois phases, top 5, rien laisse")
        workp = os.path.join(tmp, "wp")
        os.makedirs(workp)
        prof_tool = os.path.join(_SCRIPTS, "archive-scan-profile.py")
        # Le profiteur enfant ecrit dans SON encodage de sortie :
        # PYTHONIOENCODING quand elle est posee (le contrat cp1252 de la chaine),
        # sinon le defaut de locale -- le meme que ce parent. `text=True` seul
        # suppose de l'UTF-8 et meurt en mode UTF-8 sous PYTHONIOENCODING=cp1252.
        child_enc = (os.environ.get("PYTHONIOENCODING") or "").split(":")[0] or None

        def profile_run(*extra):
            return subprocess.run([sys.executable, prof_tool, "--work-dir", workp,
                                   "--extract-root", workp, *extra],
                                  capture_output=True, text=True,
                                  encoding=child_enc, errors="replace")

        out = profile_run("--synthetic", "12", "--json")
        check("P rc=0", out.returncode == 0, out.stderr[-400:])
        prof = json.loads(out.stdout) if out.returncode == 0 else {}
        check("12 resp + 12 req selectionnes, extraits et lus",
              prof.get("extracted") == 24 and prof.get("selected", {}).get("resp") == 12
              and prof.get("sample", {}).get("resp") == 12
              and prof.get("sample", {}).get("req") == 12
              and prof.get("sample", {}).get("unanswered") == 0, (prof.get("selected"), prof.get("sample")))
        fo = prof.get("first_open", {})
        check("premiere ouverture : une moitie en serie, une par pool",
              fo.get("serial", {}).get("files") == 12 and fo.get("pooled", {}).get("files") == 12
              and fo.get("serial", {}).get("ms_per_file") is not None, fo)
        # La marque structurelle, pas le rapport de vitesse (instable sur 12
        # fichiers) : sans elle, une lecture "pool" jamais entree reste verte.
        check("la moitie pool a lu par un AUTRE fil, la serie par le fil appelant",
              fo.get("serial", {}).get("off_caller") is False
              and fo.get("pooled", {}).get("off_caller") is True,
              (fo.get("serial", {}).get("off_caller"), fo.get("pooled", {}).get("off_caller")))
        top = prof.get("top_cumulative", [])
        check("top 5 par temps cumule, collect en tete a 100 %",
              len(top) == 5 and "collect" in top[0]["function"] and top[0]["share"] >= 99.0, top)
        check("scan_usage figure avec une part mesuree",
              any("scan_usage" in r["function"] and r["share"] > 0 for r in top), top)
        check("les deux passes du lecteur ont leur horloge CPU",
              prof.get("scan_plain", {}).get("cpu_share") is not None
              and prof.get("scan_profiled", {}).get("ms_per_resp") is not None,
              (prof.get("scan_plain"), prof.get("scan_profiled")))
        check("rien laisse (extraction, source synthetique)",
              prof.get("cleaned") is True and os.listdir(workp) == [], os.listdir(workp))
        out = profile_run("--synthetic", "12", "--pool", "1", "--json")
        p1 = json.loads(out.stdout)["first_open"] if out.returncode == 0 else {}
        check("--pool 1 : rc=0, ni rapport de vitesse ni lecture sur un autre fil",
              out.returncode == 0 and p1.get("speedup") is None
              and p1.get("pooled", {}).get("off_caller") is False,
              (out.returncode, p1, out.stderr[-300:]))
        out = profile_run("--synthetic", "0")
        check("--synthetic 0 : refuse (rc=2), rien construit",
              out.returncode == 2 and "REFUSED" in out.stderr and os.listdir(workp) == [],
              (out.returncode, out.stderr[-200:], os.listdir(workp)))
        out = profile_run("--json")
        check("ni archive ni synthetique : refuse (rc=2)",
              out.returncode == 2 and "REFUSED" in out.stderr, (out.returncode, out.stderr[-200:]))

        # P2 — le repertoire d'extraction est ALLOUE (mkdtemp), jamais DERIVE
        # (review ai-01, 25/11) : un nom jour+PID est un nom qu'une execution
        # interrompue a pu laisser derriere elle (un PID se recycle), et le
        # finally ne doit retirer que le repertoire que CE run possede — y
        # compris quand l'extraction echoue. Eprouve EN PROCESSUS : le PID
        # derive est alors le notre, donc le voisin porte exactement le nom
        # que l'ancienne regle aurait pris pour le sien.
        print("P2 — repertoire d'extraction alloue : voisin preexistant preserve, succes ET echec")
        prof_mod = _load("prof", "archive-scan-profile.py")

        def prof_ns(rootp):
            return argparse.Namespace(archive=None, day=None, hours="3", max_members=4000,
                                      pool=4, synthetic=4, extract_root=rootp,
                                      work_dir=rootp, json=True)

        def victim_in(rootp):
            """Le nom exact que l'ancienne regle (jour + PID) aurait derive."""
            v = os.path.join(rootp, f"scan-profile-{prof_mod.SYNTHETIC_DAY}-{os.getpid()}")
            os.makedirs(v)
            with open(os.path.join(v, "keep.txt"), "w") as fh:
                fh.write("pre-existing, not this run's\n")
            return v

        root2 = os.path.join(tmp, "wp2")
        os.makedirs(root2)
        victim2 = victim_in(root2)
        # mkdtemp est ecoute : le repertoire doit naitre SOUS la racine que la
        # garde d'espace a mesuree (un `dir` oublie extrait ailleurs, sur un
        # disque que personne n'a verifie, et se nettoie si bien que rien ne
        # le dit).
        made, real_mkdtemp = [], tempfile.mkdtemp

        def recording_mkdtemp(*a, **k):
            path = real_mkdtemp(*a, **k)
            made.append((k.get("prefix"), path))
            return path

        prof_mod.tempfile.mkdtemp = recording_mkdtemp
        try:
            outcome = prof_mod.profile(prof_ns(root2))
        finally:
            tempfile.mkdtemp = real_mkdtemp
        rc2, res2 = outcome if isinstance(outcome, tuple) else (outcome, {})
        check("P2 rc=0 (4 paires synthetiques)", rc2 == 0, (rc2, res2))
        check("P2 le repertoire alloue nait SOUS la racine d'extraction passee",
              any(p == f"scan-profile-{prof_mod.SYNTHETIC_DAY}-"
                  and os.path.normcase(os.path.dirname(path)) == os.path.normcase(root2)
                  for p, path in made), (made, root2))
        check("P2 LA PIN — le voisin preexistant (nom jour+PID de l'ancienne regle) survit",
              os.path.isfile(os.path.join(victim2, "keep.txt")), sorted(os.listdir(root2)))
        check("P2 le repertoire alloue est nettoye, la racine ne garde que le voisin",
              res2.get("cleaned") is True
              and sorted(os.listdir(root2)) == [os.path.basename(victim2)],
              (res2.get("cleaned"), sorted(os.listdir(root2))))

        # Le meme voisin quand l'extraction ECHOUE : `pp` devient un lecteur qui
        # leve, et le finally ne doit toujours toucher que le repertoire alloue.
        root3 = os.path.join(tmp, "wp3")
        os.makedirs(root3)
        victim3 = victim_in(root3)
        real_load = prof_mod._load

        class _Boom:
            @staticmethod
            def read_members(*a, **k):
                raise OSError("extraction simulee en echec")

        def load_boom(name, relpath):
            return _Boom if name == "pp" else real_load(name, relpath)

        prof_mod._load = load_boom
        try:
            out3 = prof_mod.profile(prof_ns(root3))
        finally:
            prof_mod._load = real_load
        rc3, res3 = out3 if isinstance(out3, tuple) else (out3, {})
        check("P2 echec d'extraction : rc=2 (refus, pas un profil)", rc3 == 2, (rc3, res3))
        check("P2 echec d'extraction : le voisin survit, rien d'autre ne reste",
              os.path.isfile(os.path.join(victim3, "keep.txt"))
              and sorted(os.listdir(root3)) == [os.path.basename(victim3)]
              and res3.get("cleaned") is True,
              (res3.get("cleaned"), sorted(os.listdir(root3))))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} -> {FAILS}")
        return 1
    print("all pins green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
