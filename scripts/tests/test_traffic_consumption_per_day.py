#!/usr/bin/env python3
"""Pins for traffic-consumption.py --per-day (#1161 stage 2, the producer).

activity-cost-join.py (stage 2) reads a consumable series:
`{"days":[{date, out, cache_create, cache_read, in?, blind?, partial?}]}`.
This file pins the PRODUCER of that shape:

  P1  shape + values — one row per UTC day that CARRIES a measurement, the
      counters read from the resp captures (the SSE usage triple, not a
      per-field maximum).
  P2  partial is declared, never silently ratio-able: the current day, the
      window-start day (cut off at the cutoff, not midnight), a day whose
      captures are packed into day PARTS, a day carried by its day ARCHIVE.
      An interior day read loose is NOT partial.
  P3  a day with nothing is ABSENT, never a zero — the joiner names it
      `activity-only` instead of inventing a null inEq.
  P4  blind follows lib/blind_spot.py at the DAY grain: a declared fleet
      machine with 0 nominal and 0 archive that day marks the day BLIND.
  P5  end-to-end: producer CLI -> activity-cost-join CLI yields at least one
      ratio row, and the partial days come out flagged without a ratio
      (AC a + b of the #1161 stage-2 grain).
  P6  the text mode renders the same series and names the reasons.
  P7  #1180 — the day DECLARATIONS are the UNION of the corpus roots
      (deduplicated by part name): a day packed on a second disk is declared,
      never forgotten; `--per-day` changes the `days` key and NOTHING else
      (so a key another reader adds to the JSON — `coverage` — is carried,
      never dropped).
  P8  #1180 (review ai-01) — `COVERAGE dirs=<read>/<requested> uncovered=…`
      counts the roots READ; the JSON carries `coverage {requested, covered,
      uncovered}` with and without --per-day; an unreadable root makes every
      emitted day `partial` (`uncovered-roots:N`), so the join refuses it.
  P9  #1181 landed (main merged, cf17e98b): --per-day runs the SAME scan as
      the loose reader, so it carries that reader's coverage contract line
      for line — no readable root is exit 2 (never a corpus read as empty),
      `uncovered` is comma-separated, a file given as a root is an unread
      root (not a crash), an unreadable FIRST root still counts the others,
      each root is listed ONCE (one warning), and a document produced from
      nothing read gives the join no ratio.

Run: python scripts/tests/test_traffic_consumption_per_day.py
"""

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


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


# The seeded message_start + coherent terminal delta of
# test_traffic_consumption_usage.py: usage_of() -> (in=67, out=123, cr=244800,
# cc=100). One pair per capture, so every day carrying one expires the same
# numbers — the pins read them, they never recompute a formula.
SSE = (
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,'
    '"cache_read_input_tokens":0,"cache_creation_input_tokens":0,'
    '"output_tokens":0}}}\n'
    'data: {"type":"message_delta","usage":{"input_tokens":67,'
    '"cache_read_input_tokens":244800,"cache_creation_input_tokens":100,'
    '"output_tokens":123}}\n')


def pair(root, pid, reqn, ts, model="glm-5.3", machine="myia-po-2023"):
    env = ('{"machine":"%s","entrypoint":"cli","workload":"cron","lane":"",'
           '"body":{"messages":[]}}' % machine)
    with open(os.path.join(root, f"req-{pid}-{reqn}-{ts}-direct.json"), "w") as fh:
        fh.write(env)
    head = f"# parser=openai-sse model={model} reqN={reqn} pid={pid}\n"
    with open(os.path.join(root, f"resp-{pid}-r1-{ts}-direct.sse"), "w") as fh:
        fh.write(head + SSE)


def stamp(dt):
    return dt.strftime("%Y-%m-%dT%H-%M-%S-000Z")


