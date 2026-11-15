#!/usr/bin/env python3
"""Pins for the AUTONOMOUS blind-spot declaration (#933, from #912 point 2).

A hub-corpus reader must never render silence as "0 traffic": between a
sidecar going AUTONOMOUS and its hourly reconcile (#927), the hub corpus has
NO capture for that seat, and a machine that is fleet-declared with zero
nominal requests and zero reconciled outage archives in the window is BLIND —
the wording names the unknown, never "no traffic".

Three layers are pinned:
  1. lib/blind_spot.py (assess/render) on fixed datetimes;
  2. one integration pin per reader (traffic-consumption.py, native-
     consumption.py, billed-attrib.py) on a synthetic corpus: the absent
     machine prints the BLIND line, the present one does not;
  3. the #940 CR pins: archives live in a SEPARATE reconcile dir (the GDrive
     folder of reconcile-outage-captures.ps1 — the hub corpus has NO local
     reconcile/), so an archive there must lift the blindness, a duplicate
     name across both dirs counts once, and the readers thread --reconcile-dir.

Run: python scripts/tests/test_blind_spot.py
"""

import contextlib
import importlib.util
import io
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(_HERE, "..", relpath))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bs = _load("blind_spot", os.path.join("lib", "blind_spot.py"))

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


W_START = datetime(2026, 11, 8, 0, 0, tzinfo=timezone.utc)
W_END = datetime(2026, 11, 9, 0, 0, tzinfo=timezone.utc)


def make_corpus(root, machines, day="2026-11-08", hour=10):
    """Synthetic corpus: one req capture per machine in the window."""
    os.makedirs(root, exist_ok=True)
    for i, m in enumerate(machines, start=1):
        with open(os.path.join(
                root,
                f"req-1-{i:04d}-{day}T{hour:02d}-00-00-000Z-direct.json"),
                "w", encoding="utf-8") as fh:
            fh.write('{"ts":"%sT10:00:00Z","src":"direct","machine":"%s"}'
                     % (day, m))


def add_archive(root, machine, start="20261108T060000", end="20261108T120000"):
    d = os.path.join(root, "reconcile")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, f"outage-{machine}-{start}_{end}.7z")
    with open(p, "wb") as fh:
        fh.write(b"7z synthetic")


print("lib — fleet machine absent from the corpus is BLIND, wording AC3")
with tempfile.TemporaryDirectory() as td:
    make_corpus(td, ["seat-a"])
    res = bs.assess(td, W_START, W_END, ["seat-a", "seat-b"])
    check("seat-b blind", res.get("seat-b", {}).get("blind") is True, repr(res))
    check("seat-a not blind", res.get("seat-a", {}).get("blind") is False, repr(res))
    lines = bs.render(td, W_START, W_END, ["seat-a", "seat-b"])
    joined = "\n".join(lines)
    check("BLIND line names the unknown",
          "no capture from seat-b in this window, "
          "outage traffic may not be reconciled yet" in joined, joined)
    check("BLIND never says no traffic", "no traffic" not in joined.lower(), joined)
    check("present machine shows its counts",
          "seat-a: nominal 1 req" in joined and "seat-b: nominal 0 req" in joined, joined)

print("lib — a reconciled archive covering the window lifts the blindness")
with tempfile.TemporaryDirectory() as td:
    make_corpus(td, ["seat-a"])
    add_archive(td, "seat-b")  # 06:00 -> 12:00, inside the window
    res = bs.assess(td, W_START, W_END, ["seat-a", "seat-b"])
    check("archive in window -> not blind",
          res.get("seat-b", {}).get("blind") is False, repr(res))
    check("archive counted", res.get("seat-b", {}).get("archives") == 1, repr(res))

print("lib — an archive OUTSIDE the window does not")
with tempfile.TemporaryDirectory() as td:
    make_corpus(td, ["seat-a"])
    add_archive(td, "seat-b", start="20261001T000000", end="20261001T010000")
    res = bs.assess(td, W_START, W_END, ["seat-a", "seat-b"])
    check("archive outside window -> still blind",
          res.get("seat-b", {}).get("blind") is True, repr(res))
    check("outside archive not counted",
          res.get("seat-b", {}).get("archives") == 0, repr(res))

