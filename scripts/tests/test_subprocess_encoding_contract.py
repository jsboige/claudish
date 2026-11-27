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
seat. It covers every file in this directory, including the ones CI runs but
the local chain never listed.

There is NO allowlist. The one this guard shipped with named four files whose
strict sites an unmerged PR was fixing; that PR merged on 27/11, and the
entries then hid a NEW strict site planted in one of those same files (measured
on the #1203 review: the guard printed EXEMPT and exited 0). A violation is a
failure, always -- and the failure branch has its own self-test, because a
guard that refuses nothing still passes on a clean tree.

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
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
_CALLS = {"run", "check_output", "check_call", "Popen"}


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


def verdict(path=HERE):
    """(returncode, [lines to print]) for the tree at `path`.

    Split from `main()` so the refusal can be exercised on a planted file
    without scanning the real tree twice.
    """
    scanned, found = scan_dir(path)
    lines = ["scanned %d files; %d carry a strict or locale-dependent read"
             % (scanned, len(found))]
    if not found:
        lines.append("OK -- every text-mode child read asks for UTF-8 text"
                     " with errors=")
        return 0, lines
    lines.append("FAIL -- text-mode child reads must pass encoding='utf-8',"
                 " errors='replace':")
    for name in sorted(found):
        sites = ", ".join(":%d(%s)" % (ln, "/".join(m)) for ln, m in found[name])
        lines.append("  " + name + sites)
    return 1, lines


def _failure_branch_self_test():
    """The refusal must fire on a planted file AND name it.

    Without this, the two mutants the #1203 review measured stay green: a
    guard whose failure branch always returns 0, and one that exempts
    everything, both pass on a clean tree. The pin is the planted file.
    """
    with tempfile.TemporaryDirectory() as root:
        planted = os.path.join(root, "planted_strict.py")
        with open(planted, "w", encoding="utf-8") as fh:
            fh.write(_POSITIVE)
        rc, lines = verdict(root)
        assert rc != 0, ("a planted strict read must fail the guard: %r"
                         % (lines,))
        assert any("planted_strict.py" in line for line in lines), (
            "the failure must NAME the planted file: %r" % (lines,))
        with open(planted, "w", encoding="utf-8") as fh:
            fh.write(_NEGATIVE)
        rc, lines = verdict(root)
        assert rc == 0, ("a tolerant read must pass: %r" % (lines,))


def main():
    _self_control()
    _failure_branch_self_test()
    rc, lines = verdict(HERE)
    for line in lines:
        print(line)
    return rc


def test_contract():
    assert main() == 0


def test_the_failure_branch_names_the_planted_file():
    _failure_branch_self_test()


if __name__ == "__main__":
    sys.exit(main())
