#!/usr/bin/env python3
r"""Pins for lib/cwd_lane.py — the ONE cwd-preamble parser (#1055 item 2).

Extracted verbatim from capture-workspace-attribution.py (whose own pins,
29 at last count, now exercise it through the consumer). These pins defend
the predicate at the source, because two consumers now read it:

  1. PREVIOUS-DIRECTORY SUFFIX — `d:\\dev\\CoursIA (was c:\\dev\\CoursIA)`
     yields `coursia`, never `coursia)`. Measured 14/09: 38 of 300 sampled
     bodies split in two without this.
  2. BACKSLASH BEFORE THE ESCAPED NEWLINE — `\\` is a literal separator and
     `\n` the JSON newline; unescaping in the wrong order cuts `d:\\dev\\new`
     to `d:` (the first run's `d:` bucket).
  3. LAST MARKER WINS — a body quoting an older preamble (tool_result,
     compaction summary) must not have its own directory overwritten.
  4. MARKER INSIDE QUOTED CODE — a script discussing this very string is
     not a directory: the visible bucket is `(unparsed)`, never a workspace
     minted from a source fragment.
  5. BASENAME ONLY, LOWERCASE — the coordinator's arbitration (15/11): a
     path is private, a name is an axis. `D:\\Dev\\Claudish\\` -> `claudish`.
  6. NO MARKER IS NONE, NOT A GUESS — only the caller knows its non-CC
     bucket (signatures stay in the canonical instrument).
  7. BYTES AND STR — the canonical instrument reads files as bytes, the
     blind_spot pool returns decoded str: both must find the same line.
  8. A LEAF THAT ENDS IN `)` KEEPS IT — only `(was …)` / `(previously …)`
     groups are removed; the strip must not degenerate into trailing-
     punctuation removal.

Run: python scripts/tests/test_cwd_lane.py
"""

import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "cwd_lane", os.path.join(_HERE, "..", "lib", "cwd_lane.py"))
cl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cl)

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append((name, ok, detail))
    if not ok:
        print(f"FAIL {name}: {detail}")


# 1. previous-directory suffix
key, cc = cl.lane_key(b"Primary working directory: d:\\\\dev\\\\CoursIA (was c:\\\\dev\\\\CoursIA)")
check("previous suffix dropped", (key, cc) == ("coursia", True), f"got {(key, cc)!r}")
key, _ = cl.lane_key(b"Primary working directory: c:\\\\dev\\\\CoursIA-2 (previously d:\\\\CoursIA-2)")
check("previously variant", key == "coursia-2", f"got {key!r}")

# 2. backslash before the escaped newline
key, _ = cl.lane_key(b"Primary working directory: d:\\\\dev\\\\new\\nnext line")
check("escaped separator survives", key == "new", f"got {key!r}")

# 3. last marker wins
key, _ = cl.lane_key(b"quote: Primary working directory: c:\\\\old\\\\place\\n"
                     b"Primary working directory: d:\\\\dev\\\\CoursIA")
check("last marker wins", key == "coursia", f"got {key!r}")

# 4. marker inside quoted code is not a directory
key, cc = cl.lane_key(b"regex = re.compile(rb\"Primary working directory: n]+)') {\")")
check("quoted code -> (unparsed)", (key, cc) == (cl.UNPARSED, True), f"got {(key, cc)!r}")

# 5. basename only, lowercase, trailing separator
key, _ = cl.lane_key(b"Primary working directory: D:\\\\Dev\\\\Claudish\\\\")
check("basename lowercased", key == "claudish", f"got {key!r}")
# a bare drive: the unescape + rstrip leaves `D:` with no separator, and
# the ABSOLUTE guard refuses it — a marker hit that is not a directory
# reads (unparsed), the same visible bucket as quoted code (canonical
# semantics, kept verbatim). ROOT is the POSIX "/" only.
check("bare drive -> (unparsed)",
      cl.lane_key(b"Primary working directory: D:\\\\")[0] == cl.UNPARSED, "")
check("posix root", cl.lane_key(b"Primary working directory: /")[0] == cl.ROOT, "")

# 6. no marker is None
key, cc = cl.lane_key(b'{"model":"gpt-6.1-sol","messages":[]}')
check("no marker -> (None, False)", (key, cc) == (None, False), f"got {(key, cc)!r}")

# 7. bytes and str agree
body = b"Primary working directory: d:\\\\dev\\\\stage-2 (bis)"
check("str and bytes agree",
      cl.lane_key(body) == cl.lane_key(body.decode("utf-8")) == ("stage-2 (bis)", True),
      f"{cl.lane_key(body)!r} vs {cl.lane_key(body.decode('utf-8'))!r}")

# 8. a real leaf ending in ')' keeps it
key, _ = cl.lane_key(b"Primary working directory: d:\\\\dev\\\\stage-2 (bis)")
check("legitimate ')' kept", key == "stage-2 (bis)", f"got {key!r}")

if __name__ == "__main__":
    bad = [c for c in CHECKS if not c[1]]
    for name, ok, detail in CHECKS:
        if ok:
            print(f"ok  {name}")
    print(f"{len(CHECKS) - len(bad)}/{len(CHECKS)} pins pass")
    raise SystemExit(1 if bad else 0)