print("lib — an archive alone declares the machine (fleet by proof)")
with tempfile.TemporaryDirectory() as td:
    make_corpus(td, [])
    add_archive(td, "seat-c", start="20261001T000000", end="20261001T010000")
    res = bs.assess(td, W_START, W_END, [])
    check("seat-c in fleet by archive, blind for this window",
          res.get("seat-c", {}).get("blind") is True, repr(res))

print("lib — direct (no machine field) is never BLIND")
with tempfile.TemporaryDirectory() as td:
    make_corpus(td, [])
    with open(os.path.join(
            td, "req-1-0009-2026-11-08T10-00-00-000Z-direct.json"),
            "w", encoding="utf-8") as fh:
        fh.write('{"ts":"2026-11-08T10:00:00Z","src":"direct"}')
    res = bs.assess(td, W_START, W_END, [])
    check("direct listed, not blind",
          res.get("", {}).get("blind") is False and res.get("", {}).get("nominal") == 1,
          repr(res))

print("lib — empty fleet and empty corpus -> one inactive line, not silence")
with tempfile.TemporaryDirectory() as td:
    lines = bs.render(td, W_START, W_END, [])
    check("inactive notice",
          len(lines) == 1 and "verification inactive" in lines[0], lines)

print("lib — #940 : archive dans le dossier SEPARATE, corpus sans reconcile/")
with tempfile.TemporaryDirectory() as td:
    separate = os.path.join(td, "gd-reconcile")
    os.makedirs(separate)
    with open(os.path.join(
            separate, "outage-seat-b-20261108T060000_20261108T120000.7z"),
            "wb") as fh:
        fh.write(b"7z synthetic")
    make_corpus(td, ["seat-a"])  # corpus volontairement SANS reconcile/ local
    res = bs.assess(td, W_START, W_END, ["seat-a", "seat-b"],
                    reconcile_dir=separate)
    check("separate dir archive -> not blind",
          res.get("seat-b", {}).get("blind") is False, repr(res))
    check("separate dir archive counted",
          res.get("seat-b", {}).get("archives") == 1, repr(res))
    lines = bs.render(td, W_START, W_END, ["seat-a", "seat-b"],
                      reconcile_dir=separate)
    joined = "\n".join(lines)
    check("render counts the separate archive",
          "seat-b: nominal 0 req, archives outage 1" in joined, joined)

print("lib — meme nom d'archive dans les DEUX dossiers : compte une fois")
with tempfile.TemporaryDirectory() as td:
    separate = os.path.join(td, "gd-reconcile")
    fn = "outage-seat-b-20261108T060000_20261108T120000.7z"
    for d in (separate, os.path.join(td, "reconcile")):
        os.makedirs(d)
        with open(os.path.join(d, fn), "wb") as fh:
            fh.write(b"7z synthetic")
    res = bs.assess(td, W_START, W_END, ["seat-b"], reconcile_dir=separate)
    check("dedupe by filename across dirs",
          res.get("seat-b", {}).get("archives") == 1, repr(res))

print("lib — default_reconcile_dir : l'env CLAUDISH_RECONCILE_DIR gagne")
_saved_rdir = os.environ.get("CLAUDISH_RECONCILE_DIR")
try:
    os.environ["CLAUDISH_RECONCILE_DIR"] = os.path.join("X:", "no", "such")
    check("env override honored",
          bs.default_reconcile_dir() == os.path.join("X:", "no", "such"),
          bs.default_reconcile_dir())
finally:
    if _saved_rdir is None:
        del os.environ["CLAUDISH_RECONCILE_DIR"]
    else:
        os.environ["CLAUDISH_RECONCILE_DIR"] = _saved_rdir
if _saved_rdir is None:
    check("default without env is the GDrive reconcile dir",
          bs.default_reconcile_dir() == bs.GDRIVE_RECONCILE_DIR,
          bs.default_reconcile_dir())

print("lib — #997 : read_heads rend les resultats dans l'ordre des entrees")
with tempfile.TemporaryDirectory() as td:
    paths = []
    for i in range(6):
        p = os.path.join(td, f"f{i}.txt")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(f"content-{i}")
        paths.append(p)
    got = bs.read_heads(paths, workers=8)
    check("pool preserves input order",
          got == [f"content-{i}" for i in range(6)], repr(got))
    check("workers=1 is the exact serial path",
          bs.read_heads(paths, workers=1) == got, "")
    check("OSError -> None at its place (skip, pas crash)",
          bs.read_heads([os.path.join(td, "nope.json")], workers=8) == [None],
          "")
    check("full body when size=None",
          bs.read_heads(paths, size=None, workers=8) == got, "")