def build_corpus(tmp):
    """Days relative to now so the pins hold at any run hour (--hours 96).

    d0 = today-4 (window start: ONE capture 2 min after the cutoff, so the
    day is cut off at the cutoff whatever the hour — a fixed clock time
    would leave the window after 23:00Z), gap = today-3 (NOTHING: absent,
    never a zero), d1 = today-2 (packed part, NO loose capture), d2 = today-1
    (interior, loose -> ratio-able), d3 = today (loose at `now`, current day)."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    d0, gap, d1, d2, d3 = (now.date() - timedelta(days=n)
                           for n in (4, 3, 2, 1, 0))
    root = os.path.join(tmp, "corpus")
    arch = os.path.join(root, "archive")
    os.makedirs(arch)
    # d1: its captures live in a day part this reader does not open
    open(os.path.join(arch, f"captures-{d1}-p1147.7z"), "wb").close()
    pair(root, 1, 1, stamp(now - timedelta(hours=96) + timedelta(minutes=2)))
    pair(root, 1, 2, stamp(datetime.combine(d2, datetime.min.time()).replace(
        hour=12, tzinfo=timezone.utc)))
    pair(root, 1, 3, stamp(now))
    return root, [d.isoformat() for d in (d0, gap, d1, d2, d3)]


def run(roots, *extra):
    roots = [roots] if isinstance(roots, str) else list(roots)
    # --reconcile-dir vers un dossier inexistant : hermetique (aucune archive
    # outage hors-site ne vient peupler la flotte du poste qui lance le test).
    #
    # #1176 contract (#1186), two layers, neither in the scripts:
    #   - CHILD bytes pinned to UTF-8: these children run under -I, where no
    #     env can reach them, so the pin is the -X utf8 of #1010. They decode
    #     exactly on every seat — P8/P9 assert temp PATHS in the text output,
    #     which a cp1252 child writes in cp1252;
    #   - READER tolerant (errors="replace") and normalised with (or ""): it
    #     ALWAYS returns text. A strict decoder reading a cp1252 child raised
    #     UnicodeDecodeError inside subprocess' reader thread and handed back
    #     stdout=None (#1175 signature) — red under PYTHONUTF8=1 on a cp1252
    #     seat, where the reader follows the mode and the -I child does not.
    # The pins match ASCII only, so a replaced byte costs nothing.
    args = [sys.executable, "-I", "-X", "utf8", _TOOL, "--hours", "96",
            "--reconcile-dir", os.path.join(roots[0], "no-reconcile")]
    for r in roots:
        args += ["--dir", r]
    p = subprocess.run(args + list(extra), capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    p.stdout, p.stderr = p.stdout or "", p.stderr or ""
    return p


def as_json(out):
    """stdout as a dict, {} when it is not JSON — a crashed reader must fail
    the check that names it, not the pin file."""
    try:
        return json.loads(out.stdout)
    except ValueError:
        return {}


def main():
    tmp = tempfile.mkdtemp(prefix="perday-")
    try:
        root, (d0, gap, d1, d2, d3) = build_corpus(tmp)

        print("P1 — contrat de forme et valeurs (une ligne par jour mesure)")
        out = run(root, "--per-day", "--json")
        check("rc=0", out.returncode == 0, out.stderr[-400:])
        doc = json.loads(out.stdout)
        days = doc["days"]
        by = {d["date"]: d for d in days}
        check("jours tries", [d["date"] for d in days] == sorted(by), days)
        plain = json.loads(run(root, "--json").stdout)
        check("--per-day change `days` et RIEN d'autre (meme jeu de cles)",
              set(doc) == set(plain) and
              all(doc[k] == plain[k] for k in plain if k != "days"),
              (sorted(set(doc) ^ set(plain)),
               [k for k in plain if k != "days" and doc.get(k) != plain[k]]))
        check("sans --per-day, `days` = null", plain["days"] is None, plain.get("days"))
        for key in ("n", "in", "out", "cache_create", "cache_read"):
            check(f"cle {key} presente", key in by[d2], by.get(d2))
        check("out du triple coherent", by[d2]["out"] == 123, by.get(d2))
        check("cache_create du triple", by[d2]["cache_create"] == 100, by.get(d2))
        check("cache_read du triple", by[d2]["cache_read"] == 244800, by.get(d2))
        check("in du triple", by[d2]["in"] == 67, by.get(d2))
        check("n = 1 capture", by[d2]["n"] == 1, by.get(d2))

        print("P2 — partial declare (jour courant, coupe de fenetre, parts, archive)")
        check("jour courant partial",
              by[d3].get("partial") is True and
              "current-day" in by[d3].get("partial_reasons", []), by.get(d3))
        check("jour de coupe partial",
              by[d0].get("partial") is True and
              "window-start" in by[d0].get("partial_reasons", []), by.get(d0))
        check("jour packe partial (aucune capture loose)",
              by[d1].get("partial") is True and by[d1]["n"] == 0 and
              any(r.startswith("packed:") for r in by[d1].get("partial_reasons", [])),
              by.get(d1))
        check("jour interieur NON partial", "partial" not in by[d2], by.get(d2))

        print("P3 — un jour sans rien est ABSENT, pas un zero")
        check("jour vide non emis", gap not in by, sorted(by))
        zero_days = [d["date"] for d in days if d["n"] == 0]
        check("un zero n'apparait que DECLARE (parts/archive)",
              zero_days == [d1], zero_days)

        print("P4 — blind au grain du JOUR (lib/blind_spot.py)")
        out = run(root, "--per-day", "--json", "--fleet", "myia-po-2099")
        days = json.loads(out.stdout)["days"]
        by = {d["date"]: d for d in days}
        check("fleet muette -> jour BLIND", by[d2].get("blind") is True, by.get(d2))
        check("machine nommee", by[d2].get("blind_machines") == ["myia-po-2099"],
              by.get(d2).get("blind_machines"))
        out = run(root, "--per-day", "--json")
        days = json.loads(out.stdout)["days"]
        check("sans --fleet, aucun BLIND",
              all("blind" not in d for d in days), days)

        print("P5 — bout en bout : producteur -> activity-cost-join (ratio rendu)")
        prod = os.path.join(tmp, "consumption.json")
        with open(prod, "w") as fh:
            fh.write(run(root, "--per-day", "--json").stdout)
        now = datetime.now(timezone.utc)
        activity = {
            "login": "jsboige", "from": d0, "to": d3, "source": "fragment",
            "span_days": 5,
            "coverage": {"covered": 5, "span_days": 5, "absent": []},
            "days": [{"date": d2, "count": 12}, {"date": d3, "count": 5}],
        }
        act = os.path.join(tmp, "activity.json")
        with open(act, "w") as fh:
            json.dump(activity, fh)
        joined = subprocess.run(
            [sys.executable, "-I", "-X", "utf8", _JOIN, "--activity", act,
             "--consumption", prod, "--json"], capture_output=True, text=True,
            encoding="utf-8", errors="replace")
        check("rc=0", joined.returncode == 0, (joined.stderr or "")[-400:])
        rows = {r["date"]: r for r in json.loads(joined.stdout)["rows"]}
        check("au moins une ligne ratio", any(
            r["ratio"] is not None for r in rows.values()), rows)
        check("jour interieur ratio-able", rows[d2]["ratio"] is not None, rows[d2])
        check("jour packe marque partial sans ratio",
              "partial" in rows[d1]["flags"] and rows[d1]["ratio"] is None,
              rows[d1])
        check("ratio = contrib / (inEq/1000)",
              rows[d2]["ratio"] == round(12 / ((1.25 * 100 + 0.1 * 244800 +
                                                5 * 123) / 1000.0), 4), rows[d2])

        print("P6 — mode texte : la serie se rend, les raisons se nomment")
        txt = run(root, "--per-day").stdout
        check("section presente", "== par jour UTC (--per-day, #1161) ==" in txt)
        check("raison nommee", "packed:1-parts" in txt, txt[-500:])
        empty = os.path.join(tmp, "empty")
        os.makedirs(empty)
        check("absence de jour = serie vide dite",
              "aucune mesure ni declaration de jour" in run(empty, "--per-day").stdout)

        print("P7 — #1180 : les declarations sont l'UNION des racines")
        root2 = os.path.join(tmp, "corpus2")
        arch2 = os.path.join(root2, "archive")
        os.makedirs(arch2)
        # packed ONLY on the second root: the loose union (root1) carries
        # nothing of that day — it must still be DECLARED, never forgotten
        open(os.path.join(arch2, f"captures-{gap}-p0900.7z"), "wb").close()
        # the same part NAME as root1's: ONE part, not two
        open(os.path.join(arch2, f"captures-{d1}-p1147.7z"), "wb").close()
        out = run([root, root2], "--per-day", "--json")
        check("rc=0", out.returncode == 0, out.stderr[-400:])
        by2 = {d["date"]: d for d in json.loads(out.stdout)["days"]}
        check("jour packe sur la 2e racine : declare",
              by2.get(gap, {}).get("partial") is True and
              "packed:1-parts" in by2.get(gap, {}).get("partial_reasons", []),
              by2.get(gap))
        check("partie de meme nom sur 2 racines = UNE",
              by2.get(d1, {}).get("partial_reasons", []).count("packed:1-parts") == 1
              and not any("2-parts" in r for r in by2.get(d1, {}).get("partial_reasons", [])),
              by2.get(d1))
        check("une seule racine : ce jour reste absent (l'union ne fabrique rien)",
              gap not in by, sorted(by))

        print("P8 — #1180 (review ai-01, finding 1) : la COVERAGE compte les racines LUES")
        missing = os.path.join(tmp, "no-such-root")
        out = run([root, root2, missing], "--per-day", "--json")
        check("rc=0 (une racine illisible ne tue pas le rapport)",
              out.returncode == 0, out.stderr[-400:])
        want = {"requested": [root, root2, missing], "covered": [root, root2],
                "uncovered": [missing]}
        doc8 = json.loads(out.stdout)
        check("cle `coverage` = {requested, covered, uncovered}",
              doc8.get("coverage") == want, doc8.get("coverage"))
        plain8 = json.loads(run([root, root2, missing], "--json").stdout)
        check("meme `coverage` sans --per-day", plain8.get("coverage") == want,
              plain8.get("coverage"))
        by8 = {d["date"]: d for d in doc8["days"]}
        check("chaque jour emis est partial, raison `uncovered-roots:1`",
              bool(by8) and all(d.get("partial") is True
                                and "uncovered-roots:1" in d.get("partial_reasons", [])
                                for d in by8.values()), by8)
        check("l'avertissement par racine reste sur stderr",
              "capture dir unreadable" in out.stderr, out.stderr[-300:])
        line = next((ln for ln in run([root, root2, missing], "--per-day").stdout.splitlines()
                     if ln.startswith("COVERAGE ")), "")
        check("stdout : COVERAGE dirs=2/3 uncovered=<racine>",
              line == f"COVERAGE dirs=2/3 uncovered={missing}", line)
        cov2 = json.loads(run([root, root2], "--per-day", "--json").stdout).get("coverage")
        check("toutes lues : `uncovered` vide",
              cov2 == {"requested": [root, root2], "covered": [root, root2], "uncovered": []}, cov2)
        line = next((ln for ln in run([root, root2], "--per-day").stdout.splitlines()
                     if ln.startswith("COVERAGE ")), "")
        check("stdout : COVERAGE dirs=2/2, pas de `uncovered=`", line == "COVERAGE dirs=2/2", line)
        # le refus se lit jusqu'au join : le document a demi lu ne donne aucun ratio
        prod8 = os.path.join(tmp, "consumption-half.json")
        with open(prod8, "w") as fh:
            fh.write(json.dumps(doc8))
        joined = subprocess.run(
            [sys.executable, "-I", "-X", "utf8", _JOIN, "--activity", act,
             "--consumption", prod8, "--json"], capture_output=True, text=True,
            encoding="utf-8", errors="replace")
        rows8 = {r["date"]: r for r in json.loads(joined.stdout)["rows"]}
        check("joiner : aucun ratio sur un document lu d'un demi-corpus",
              joined.returncode == 0 and all(r["ratio"] is None and "partial" in r["flags"]
                                             for r in rows8.values()), rows8)

        print("P9 — #1181 dans main (cf17e98b) : --per-day porte le contrat de couverture "
              "du lecteur loose, ligne pour ligne")
        # The cases of scripts/tests/test_multi_dir_readers.py, in --per-day
        # form: both modes run the same scan (collect), so what the loose
        # reader promises about the roots it read, the per-day one promises too.
        other = os.path.join(tmp, "no-such-root-either")
        out = run([missing], "--per-day")
        check("aucune racine lisible : rc=2 (rien lu n'est jamais un corpus vide)",
              out.returncode == 2, (out.returncode, out.stderr[-300:]))
        check("stdout : COVERAGE dirs=0/1 uncovered=<racine>",
              f"COVERAGE dirs=0/1 uncovered={missing}" in out.stdout.splitlines(),
              out.stdout[-300:])
        check("stderr : la ligne d'erreur est dite UNE fois",
              out.stderr.count("error: no capture dir could be read") == 1,
              out.stderr[-400:])
        plain9 = run([missing])
        def _cov_line(text):
            return next((ln for ln in text.splitlines() if ln.startswith("COVERAGE ")), "")
        check("ligne pour ligne : sans et avec --per-day, meme rc, meme ligne COVERAGE, meme stderr",
              (plain9.returncode, _cov_line(plain9.stdout), plain9.stderr)
              == (out.returncode, _cov_line(out.stdout), out.stderr),
              (plain9.returncode, out.returncode, plain9.stderr[-300:], out.stderr[-300:]))
        out = run([missing], "--per-day", "--json")
        doc_none = as_json(out)
        check("en JSON : rc=2, `coverage` nomme la racine non lue",
              out.returncode == 2 and doc_none.get("coverage") == {
                  "requested": [missing], "covered": [], "uncovered": [missing]},
              (out.returncode, doc_none.get("coverage"), out.stderr[-300:]))
        check("en JSON : aucun jour emis (une liste vide, pas un zero)",
              doc_none.get("days") == [], doc_none.get("days"))
        out = run([root, missing, other], "--per-day", "--json")
        doc9 = as_json(out)
        check("deux racines illisibles : separees par une virgule, dans l'ordre demande",
              out.returncode == 0
              and (doc9.get("coverage") or {}).get("uncovered") == [missing, other],
              (out.returncode, doc9.get("coverage"), out.stderr[-300:]))
        line = next((ln for ln in run([root, missing, other], "--per-day").stdout.splitlines()
                     if ln.startswith("COVERAGE ")), "")
        check("stdout : COVERAGE dirs=1/3 uncovered=<a>,<b>",
              line == f"COVERAGE dirs=1/3 uncovered={missing},{other}", line)
        by9 = {d["date"]: d for d in (doc9.get("days") or [])}
        check("chaque jour emis : partial, raison `uncovered-roots:2`",
              bool(by9) and all(d.get("partial") is True
                                and "uncovered-roots:2" in d.get("partial_reasons", [])
                                for d in by9.values()), by9)
        out = run([missing, root], "--per-day", "--json")
        doc9 = as_json(out)
        check("1re racine illisible, la 2e lue : rc=0, la couverture et les comptes suivent la lecture",
              out.returncode == 0
              and (doc9.get("coverage") or {}).get("covered") == [root]
              and (doc9.get("files") or {}).get("resp") == 3,
              (out.returncode, doc9.get("coverage"), doc9.get("files"), out.stderr[-300:]))
        line = next((ln for ln in run([missing, root], "--per-day").stdout.splitlines()
                     if ln.startswith("COVERAGE ")), "")
        check("stdout : COVERAGE dirs=1/2 uncovered=<racine>",
              line == f"COVERAGE dirs=1/2 uncovered={missing}", line)
        a_file = next(os.path.join(root, n) for n in sorted(os.listdir(root))
                      if n.startswith("req-"))
        out = run([root, a_file], "--per-day")
        line = next((ln for ln in out.stdout.splitlines() if ln.startswith("COVERAGE ")), "")
        check("un FICHIER donne pour racine : non lue et nommee, pas un crash",
              out.returncode == 0 and line == f"COVERAGE dirs=1/2 uncovered={a_file}",
              (out.returncode, line, out.stderr[-300:]))
        out = run([root, root2, missing], "--per-day", "--json")
        check("listee UNE fois : un seul avertissement pour la racine illisible (tetes req ET resp)",
              out.returncode == 0
              and out.stderr.count("warning: capture dir unreadable") == 1, out.stderr[-400:])
        prod9 = os.path.join(tmp, "consumption-nothing-read.json")
        with open(prod9, "w") as fh:
            json.dump(doc_none, fh)
        joined = subprocess.run(
            [sys.executable, "-I", "-X", "utf8", _JOIN, "--activity", act,
             "--consumption", prod9, "--json"], capture_output=True, text=True,
            encoding="utf-8", errors="replace")
        rows9 = (as_json(joined).get("rows") or []) if joined.stdout.strip() else []
        check("joiner : un document produit sans rien lire ne rend aucun ratio",
              all(r["ratio"] is None for r in rows9), rows9)
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
