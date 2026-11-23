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
    args = [sys.executable, "-I", _TOOL, "--hours", "96",
            "--reconcile-dir", os.path.join(roots[0], "no-reconcile")]
    for r in roots:
        args += ["--dir", r]
    return subprocess.run(args + list(extra), capture_output=True, text=True)


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
            [sys.executable, "-I", _JOIN, "--activity", act,
             "--consumption", prod, "--json"], capture_output=True, text=True)
        check("rc=0", joined.returncode == 0, joined.stderr[-400:])
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