print("lib — #997 : census identique serie vs pool borne")
with tempfile.TemporaryDirectory() as td:
    # 60 tetes dans la fenetre : 2 machines nommees + seau "" (champ absent)
    # + 1 hors fenetre (ignoree) — un fichier liste puis illisible vaut None
    # -> skip, comme l'OSError serie.
    make_corpus(td, ["seat-a"] * 20 + ["seat-b"] * 10)
    for i in range(30):  # pid 9 : enveloppes SANS champ machine
        with open(os.path.join(
                td, f"req-9-{i:04d}-2026-11-08T11-00-00-000Z-direct.json"),
                "w", encoding="utf-8") as fh:
            fh.write('{"ts":"2026-11-08T11:00:00Z","src":"direct"}')
    with open(os.path.join(  # hors fenetre : jamais lue
            td, "req-1-9999-2026-11-01T10-00-00-000Z-direct.json"),
            "w", encoding="utf-8") as fh:
        fh.write('{"machine":"seat-z"}')
    serial = bs.count_nominal_by_machine(td, W_START, W_END, workers=1)
    pooled = bs.count_nominal_by_machine(td, W_START, W_END, workers=8)
    expected = {"seat-a": 20, "seat-b": 10, "": 30}
    check("serial counts (machine, seau vide)",
          serial == expected, repr(serial))
    check("pool == serial, comptes identiques",
          pooled == serial, f"{pooled!r} vs {serial!r}")
    res_s = bs.assess(td, W_START, W_END, ["seat-a", "seat-b"], workers=1)
    res_p = bs.assess(td, W_START, W_END, ["seat-a", "seat-b"], workers=8)
    check("assess verdict identique serie vs pool",
          res_s == res_p and res_p.get("seat-b", {}).get("nominal") == 10,
          f"{res_p!r}")
    lines_s = bs.render(td, W_START, W_END, ["seat-a", "seat-b"], workers=1)
    lines_p = bs.render(td, W_START, W_END, ["seat-a", "seat-b"], workers=8)
    check("render byte-identique serie vs pool",
          lines_s == lines_p, "\n".join(lines_p))

print()
# Hermetisme (#940) : les lecteurs appliquent default_reconcile_dir() quand le
# flag est absent — sans epingle, le defaut depend du siege (po-2024 a 9 vraies
# archives GDrive, dont une hors fenetre rendrait une machine reelle BLIND et
# casserait le pin "no BLIND at all" localement alors que CI est vert).
os.environ["CLAUDISH_RECONCILE_DIR"] = os.path.join(
    tempfile.gettempdir(), "claudish-test-no-reconcile")

print("integration — traffic-consumption.py main() renders the BLIND line")
tc = _load("traffic_consumption", "traffic-consumption.py")
_now = datetime.now(timezone.utc).replace(microsecond=0)
_day = _now.strftime("%Y-%m-%d")
_stamp = _now.strftime("%Y-%m-%dT%H-%M-%S") + "-000Z"


def tc_run(fleet, machines, rdir=None):
    with tempfile.TemporaryDirectory() as td:
        for i, m in enumerate(machines, start=1):
            with open(os.path.join(
                    td, f"req-1-{i:04d}-{_stamp}-direct.json"),
                    "w", encoding="utf-8") as fh:
                fh.write('{"machine":"%s"}' % m)
        with open(os.path.join(
                td, f"resp-1-r1-{_stamp}-gc-glm-5.3.sse"),
                "w", encoding="utf-8") as fh:
            fh.write("# parser=openai model=glm-5.3 reqN=1 pid=1\n")
        argv_backup = sys.argv
        sys.argv = ["traffic-consumption.py", "--hours", "48",
                    "--dir", td, "--fleet", fleet]
        if rdir:
            sys.argv += ["--reconcile-dir", rdir]
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                tc.main()
        finally:
            sys.argv = argv_backup
        return out.getvalue()


