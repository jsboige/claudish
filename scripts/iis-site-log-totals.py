#!/usr/bin/env python3
"""IIS W3C site-log totals, anchored on each file's own #Fields header.

Why anchored parsing (grain v50-5, 2026-11-08): the X-Claudish-Machine custom
field added to site 49 on 2026-11-07 20:25Z rolled every log file since to the
extended shape (suffix `_x`, one extra TRAILING column). Tail-anchored parsing
(p[-6] for sc-status) silently misreads those files; fixed start offsets break
the same way on user agents containing spaces. The only stable contract is the
file's own `#Fields:` line: map names to indices per file, skip any line whose
token count disagrees with its header.

Usage:
    python scripts/iis-site-log-totals.py <file.log> [more.log ...]

Outputs requests / 4xx / 5xx totals plus a per-machine table from the
X-Claudish-Machine column when the file carries it ("-" counts as no header).
"""
import sys
from collections import Counter

CUSTOM_MACHINE_FIELD = "X-Claudish-Machine"


def iter_w3c(path):
    """Yield {fieldName: value} dicts, anchored on the file's own #Fields line."""
    fields = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("#Fields:"):
                fields = line[len("#Fields:"):].split()
            elif line.startswith("#"):
                continue
            elif fields is None:
                continue
            else:
                parts = line.split()
                if len(parts) != len(fields):
                    continue  # token/field mismatch: skip, never misread
                yield dict(zip(fields, parts))


def totals(paths):
    """Aggregate one or more W3C files. Returns a plain dict."""
    req = s4 = s5 = 0
    machines = Counter()
    machine_fail = Counter()
    for path in paths:
        for row in iter_w3c(path):
            req += 1
            status = row.get("sc-status", "")
            m = row.get(CUSTOM_MACHINE_FIELD, "-") or "-"
            machines[m] += 1
            if status >= "500":
                s5 += 1
                machine_fail[m] += 1
            elif status >= "400":
                s4 += 1
    return {"requests": req, "s4xx": s4, "s5xx": s5,
            "machines": dict(machines), "machine_fail": dict(machine_fail)}


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    t = totals(argv[1:])
    print(f"requests={t['requests']} 4xx={t['s4xx']} 5xx={t['s5xx']}")
    for m, n in sorted(t["machines"].items(), key=lambda kv: -kv[1]):
        rate = 100 * t["machine_fail"].get(m, 0) / max(n, 1)
        print(f"{m:24s} {n:8d} {t['machine_fail'].get(m, 0):6d} {rate:6.2f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
