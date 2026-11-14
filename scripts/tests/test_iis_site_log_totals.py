#!/usr/bin/env python3
"""Pins for iis-site-log-totals.py (grain v50-5, PR of 2026-11-08).

The custom X-Claudish-Machine field (site 49, 2026-11-07 20:25Z) made every
subsequent log file `_x`-shaped: one extra TRAILING column. Tail-anchored and
fixed-offset parsers silently misread those files. These pins hold the parser
to the only stable contract: the file's own #Fields header.

  1. SHAPE_EQUIVALENCE — an old-shape file and an `_x` file describing the
     same logical traffic yield the SAME requests/4xx/5xx totals.
  2. PER_MACHINE — machine rows come from the header column when present,
     with "-" folding to a no-header bucket; old-shape files never invent it.
  3. MISMATCH_SKIP — a line whose token count disagrees with its header is
     skipped, not misread into a wrong column.
  4. FIELD_ORDER — a header with the same fields in a DIFFERENT order still
     resolves sc-status correctly (the anchor is the name, not the position).
"""
import importlib.util
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "..", "iis-site-log-totals.py")

spec = importlib.util.spec_from_file_location("iis_site_log_totals", TARGET)
ilt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ilt)

FAILURES = []


def pin(name, cond, detail=""):
    print(f"  [{'PASS' if cond else 'RED'}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


OLD_FIELDS = ("date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username "
              "c-ip cs(User-Agent) cs(Referer) sc-status sc-substatus sc-win32-status "
              "sc-bytes cs-bytes time-taken").split()
X_FIELDS = OLD_FIELDS + ["X-Claudish-Machine"]

# same logical traffic expressed in both shapes
ROWS = [  # (status, machine or None)
    ("200", "myia-po-2027"), ("200", "myia-po-2027"), ("200", "myia-web2"),
    ("500", "myia-po-2027"), ("502", "myia-web2"), ("404", None), ("200", None),
]


def CUSTOM_FIELD_PRESENT(fields):
    return "X-Claudish-Machine" in fields


def write_log(path, fields, rows, inject_bad=False):
    with open(path, "w", encoding="ascii") as fh:
        fh.write("#Software: Microsoft Internet Information Services 10.0\n")
        fh.write("#Fields: " + " ".join(fields) + "\n")
        for status, machine in rows:
            cells = ["2026-11-08", "10:00:0%d" % ROWS.index((status, machine)),
                     "192.168.0.46", "GET", "/v1/messages", "-", "443", "-",
                     "90.65.170.144", "Bun/1.3.14", "-", status, "0", "0",
                     "5906", "625", "13"]
            if CUSTOM_FIELD_PRESENT(fields):
                cells.append(machine if machine is not None else "-")
            fh.write(" ".join(cells) + "\n")
        if inject_bad:
            fh.write("one two three\n")  # token/field mismatch


tmp = tempfile.mkdtemp(prefix="ilt-")
old_log = os.path.join(tmp, "u_ex261106.log")
x_log = os.path.join(tmp, "u_ex261107_x.log")
bad_log = os.path.join(tmp, "u_ex261108_x.log")
write_log(old_log, OLD_FIELDS, ROWS)
write_log(x_log, X_FIELDS, ROWS)
write_log(bad_log, X_FIELDS, ROWS, inject_bad=True)

t_old = ilt.totals([old_log])
t_x = ilt.totals([x_log])
t_bad = ilt.totals([bad_log])

print("1. SHAPE_EQUIVALENCE")
pin("same totals old vs _x",
    (t_old["requests"], t_old["s4xx"], t_old["s5xx"]) == (t_x["requests"], t_x["s4xx"], t_x["s5xx"])
    == (7, 1, 2),
    f"old={t_old} x={t_x}")

print("2. PER_MACHINE")
pin("x-file machine rows",
    t_x["machines"].get("myia-po-2027") == 3 and t_x["machines"].get("myia-web2") == 2
    and t_x["machines"].get("-") == 2, f"machines={t_x['machines']}")
pin("machine failures counted",
    t_x["machine_fail"].get("myia-po-2027") == 1 and t_x["machine_fail"].get("myia-web2") == 1)
pin("old file never invents machines", t_old["machines"] == {"-": 7}, f"machines={t_old['machines']}")

print("3. MISMATCH_SKIP")
pin("bad-token line skipped, good lines counted",
    t_bad["requests"] == 7 and t_bad["s5xx"] == 2, f"totals={t_bad}")
pin("skipped visible in totals", t_bad["skipped"] == 1, f"skipped={t_bad.get('skipped')}")
pin("clean files skip nothing",
    t_old["skipped"] == 0 and t_x["skipped"] == 0,
    f"old={t_old.get('skipped')} x={t_x.get('skipped')}")

print("4. FIELD_ORDER")
reordered = ["date", "time", "sc-status", "cs-method"]  # status moved to 3rd
reorder_log = os.path.join(tmp, "reordered.log")
with open(reorder_log, "w", encoding="ascii") as fh:
    fh.write("#Fields: " + " ".join(reordered) + "\n")
    fh.write("2026-11-08 10:00:00 500 GET\n")
    fh.write("2026-11-08 10:00:01 200 GET\n")
t_re = ilt.totals([reorder_log])
pin("sc-status resolved by name, not position",
    t_re["requests"] == 2 and t_re["s5xx"] == 1 and t_re["s4xx"] == 0, f"totals={t_re}")

print()
if FAILURES:
    print(f"RED: {len(FAILURES)} pin(s) failed: {', '.join(FAILURES)}")
    sys.exit(1)
print("all pins green")
