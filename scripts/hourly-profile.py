#!/usr/bin/env python3
"""hourly-profile.py — profil horaire UTC x lane d'un corpus de captures (#21/Q70).

Repond a la question tarifaire du jalon Q70 : combien de reponses et de tokens
de sortie tombent dans chaque bande horaire UTC, par lane, ouvre/week-end
separes. Les deux tarifs a heure variable de la flotte sont ouvre-seulement
(GLM Coding Plan : lun-ven 14:00-18:00 SGT = 06:00-10:00 UTC ; DeepSeek PAYG :
01:00-04:00 et 06:00-10:00 UTC), donc un rollup heure-du-jour sur 7 jours melange
des heures payees et gratuites — le split ouvre/week-end est la demi-ligne de
ce profil, pas une option.

Sources acceptees :
  --corpus DIR    repertoire de sous-repertoires `YYYY-MM-DD/` (corpus hub vif,
                  ou archives `captures-<jour>.7z` prealablement extraites —
                  py7zr est inutilisable a 100k fichiers, ~315 fichiers/6 min
                  mesures ; l'extraction rapide est `7zr x -o<corpus> archive.7z`).

Aucune regle de lecture nouvelle : les parseurs sont ceux de
traffic-consumption.py importes tels quels (appariement req/resp par horodatage,
triplet d'usage coherent #600, lane par nom de modele servi, bucket
cron/interactive/agent-sdk/other du bloc billing). Si un piege de lecture change,
il change la-bas et ici en meme temps.

Angle mort (dit ici, pas nie) : corpus hub = les NOMINAL sont relays donc
visibles ; un sidecar en AUTONOMOUS ecrit seulement en local et manque ici
(mesure sur le siege rapporteur : ~2 episodes courts/jour, faible).

Bande = --band NOM=DEB-FIN en heures UTC, demi-ouverte [DEB, FIN) : A=1-4 couvre
les heures 01, 02, 03. La note tarifaire (--tariff-note) est echouee telle
quelle dans l'en-tete : une bande est une DECISION re-sourcee dateree, jamais
une constante du script.

Sortie : tableau heure-du-jour x lane (reponses, tokens sortie, buckets, lane.n,
lane.out) pour ouvre et week-end, part de chaque lane dans les bandes vs
hors-bande, part cron dans chaque bande. --out FILE ajoute le meme contenu en
JSON (cle par nom de lane, ordre non significatif).
"""

import argparse
import importlib.util
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

