#!/usr/bin/env python3
"""Pins for traffic-consumption.py --scan-pool (#1197 symetrique, 26/11).

#1197 (merged) pooled the FIRST open of every extracted file. The trough run of
26/11 measured what that left: `warm` 1 126,7 s (8,34 ms/file in a pool of 8)
then `scan` 7 752,0 s — 57,4 ms per member, because the scan re-opens every
member serially on the caller's thread. `--scan-pool N` pools THAT read; the
selection and the aggregation stay sequential and in input order, so the
contract is exact equality, not "about the same":

  S1  equality — the same corpus read with scan_workers=1 and 8 gives the SAME
      result dict (files, lanes, machines, hlanes, per_day, reqs, first_dt,
      last_dt, coverage) on the loose leg, --per-day included
  S2  unreadable members — a request or a response that cannot be opened is
      skipped and counted the same way in both modes (the name is a real
      capture name; the path is a directory, so open() raises OSError on
      every platform without touching ACLs)
  S3  the switch is INERT by default — collect() == collect(scan_workers=1),
      and the CLI default == the CLI with an explicit 1
  S4  the pool really reads OFF the caller's thread (structural: the thread
      ident of every open), and the serial mode really stays ON it
  S5  a non-OSError from the reader surfaces at its position in the order in
      both modes — the pool never moves a failure
  S6  CLI contract — a pool outside [0, WARM_POOL_MAX] is refused (exit 2,
      the bound is named), 0 is accepted and serial
  S7  --from-archive — the day row is identical with pool 1 and pool 8, and
      the persisted row declares which served (`archive.scan_pool`), so two
      scan durations are never compared without their mode
  S8  the in-flight window of the reader is 4 x workers, not the 32 x default:
      a 300 Ko response text x 256 in flight would hold ~75 Mo of finished
      results

Real py7zr archive for S7 (skipped when py7zr is absent on the seat, as the
sibling from_archive pins do).

Run: python scripts/tests/test_traffic_consumption_scan_pool.py
"""

import builtins
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS = os.path.join(_HERE, "..")
_TOOL = os.path.join(_SCRIPTS, "traffic-consumption.py")

_UTF8_CHILD = {**os.environ, "PYTHONIOENCODING": "utf-8"}

FAILS = []

# Un jour PASSE fixe : aucun pin ici ne depend de l'heure du run.
DAY = "2026-11-02"
OTHER = "2026-11-03"

# Le message_start + delta terminal coherent de test_traffic_consumption_usage:
# usage_of() -> (in=67, out=123, cr=244800, cc=100).
SSE = (
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,'
    '"cache_read_input_tokens":0,"cache_creation_input_tokens":0,'
    '"output_tokens":0}}}\n'
    'data: {"type":"message_delta","usage":{"input_tokens":67,'
    '"cache_read_input_tokens":244800,"cache_creation_input_tokens":100,'
    '"output_tokens":123}}\n')


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


tc = _load("traffic_consumption", "traffic-consumption.py")


def req_name(pid, reqn, day, hhmm):
    return f"req-{pid}-{reqn:04d}-{day}T{hhmm[:2]}-{hhmm[2:]}-00-123Z-direct.json"


def resp_name(pid, reqn, day, hhmm, lag=7):
    return (f"resp-{pid}-r{reqn:04d}-{day}T{hhmm[:2]}-{hhmm[2:]}-{lag:02d}-456Z"
            f"-openai-sse-glm-5.3.sse")


def write_pair(folder, pid, reqn, day, hhmm, machine="myia-po-2023", lane=""):
    with open(os.path.join(folder, req_name(pid, reqn, day, hhmm)), "w",
              encoding="utf-8") as fh:
        fh.write('{"machine":"%s","entrypoint":"cli","workload":"cron","lane":"%s",'
                 '"model":"glm-5.3","body":{"messages":[]}}' % (machine, lane))
    with open(os.path.join(folder, resp_name(pid, reqn, day, hhmm)), "w",
              encoding="utf-8") as fh:
        fh.write(f"# parser=openai-sse model=glm-5.3 reqN={reqn} pid={pid}\n" + SSE)


