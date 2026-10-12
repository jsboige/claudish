#!/usr/bin/env python3
"""Pins for extract_complete() -- the extraction-completeness guard.

Measured incident (2026-07-05, hub po-2025): a 7z run killed by a vanishing
archive device (G: DriveFS unmount) left comp-2026-07-05/ holding every
req-*.json and zero resp-*.sse. The old guard `os.path.isdir(d) and
os.listdir(d)` accepted that dir as a finished extraction, and the #445 B1
census printed an EMPTY table for a day whose archive holds 10,498
responses -- a silent undercount on a measurement instrument.

Pinned here, for BOTH carriers (compaction-trend.day_dir path and
minimax-chain-measure.extract_archives path -- the predicate must not drift
between the two copies):

  1. THE INCIDENT SHAPE -- req-only partial dir: False (the pin the old
     guard fails).
  2. empty dir: False;  missing dir: False.
  3. both member patterns, no marker (pre-marker dirs): True -- the fallback
     keeps existing complete extractions valid.
  4. marker only (a clean extraction whose target set was empty): True --
     the marker is the strong signal, written only after a clean exit.

Mutation proof (run before pushing; must turn pin 1 red): restore
`os.path.isdir(d) and os.listdir(d)` in either carrier -> req-only returns
True -> pin 1 red.

Run standalone (no pytest needed):
  python scripts/tests/test_extract_complete.py
Or under pytest:
  pytest scripts/tests/test_extract_complete.py
"""

import importlib.util
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CARRIERS = [
    ("compaction-trend", load("_ct", os.path.join(SCRIPTS, "compaction-trend.py"))),
    ("minimax-chain-measure",
     load("_mcm", os.path.join(SCRIPTS, "minimax-chain-measure.py"))),
]


def mk(root, name, files):
    d = os.path.join(root, name)
    os.makedirs(d, exist_ok=True)
    for f in files:
        open(os.path.join(d, f), "w").close()
    return d


def main():
    root = tempfile.mkdtemp(prefix="extract-complete-")
    cases = [
        ("req-only partial (2026-07-05 incident)",
         mk(root, "reqonly", ["req-1-1-2026-07-05T10-00-00-000Z-direct.json"]),
         False),
        ("empty", mk(root, "empty", []), False),
        ("missing", os.path.join(root, "absent"), False),
        ("both patterns, pre-marker",
         mk(root, "both", ["req-1-1-2026-07-05T10-00-00-000Z-direct.json",
                           "resp-1-r1-2026-07-05T10-00-01-000Z-openai-x.sse"]),
         True),
        ("marker only (clean exit, empty target set)",
         mk(root, "marked", [".extract-complete"]), True),
    ]
    fails = 0
    for label, path, want in cases:
        verdicts = [m.extract_complete(path) for _, m in CARRIERS]
        ok = all(v == want for v in verdicts)
        fails += 0 if ok else 1
        print("  %-40s %s %s" % (
            label, verdicts if len(set(verdicts)) > 1 else verdicts[0],
            "OK" if ok else "FAIL (want %s)" % want))
    if fails:
        print("FAILED: %d case(s)" % fails)
        return 1
    print("OK: %d cases x %d carriers" % (len(cases), len(CARRIERS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())