_DAY_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Ordre d'affichage des lanes connues (celles de la flotte au moment du jalon) ;
# toute lane inconnue du corpus est appended, triee — le tableau reste stable
# d'un run a l'autre tant que le corpus ne fait pas apparaitre de lane nouvelle.
KNOWN_LANES = [
    "gc@ GLM Coding", "ds@ PAYG", "mmc@ MiniMax", "native-anthropic",
    "cx@ Sol (OpenAI Pro)", "k3.1-pro", "swift-1.5-27b", "gpt-6-luna",
    "gpt-6.1-terra", "qwen-token-plan",
]

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def load_traffic_consumption():
    """traffic-consumption.py en module (nom dashé -> spec_from_file_location,
    la meme approche que ses propres lib partagees)."""
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "traffic-consumption.py")
    spec = importlib.util.spec_from_file_location("traffic_consumption", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def blank_cell():
    return {"resp": 0, "out": 0, "lane": Counter(), "lane_out": Counter(),
            "bucket": Counter(), "machine": Counter()}


def scan_day(day_dir, tc):
    """Un sous-repertoire jour -> {(hour): cell}. cutoff = minuit du jour :
    une requete d'avant minuit ne peut pas apparier une reponse du jour."""
    day = os.path.basename(os.path.normpath(day_dir))
    cutoff = datetime(int(day[0:4]), int(day[5:7]), int(day[8:10]),
                      tzinfo=timezone.utc)
    reqs = tc.load_requests(day_dir, cutoff)
    grid = defaultdict(blank_cell)
    for fn in os.listdir(day_dir):
        if not (fn.startswith("resp-") and fn.endswith(".sse")):
            continue
        rm = tc.RESP_FN.match(fn)
        if not rm:
            continue
        dt = tc.capture_dt(rm.group(1))
        if dt is None:
            continue
        cell = grid[dt.hour]
        cell["resp"] += 1
        try:
            txt = tc.read_head_tail(os.path.join(day_dir, fn))
        except OSError:
            continue
        hd = tc.HDR.search(txt)
        if not hd:
            continue
        model, reqn, pid = hd.group(2), int(hd.group(3)), int(hd.group(4))
        tsm = tc.RESP_TS.search(fn)
        req = tc.pick_request(reqs.get((pid, reqn)) or [],
                              tsm.group(1) if tsm else None)
        cell["bucket"][tc.bucket_of(req) if req else "other"] += 1
        cell["machine"][(req["machine"] or "direct") if req else "(unpaired)"] += 1
        u = tc.usage_of(txt)
        out = u[1] if u else 0
        lane = tc.lane_for(model)
        cell["lane"][lane] += 1
        cell["lane_out"][lane] += out
        cell["out"] += out
    return grid


def merge_hours(day_grids):
    """[{hour: cell} par jour] -> {hour: cell} additionnes."""
    per_hour = {h: blank_cell() for h in range(24)}
    for grid in day_grids:
        for h, c in grid.items():
            t = per_hour[h]
            for k in ("resp", "out"):
                t[k] += c[k]
            for k in ("lane", "lane_out", "bucket", "machine"):
                t[k].update(c[k])
    return per_hour


def lane_columns(per_hour_wd):
    """Lanes connues d'abord, puis nouvelles du corpus triees — colonnes stables."""
    seen = set()
    for h in range(24):
        seen.update(per_hour_wd[h]["lane"])
    extra = sorted(seen - set(KNOWN_LANES))
    return KNOWN_LANES + [l for l in extra if l not in KNOWN_LANES]


def parse_band(spec):
    """'A=1-4' -> ('A', (1, 2, 3)). Demi-ouvert [DEB, FIN), heures UTC."""
    m = re.match(r"^([A-Za-z0-9_.-]+)=(\d{1,2})-(\d{1,2})$", spec)
    if not m:
        raise argparse.ArgumentTypeError(
            "bande mal formee %r : attendu NOM=DEB-FIN (heures UTC, demi-ouvert)" % spec)
    name, lo, hi = m.group(1), int(m.group(2)), int(m.group(3))
    if not (0 <= lo < hi <= 24):
        raise argparse.ArgumentTypeError(
            "bande %s : il faut 0 <= DEB < FIN <= 24 (eu %d-%d)" % (name, lo, hi))
    return name, tuple(range(lo, hi))


def print_hour_table(label, per_hour, lanes):
    print("\n== %s: %d hour rows (UTC) ==" % (label, 24))
    cols = ["hour", "resp", "out_tok", "cron", "inter", "sdk"]
    cols += [l.split(" ")[0] + ".n" for l in lanes]
    cols += [l.split(" ")[0] + ".out" for l in lanes]
    print("\t".join(cols))
    for h in range(24):
        t = per_hour[h]
        row = [f"{h:02d}", str(t["resp"]), str(t["out"]),
               str(t["bucket"].get("cron", 0)),
               str(t["bucket"].get("interactive", 0)),
               str(t["bucket"].get("agent-sdk", 0))]
        row += [str(t["lane"].get(l, 0)) for l in lanes]
        row += [str(t["lane_out"].get(l, 0)) for l in lanes]
        print("\t".join(row))


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Profil horaire UTC x lane d'un corpus de captures (jalon #21/Q70)")
    ap.add_argument("--corpus", required=True,
                    help="repertoire de sous-repertoires YYYY-MM-DD (captures extraites)")
    ap.add_argument("--band", action="append", type=parse_band, default=[],
                    metavar="NOM=DEB-FIN",
                    help="bande horaire UTC demi-ouverte, ex. --band A=1-4 ; repetable")
    ap.add_argument("--tariff-note", default="",
                    help="note tarifaire echouee dans l'en-tete (date d'acces + source)")
    ap.add_argument("--out", default="", help="ecrit aussi le profil en JSON ici")
    args = ap.parse_args(argv)

    days = sorted(d for d in os.listdir(args.corpus) if _DAY_DIR.match(d))
    if not days:
        print("no YYYY-MM-DD day directories under %s" % args.corpus, file=sys.stderr)
        return 2
    wd = {d: datetime(int(d[0:4]), int(d[5:7]), int(d[8:10])).weekday() for d in days}

    print("corpus: %s" % os.path.abspath(args.corpus))
    print("days:")
    for d in days:
        print("  %s  %s" % (d, DAY_NAMES[wd[d]]))
    print("tariff bands (UTC, half-open): %s%s" % (
        ", ".join("%s=%02d-%02d" % (n, hs[0], hs[-1] + 1) for n, hs in args.band)
        or "(none given)",
        ("  note: " + args.tariff_note) if args.tariff_note else ""))
    print("instrument limits: hub corpus only — a sidecar in AUTONOMOUS writes "
          "locally and is missing here; lanes are attributed by SERVED model name")

    tc = load_traffic_consumption()
    grids, skipped = {}, []
    for d in days:
        ddir = os.path.join(args.corpus, d)
        try:
            grids[d] = scan_day(ddir, tc)
        except OSError as e:
            skipped.append((d, str(e)))
            continue
    for d, why in skipped:
        print("SKIP %s: %s" % (d, why), file=sys.stderr)

    weekdays = [d for d in days if wd[d] < 5]
    weekend = [d for d in days if wd[d] >= 5]
    h_wd = merge_hours(grids[d] for d in weekdays) if weekdays else {h: blank_cell() for h in range(24)}
    h_we = merge_hours(grids[d] for d in weekend) if weekend else {h: blank_cell() for h in range(24)}

    lanes = lane_columns(h_wd)
    print_hour_table("WEEKDAYS (%d day(s); peak tariffs apply)" % len(weekdays), h_wd, lanes)
    print_hour_table("WEEKEND (%d day(s); all off-peak)" % len(weekend), h_we, lanes)

    if args.band:
        band_hours = {}
        for name, hours in args.band:
            band_hours[name] = hours
        peak = set().union(*band_hours.values())
        off = tuple(h for h in range(24) if h not in peak)

        print("\n== weekday lanes: bands vs off-peak ==")
        print("lane\t" + "\t".join(
            "%s_n\t%s_out" % (n, n) for n, _ in args.band)
            + "\toffpeak_n\toffpeak_out\tbands_share_n\tbands_share_out")
        for l in lanes:
            tot_n = tot_o = 0
            parts = []
            for _, hours in args.band:
                n = sum(h_wd[h]["lane"].get(l, 0) for h in hours)
                o = sum(h_wd[h]["lane_out"].get(l, 0) for h in hours)
                parts += [str(n), str(o)]
                tot_n += n
                tot_o += o
            on = sum(h_wd[h]["lane"].get(l, 0) for h in off)
            oo = sum(h_wd[h]["lane_out"].get(l, 0) for h in off)
            tot_n += on
            tot_o += oo
            parts += [str(on), str(oo),
                      f"{(tot_n - on) / tot_n * 100 if tot_n else 0:.1f}%",
                      f"{(tot_o - oo) / tot_o * 100 if tot_o else 0:.1f}%"]
            print(l + "\t" + "\t".join(parts))

        print("\n== weekday cron share inside the bands ==")
        rows = [(n, hours) for n, hours in args.band] + [("off-peak", off)]
        for label, hours in rows:
            n = sum(h_wd[h]["bucket"].get("cron", 0) for h in hours)
            alln = sum(h_wd[h]["resp"] for h in hours)
            out = sum(h_wd[h]["out"] for h in hours)
            print("%s %02d-%02d\tcron=%d\tresp=%d\tcron_share=%.1f%%\tout=%d" % (
                label, hours[0], hours[-1] + 1, n, alln,
                n / alln * 100 if alln else 0, out))

    if args.out:
        dump = {
            "days": {d: DAY_NAMES[wd[d]] for d in days},
            "bands": {n: list(hs) for n, hs in args.band},
            "tariff_note": args.tariff_note,
            "weekday": {str(h): {"resp": h_wd[h]["resp"], "out": h_wd[h]["out"],
                                 "lane": dict(h_wd[h]["lane"]),
                                 "lane_out": dict(h_wd[h]["lane_out"]),
                                 "bucket": dict(h_wd[h]["bucket"]),
                                 "machine": dict(h_wd[h]["machine"])}
                        for h in range(24)},
            "weekend": {str(h): {"resp": h_we[h]["resp"], "out": h_we[h]["out"],
                                 "lane": dict(h_we[h]["lane"]),
                                 "lane_out": dict(h_we[h]["lane_out"]),
                                 "bucket": dict(h_we[h]["bucket"]),
                                 "machine": dict(h_we[h]["machine"])}
                        for h in range(24)},
        }
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(dump, fh, indent=1)
        print("\nwrote %s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