out = tc_run("seat-a,seat-b", ["seat-a"])
check("absent machine BLIND in stdout",
      "no capture from seat-b in this window" in out, out[-400:])
check("present machine not BLIND in stdout",
      "no capture from seat-a in this window" not in out, out[-400:])
out = tc_run("seat-a,seat-b", ["seat-a", "seat-b"])
check("both present -> no BLIND at all", "BLIND" not in out, out[-400:])

print("integration — #940 : --reconcile-dir du lecteur deduit la blindness")
with tempfile.TemporaryDirectory() as rtd:
    rdir = os.path.join(rtd, "reconcile")
    os.makedirs(rdir)
    _t0 = (_now - timedelta(hours=2)).strftime("%Y%m%dT%H%M%S")
    _t1 = (_now + timedelta(hours=1)).strftime("%Y%m%dT%H%M%S")
    with open(os.path.join(rdir, f"outage-seat-b-{_t0}_{_t1}.7z"),
              "wb") as fh:
        fh.write(b"7z synthetic")
    out = tc_run("seat-a,seat-b", ["seat-a"], rdir)
    check("separate archive via --reconcile-dir -> no BLIND",
          "no capture from seat-b" not in out, out[-400:])
    check("separate archive counted by the reader",
          "seat-b: nominal 0 req, archives outage 1" in out, out[-400:])

print("integration — native-consumption.py main() renders it before any verdict")
nc = _load("native_consumption", "native-consumption.py")


def nc_run(fleet, machines):
    with tempfile.TemporaryDirectory() as td:
        for i, m in enumerate(machines, start=1):
            with open(os.path.join(
                    td, f"req-1-{i:04d}-{_stamp}-direct.json"),
                    "w", encoding="utf-8") as fh:
                fh.write('{"machine":"%s","body":{}}' % m)
        with open(os.path.join(
                td, f"resp-1-r1-{_stamp}-native-claude.sse"),
                "w", encoding="utf-8") as fh:
            fh.write("# parser=anthropic model=claude-opus-5-5 reqN=1 pid=1\n")
        argv_backup = sys.argv
        sys.argv = ["native-consumption.py", "--captures-dir", td,
                    "--fleet", fleet]
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                nc.main()
        finally:
            sys.argv = argv_backup
        return out.getvalue()


out = nc_run("seat-a,seat-b", ["seat-a"])
check("absent machine BLIND in stdout",
      "no capture from seat-b in this window" in out, out[:400])
out = nc_run("seat-a,seat-b", ["seat-a", "seat-b"])
check("both present -> no BLIND", "BLIND" not in out, out[:400])

print("integration — billed-attrib.py main() renders it (env corpus root)")
os.environ["CLAUDISH_CAPTURES_ROOT"] = "__SET_PER_RUN__"


def ba_run(fleet, machines):
    with tempfile.TemporaryDirectory() as td:
        os.environ["CLAUDISH_CAPTURES_ROOT"] = td
        ba = _load("billed_attrib_%d" % len(machines), "billed-attrib.py")
        for i, m in enumerate(machines, start=1):
            with open(os.path.join(
                    td, f"req-1-{i:04d}-{_stamp}-direct.json"),
                    "w", encoding="utf-8") as fh:
                fh.write('{"machine":"%s"}' % m)
        with open(os.path.join(
                td, f"resp-1-r1-{_stamp}-native-claude.sse"),
                "w", encoding="utf-8") as fh:
            fh.write('{"input_tokens":10,"cache_creation_input_tokens":0,'
                     '"cache_read_input_tokens":0} {"output_tokens":5}')
        argv_backup = sys.argv
        sys.argv = ["billed-attrib.py", _day, "--fleet", fleet]
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                ba.main()
        finally:
            sys.argv = argv_backup
        return out.getvalue()


out = ba_run("seat-a,seat-b", ["seat-a"])
check("absent machine BLIND in stdout",
      "no capture from seat-b in this window" in out, out[:400])
out = ba_run("seat-a,seat-b", ["seat-a", "seat-b"])
check("both present -> no BLIND", "BLIND" not in out, out[:400])

print()
del os.environ["CLAUDISH_RECONCILE_DIR"]  # hermeticite : rendre le defaut au siege
if FAILS:
    print(f"FAILED: {len(FAILS)} -> {FAILS}")
    sys.exit(1)
print("all pins green")