def build_corpus(tmp, name="corpus"):
    """Deux jours, trois machines/lanes, des paires appariées et deux moities
    orphelines — de quoi faire bouger chaque compteur que l'egalite compare."""
    root = os.path.join(tmp, name)
    os.makedirs(root)
    write_pair(root, 100, 1, DAY, "1000", machine="myia-po-2023", lane="claudish")
    write_pair(root, 100, 2, DAY, "1100", machine="myia-po-2023", lane="claudish")
    write_pair(root, 101, 1, DAY, "1200", machine="myia-po-2025", lane="roo-extensions")
    write_pair(root, 102, 1, OTHER, "0900", machine="myia-ai-01")
    write_pair(root, 102, 2, OTHER, "0930", machine="myia-ai-01")
    # une requete sans reponse et une reponse sans requete : unpaired > 0
    with open(os.path.join(root, req_name(103, 1, DAY, "1300")), "w",
              encoding="utf-8") as fh:
        fh.write('{"machine":"myia-po-2023","entrypoint":"sdk","workload":"interactive",'
                 '"lane":"","model":"glm-5.3","body":{"messages":[]}}')
    with open(os.path.join(root, resp_name(104, 1, DAY, "1400")), "w",
              encoding="utf-8") as fh:
        fh.write("# parser=openai-sse model=glm-5.3 reqN=1 pid=104\n" + SSE)
    return root


