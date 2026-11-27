#!/usr/bin/env python3
r"""Run every scripts/tests/test_*.py file by its own runner: the local twin of CI.

CI walks the directory (`.github/workflows/test.yml`, step "every file by its
own runner": `for f in scripts/tests/test_*.py`). The local gate did not: it
was a hand-kept `&&` chain of `python <file>` in package.json, and a file
nobody added to it was red in CI only.

Measured 27/11 on main 772f9274: 56 test files, 40 in the chain, 16 missing.
The 16 were not one forgotten batch: their first-commit dates run from 10-07
to 11-22, in four bursts, each of which left part of itself behind. A list
that is right only until the next file is not a list worth keeping, so the
gate now discovers the files the way CI does.

Differences from the CI step, on purpose: this runner does not stop at the
first red file (a local pass is more useful naming every red file at once),
and it prints a count line a human can compare against `ls`.

Each file runs as its own process, with the interpreter running this runner,
from the repository root: the same three things the chain and CI give it.

    python scripts/tests/run-py-tests.py           # run every file
    python scripts/tests/run-py-tests.py --list    # print them, run nothing
"""

import glob
import os
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))

# The discovery pattern. CI's step spells it `scripts/tests/test_*.py`;
# test_py_gate_runner.py pins the two against each other.
PATTERN = "test_*.py"


def discover(directory):
    """Sorted paths of the test files under `directory` (not below it)."""
    return sorted(
        p for p in glob.glob(os.path.join(directory, PATTERN)) if os.path.isfile(p)
    )


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    directory = _HERE
    list_only = False
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--list":
            list_only = True
        elif arg == "--dir":
            i += 1
            if i >= len(argv):
                print("--dir needs a path", file=sys.stderr)
                return 2
            directory = argv[i]
        elif arg.startswith("--dir="):
            directory = arg[len("--dir="):]
        else:
            print("unknown argument: %s" % arg, file=sys.stderr)
            return 2
        i += 1

    directory = os.path.abspath(directory)
    if not os.path.isdir(directory):
        print("not a directory: %s" % directory, file=sys.stderr)
        return 2

    files = discover(directory)
    if list_only:
        for path in files:
            print(os.path.basename(path))
        return 0

    if not files:
        # An empty run is not a green run: it means the pattern or the
        # directory stopped matching, which is how a gate dies quietly.
        print("no %s file under %s" % (PATTERN, directory), file=sys.stderr)
        return 2

    failed = []
    for n, path in enumerate(files, 1):
        name = os.path.basename(path)
        print("== [%d/%d] %s" % (n, len(files), name), flush=True)
        try:
            rc = subprocess.call([sys.executable or "python", path], cwd=_ROOT)
        except KeyboardInterrupt:
            print("interrupted at %s" % name, file=sys.stderr)
            return 130
        if rc != 0:
            failed.append((name, rc))

    print("== %d file(s): %d ok, %d failed" % (len(files), len(files) - len(failed), len(failed)), flush=True)
    for name, rc in failed:
        print("   FAILED %s (exit %d)" % (name, rc))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
