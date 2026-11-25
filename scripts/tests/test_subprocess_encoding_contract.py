#!/usr/bin/env python3
"""Static guard: every text-mode child read under scripts/tests asks for UTF-8.

#1186 / #1175 -- two failure signatures, neither of them visible on a UTF-8 CI
runner:

  * `text=True` with no `encoding=` decodes with the SEAT's locale. On a
    cp1252 Windows seat a UTF-8 child is mis-read (mojibake); the same call
    looks green in CI.
  * `encoding=` with no `errors=` is STRICT. A byte the codec cannot map
    raises inside subprocess' _readerthread; the call then returns
    `stdout=None` while `returncode == 0` -- the #1175 signature, which reads
    like a silent empty output, not like a crash.

The runtime half of the contract (a U+00C1 round-trip pin per file) proves the
child's bytes are pinned; this scan is the static half and it needs no Windows
seat. It covers every file in this directory, including the ones the
`test:scripts:py` chain never lists and the CI loop still runs.

Blind spots, written down rather than guessed at: a `text=`/`encoding=` passed
as a variable is not seen, and a call spreading `**kwargs` cannot be verified
-- it is skipped, never reported, because a false positive would push a lane to
weaken the scan.

Run standalone:
  python scripts/tests/test_subprocess_encoding_contract.py
Or under pytest:
  pytest scripts/tests/test_subprocess_encoding_contract.py
"""
import ast
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_CALLS = {"run", "check_output", "check_call", "Popen"}

# Strict sites fixed by the unmerged PR #1198. An entry must name an existing
# file. Once that PR merges the entry carries no violation any more and is
# printed as a NOTE, never a failure: an unrelated merge must not turn another
# lane's CI red.
PENDING_1198 = (
    "test_settings_matrix_canon_age.py",     # :121
    "test_settings_matrix_coverage.py",      # :109 :228 :241 :257
    "test_settings_matrix_credentials.py",   # :124
    "test_settings_matrix_permissions.py",   # :53
)


def _is_true(node):
    return isinstance(node, ast.Constant) and node.value is True


def scan_tree(tree):
    """[(lineno, missing)] for every text-mode subprocess call in one module.

    `missing == []` means the site is tolerant. Binary reads (no text mode) are
    out of scope and not returned.
    """
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr in _CALLS
                and isinstance(func.value, ast.Name)
                and func.value.id == "subprocess"):
            continue
        if any(kw.arg is None for kw in node.keywords):
            continue                      # **kwargs: unverifiable, never a hit
        kw = {k.arg: k.value for k in node.keywords}
        text_mode = ("encoding" in kw
                     or _is_true(kw.get("text"))
                     or _is_true(kw.get("universal_newlines")))
        if not text_mode:
            continue
        missing = [n for n in ("encoding", "errors") if n not in kw]
        out.append((node.lineno, missing))
    return out


def scan_dir(path=HERE):
    """(files scanned, {filename: [(lineno, missing)]} for the bad ones)."""
    scanned = 0
    found = {}
    for name in sorted(os.listdir(path)):
        if not name.endswith(".py"):
            continue
        scanned += 1
        with open(os.path.join(path, name), "rb") as fh:
            tree = ast.parse(fh.read(), filename=name)
        bad = [(ln, m) for ln, m in scan_tree(tree) if m]
        if bad:
            found[name] = bad
    return scanned, found


_POSITIVE = "import subprocess\nsubprocess.run(['x'], text=True)\n"
_NEGATIVE = ("import subprocess\n"
             "subprocess.run(['x'], text=True, encoding='utf-8', errors='replace')\n")
_UNVERIFIABLE = "import subprocess\nsubprocess.run(['x'], text=True, **opts)\n"


def _self_control():
    """The classifier must see a strict site, and must not invent one."""
    pos = scan_tree(ast.parse(_POSITIVE))
    assert len(pos) == 1 and pos[0][1] == ["encoding", "errors"], (
        "positive control missed a strict text-mode read: %r" % (pos,))
    neg = scan_tree(ast.parse(_NEGATIVE))
    assert len(neg) == 1 and neg[0][1] == [], (
        "tolerant read reported as a violation: %r" % (neg,))
    assert scan_tree(ast.parse(_UNVERIFIABLE)) == [], (
        "a **kwargs call must stay unverifiable")


def main():
    _self_control()
    scanned, found = scan_dir()
    print("scanned %d files; %d carry a strict or locale-dependent read"
          % (scanned, len(found)))
    failures = []
    for name in sorted(found):
        sites = ", ".join(":%d(%s)" % (ln, "/".join(m)) for ln, m in found[name])
        if name in PENDING_1198:
            print("EXEMPT (PR #1198 pending) %s%s" % (name, sites))
        else:
            failures.append("%s%s" % (name, sites))
    for name in PENDING_1198:
        if not os.path.isfile(os.path.join(HERE, name)):
            failures.append("%s (stale PENDING_1198 entry: no such file)" % name)
        elif name not in found:
            print("NOTE %s has no strict site left -- drop it from PENDING_1198"
                  % name)
    if failures:
        print("FAIL -- text-mode child reads must pass encoding='utf-8',"
              " errors='replace':")
        for item in failures:
            print("  " + item)
        return 1
    print("OK -- every text-mode child read asks for UTF-8 text with errors=")
    return 0


def test_contract():
    assert main() == 0


if __name__ == "__main__":
    sys.exit(main())