def main():
    tmp = tempfile.mkdtemp(prefix="scanpool-")
    try:
        root = build_corpus(tmp)
        cutoff = datetime(2026, 11, 1, tzinfo=timezone.utc)

        print("S1 — egalite exacte pool 1 / pool 8 sur la jambe loose")
        one = tc.collect([root], cutoff, per_day=True, scan_workers=1)
        eight = tc.collect([root], cutoff, per_day=True, scan_workers=8)
        check("resultat identique, cle par cle", one == eight,
              [k for k in set(one) | set(eight) if one.get(k) != eight.get(k)])
        # ORACLE ABSOLU — deux modes du MEME code refactore sont egaux meme
        # quand ce code est faux : l'egalite n'est une preuve que sur un
        # resultat juste. Ces valeurs sont derivees A LA MAIN de la fixture
        # (5 paires + 1 reponse orpheline + 1 requete orpheline), jamais du
        # lecteur.
        check("oracle : 6 reponses, 5 appariees, 1 non appariee, 0 sans usage",
              one["files"] == {"resp": 6, "paired": 5, "unpaired": 1,
                               "no_usage": 0}, one["files"])
        check("oracle : 6 requetes, 5 repondues, 1 sans reponse",
              (one["requests"]["total"], one["requests"]["answered"],
               one["requests"]["unanswered"]) == (6, 5, 1),
              {k: one["requests"].get(k) for k in ("total", "answered", "unanswered")})
        check("oracle : chaque reponse sur SA machine",
              {k: sum(b["n"] for b in v.values())
               for k, v in one["machines"].items()}
              == {"gc@ GLM Coding | myia-po-2023": 2,
                  "gc@ GLM Coding | myia-po-2025": 1,
                  "gc@ GLM Coding | myia-ai-01": 2,
                  "gc@ GLM Coding | (unpaired)": 1},
              {k: sum(b["n"] for b in v.values()) for k, v in one["machines"].items()})
        check("oracle : par jour, 4 le 02/11 et 2 le 03/11",
              {d: r["n"] for d, r in one["per_day"].items()} == {DAY: 4, OTHER: 2},
              {d: r["n"] for d, r in one["per_day"].items()})
        check("oracle : l'ecart requete->reponse lu sur les NOMS, a la seconde (7 s)",
              one["requests"]["max_paired_lag_s"] == 7.0,
              one["requests"].get("max_paired_lag_s"))

        print("S3 — l'interrupteur est INERTE par defaut")
        default = tc.collect([root], cutoff, per_day=True)
        check("collect() == collect(scan_workers=1)", default == one,
              [k for k in set(default) | set(one) if default.get(k) != one.get(k)])
        bound = tc._load_partial_parts()
        check("bornes : 0 et negatif = serie, > max = max",
              [bound.bound_workers(n) for n in (0, -3, 1, 8, 10 ** 6)]
              == [1, 1, 1, 8, bound.WARM_POOL_MAX])

        print("S2 — un membre illisible est saute pareil des deux cotes")
        # Un corpus SEPARE : deux noms de capture REELS dont le chemin est un
        # DOSSIER — open() leve OSError sans jouer avec les ACL.
        root2 = build_corpus(tmp, name="corpus-illisible")
        os.makedirs(os.path.join(root2, req_name(105, 1, DAY, "1500")))
        os.makedirs(os.path.join(root2, resp_name(105, 1, DAY, "1500")))
        s_one = tc.collect([root2], cutoff, per_day=True, scan_workers=1)
        s_eight = tc.collect([root2], cutoff, per_day=True, scan_workers=8)
        check("toujours identique", s_one == s_eight,
              [k for k in set(s_one) | set(s_eight) if s_one.get(k) != s_eight.get(k)])
        check("oracle : la reponse illisible est COMPTEE (7) et ni appariee "
              "ni non appariee (5 / 1)",
              (s_one["files"]["resp"], s_one["files"]["paired"],
               s_one["files"]["unpaired"]) == (7, 5, 1), s_one["files"])
        check("oracle : la requete illisible n'est pas une requete (6, pas 7)",
              (len(s_one["reqs"]), (105, 1) in s_one["reqs"]) == (6, False),
              sorted(s_one["reqs"]))

        print("S4 — le pool lit hors du fil appelant, la serie y reste")
        opened = []
        lock = threading.Lock()
        real_open = builtins.open

        def spy(path, *a, **k):
            try:
                name = os.path.basename(str(path))
            except Exception:  # noqa: BLE001 — un FD entier, pas un chemin
                name = ""
            with lock:
                opened.append((name, threading.get_ident()))
            return real_open(path, *a, **k)

        builtins.open = spy
        try:
            tc.collect([root], cutoff, per_day=True, scan_workers=1)
            serial_threads = {t for n, t in opened if n.startswith(("req-", "resp-"))}
            opened.clear()
            tc.collect([root], cutoff, per_day=True, scan_workers=8)
            pooled_threads = {t for n, t in opened if n.startswith(("req-", "resp-"))}
        finally:
            builtins.open = real_open
        check("serie : tous les opens sur le fil appelant",
              serial_threads == {threading.get_ident()}, serial_threads)
        check("pool : aucun open sur le fil appelant",
              pooled_threads and threading.get_ident() not in pooled_threads,
              pooled_threads)

        print("S5 — une exception de lecteur ne bouge pas de place")
        paths = [os.path.join(tmp, f"n-{i}.bin") for i in range(6)]
        for p in paths:
            with open(p, "wb") as fh:
                fh.write(b"x")

        def reader(p):
            if p.endswith("n-3.bin"):
                raise ValueError("lecteur casse")
            return p

        def positions(workers):
            got = []
            try:
                for v in tc._iter_texts(paths, reader, workers):
                    got.append(v)
            except ValueError:
                got.append("VALUEERROR")
            return got

        check("serie et pool rendent la meme sequence, echec compris",
              positions(1) == positions(8)
              and positions(1)[-1] == "VALUEERROR"
              and len(positions(1)) == 4,
              (positions(1), positions(8)))

        print("S6 — contrat CLI")
        # La jambe loose n'ouvre aucune archive : l'enfant tourne sous -I,
        # comme ceux de test_traffic_consumption_per_day.py.
        base = [sys.executable, "-I", "-X", "utf8", _TOOL, "--dir", root,
                "--reconcile-dir", os.path.join(tmp, "no-reconcile"),
                "--hours", "100000", "--json",
                "--machines", "--harness-lanes"]
        bad = subprocess.run(base + ["--scan-pool", str(tc._load_partial_parts().WARM_POOL_MAX + 1)],
                             capture_output=True, text=True, encoding="utf-8",
                             errors="replace", env=_UTF8_CHILD)
        bad.stdout, bad.stderr = bad.stdout or "", bad.stderr or ""
        check("hors borne : exit 2", bad.returncode == 2, bad.returncode)
        check("hors borne : la borne est nommee",
              f"0..{tc._load_partial_parts().WARM_POOL_MAX}" in bad.stderr,
              bad.stderr[-400:])
        check("hors borne : rien n'est lu (aucun JSON sur stdout)", not bad.stdout.strip(),
              bad.stdout[:200])

        dflt = subprocess.run(base, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", env=_UTF8_CHILD)
        zero = subprocess.run(base + ["--scan-pool", "0"], capture_output=True,
                              text=True, encoding="utf-8", errors="replace",
                              env=_UTF8_CHILD)
        eight_cli = subprocess.run(base + ["--scan-pool", "8"], capture_output=True,
                                   text=True, encoding="utf-8", errors="replace",
                                   env=_UTF8_CHILD)
        for p in (dflt, zero, eight_cli):
            p.stdout, p.stderr = p.stdout or "", p.stderr or ""
        check("defaut / 0 / 8 : exit 0",
              (dflt.returncode, zero.returncode, eight_cli.returncode) == (0, 0, 0),
              (dflt.returncode, zero.returncode, eight_cli.returncode,
               dflt.stderr[-300:]))
        jd = json.loads(dflt.stdout)
        jz = json.loads(zero.stdout)
        je = json.loads(eight_cli.stdout)
        check("oracle CLI : 6 reponses, 5 appariees, 1 non appariee",
              jd.get("files") == {"resp": 6, "paired": 5, "unpaired": 1,
                                  "no_usage": 0}, jd.get("files"))
        volatile = {"elapsed_s", "read_at", "generated_at"}
        strip = lambda d: {k: v for k, v in d.items() if k not in volatile}  # noqa: E731
        check("defaut == 0 (serie)", strip(jd) == strip(jz),
              [k for k in jd if jd.get(k) != jz.get(k)])
        check("defaut == 8 (le decompte ne bouge pas)", strip(jd) == strip(je),
              [k for k in jd if jd.get(k) != je.get(k)])

        print("S8 — la fenetre en vol du lecteur est 4 x workers")
        import concurrent.futures as cf
        submits = []
        real_ex = cf.ThreadPoolExecutor

        class SpyExecutor(real_ex):
            def submit(self, fn, *a, **k):
                submits.append(1)
                return super().submit(fn, *a, **k)

        big = []
        for i in range(400):
            p = os.path.join(tmp, "big-%d.bin" % i)
            with open(p, "wb") as fh:
                fh.write(b"z")
            big.append(p)
        cf.ThreadPoolExecutor = SpyExecutor
        try:
            gen = tc._iter_texts(big, lambda p: p, 8)
            next(gen)
            first = len(submits)
            gen.close()
        finally:
            cf.ThreadPoolExecutor = real_ex
        check("32 soumissions d'avance au premier item (4 x 8, pas 32 x 8)",
              0 < first <= 32, first)

        print("S7 — --from-archive : meme ligne, et le mode declare")
        try:
            import py7zr  # noqa: F401
        except ImportError:
            print("  SKIP — py7zr absent on this seat")
        else:
            import py7zr

            src = os.path.join(tmp, "src")
            os.makedirs(src)
            for i in range(3):
                write_pair(src, 200 + i, 1, DAY, "100%d" % i)
            arch_root = os.path.join(tmp, "archroot")
            arch = os.path.join(arch_root, "archive", f"captures-{DAY}.7z")
            os.makedirs(os.path.dirname(arch))
            with py7zr.SevenZipFile(arch, "w") as z:
                for fn in sorted(os.listdir(src)):
                    z.write(os.path.join(src, fn), arcname=fn)
            rows = {}
            for pool in (1, 8):
                work = os.path.join(tmp, f"w-{pool}")
                os.makedirs(work)
                series = os.path.join(work, "traffic-days.json")
                p = subprocess.run(
                    [sys.executable, _TOOL, "--dir", arch_root,
                     "--reconcile-dir", os.path.join(work, "no-reconcile"),
                     "--series-file", series, "--extract-root", work,
                     "--from-archive", DAY, "--json",
                     "--scan-pool", str(pool)],
                    capture_output=True, text=True, encoding="utf-8",
                    errors="replace", env=_UTF8_CHILD)
                p.stdout, p.stderr = p.stdout or "", p.stderr or ""
                check(f"pool {pool} : exit 0", p.returncode == 0,
                      p.stderr[-500:] + p.stdout[-300:])
                rows[pool] = json.loads(p.stdout)["days"][-1]
            one, eight = rows[1], rows[8]

            def stable(row):
                a = {k: v for k, v in row["archive"].items()
                     if k not in ("scan_pool", "read_at", "seconds")}
                return {**{k: v for k, v in row.items() if k != "archive"},
                        "archive": a}

            diff = {k for k in set(one) | set(eight) if one.get(k) != eight.get(k)}
            check("la ligne du jour est identique hors mode et durees",
                  stable(one) == stable(eight) and diff <= {"archive"},
                  {k: (one.get(k), eight.get(k)) for k in diff})
            check("oracle : 3 reponses et le triplet d'usage lu des captures "
                  "(in=201, out=369, cc=300, cr=734400)",
                  (one["n"], one["in"], one["out"], one["cache_create"],
                   one["cache_read"]) == (3, 201, 369, 300, 734400),
                  {k: one.get(k) for k in ("n", "in", "out", "cache_create",
                                           "cache_read")})
            check("archive.scan_pool declare le mode qui a servi",
                  (one["archive"]["scan_pool"], eight["archive"]["scan_pool"]) == (1, 8),
                  (one["archive"], eight["archive"]))
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    if FAILS:
        print(f"\n{len(FAILS)} FAIL(s): {FAILS}")
        return 1
    print("\nall scan-pool pins passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
