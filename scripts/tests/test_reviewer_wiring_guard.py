#!/usr/bin/env python3
r"""The reviewer workflow's guard step, replayed (#1099, #1100).

`.github/workflows/claude-code.yml` carries one guard: the step "Check the hub
wiring is present". It runs before a reviewer that holds a key, and its whole
job is to fail on a NAMED cause instead of an opaque 401. Until 24/11 nobody
had run it against a missing piece: its outcomes were asserted from reading,
and one reading was wrong. The audit of 18/11 (c.6973958411, defect 1) said
the test `^x-proxy-key: [^[:space:]]` "sees only the first line" of a header
block that begins with `X-Claudish-Machine:`, so the guard would fail with
the key present. It does not: grep reads line by line and `^` matches the
start of EVERY line, and run 43856612333 (16/11, head ea4ab940) had already
passed that step with the key present. Measured here rather than argued --
`--git-ref a5b0ea10` replays the step as it stood before this file existed.

What is left of that audit is its second point, and it is real: the step's
comment and error message claimed more than the step checks. A green guard
proves the FORM of the header block -- nothing about the key itself.

How this replays, with no CI run, no secret and no `gh secret`:

  * the step's `run:` block and the two `env:` values it reads are READ from
    the workflow file (the tree's, or `--git-ref <sha>` / `--workflow`);
  * `${{ secrets.CLAUDISH_REVIEWER_KEY }}` is substituted the way Actions does
    it for a missing secret -- the empty string -- and otherwise by a DUMMY;
  * the block runs under `bash -e <file>`, the shell Actions uses for a `run:`
    that declares no `shell:`, in a curated environment that carries none of
    the seat's own ANTHROPIC_* variables;
  * a verdict is the exit code plus what the step printed: the cause must be
    named, and the dummy value must appear NOWHERE in the output.

No PyYAML on purpose: CI's scripts-tests job installs pytest and py7zr only
(same choice as test_workflow_timeouts.py). The reader below handles a block
scalar and ONE double-quoted scalar, and refuses what it does not know rather
than guessing; where a YAML parser is importable it is cross-checked against
one.

Run: python scripts/tests/test_reviewer_wiring_guard.py
     python scripts/tests/test_reviewer_wiring_guard.py --git-ref a5b0ea10   (table only)
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
_WORKFLOW_REL = os.path.join(".github", "workflows", "claude-code.yml")

STEP_NAME = "Check the hub wiring is present"
KEY_EXPR = "${{ secrets.CLAUDISH_REVIEWER_KEY }}"
URL_EXPR = "${{ vars.CLAUDISH_HUB_URL }}"
KEY_CAUSE = "CLAUDISH_REVIEWER_KEY"
URL_CAUSE = "CLAUDISH_HUB_URL"
# Not a key: a marker whose only job is to be recognisable if the step prints it.
DUMMY_KEY = "DUMMY-reviewer-key-0b7c1e3f5a"
DUMMY_URL = "https://hub.example.invalid"
AS_IN_FILE = object()  # "the URL as the workflow file defines it"

_CASE_FULL = "full header"
_CASE_NO_LINE = "x-proxy-key line absent"
_CASE_EMPTY = "x-proxy-key value empty (secret missing)"
_CASE_BLANK = "x-proxy-key value blank"
_CASE_INSIDE = "x-proxy-key text inside another line"
_CASE_FIRST = "x-proxy-key line first"
_CASE_NO_URL = "hub URL empty (variable missing)"
_CASE_KEY_ONLY = "machine line absent, key line kept"


class InstrumentError(Exception):
    """The READER could not read the workflow as written. Never a verdict on
    the guard: the replay exits 2 and names what it did not understand."""


# ---------------------------------------------------------------------------
# Reading the workflow: by position, nothing retyped
# ---------------------------------------------------------------------------

def _mapping_block(lines, head):
    """(start, end) of the top-level mapping that begins at the column-0 line
    `head`: what follows while it is blank, a comment or indented."""
    starts = [i for i, line in enumerate(lines) if line == head]
    if len(starts) != 1:
        raise InstrumentError("%d `%s` lines at column 0 (expected 1)" % (len(starts), head))
    start = starts[0]
    end = start + 1
    while end < len(lines) and (not lines[end].strip() or lines[end][0] in " \t#"):
        end += 1
    return start, end


def _entry(block, key):
    """The scalar written after `key:` in a mapping body, or None."""
    hits = []
    for line in block:
        if line.lstrip().startswith("#"):
            continue
        match = re.match(r"^ +%s: ?(.*)$" % re.escape(key), line)
        if match:
            hits.append(match.group(1))
    if len(hits) > 1:
        raise InstrumentError("`%s` is set %d times in the block" % (key, len(hits)))
    return hits[0] if hits else None


_ESCAPES = {
    "n": "\n", "t": "\t", "r": "\r", "0": "\0", "a": "\a", "b": "\b",
    "v": "\v", "f": "\f", "e": "\x1b", '"': '"', "/": "/", "\\": "\\",
}


def _double_quoted(value):
    """Decode ONE single-line double-quoted YAML scalar. Refuses every escape
    it does not know instead of passing it through as text."""
    if not value.startswith('"'):
        raise InstrumentError("ANTHROPIC_CUSTOM_HEADERS is not a double-quoted scalar")
    out, i, escaped = [], 1, False
    while i < len(value):
        ch = value[i]
        if escaped:
            if ch in _ESCAPES:
                out.append(_ESCAPES[ch])
            elif ch in "xuU":
                width = {"x": 2, "u": 4, "U": 8}[ch]
                digits = value[i + 1:i + 1 + width]
                if len(digits) != width or not all(c in "0123456789abcdefABCDEF" for c in digits):
                    raise InstrumentError("bad \\%s escape in the header block" % ch)
                out.append(chr(int(digits, 16)))
                i += width
            else:
                raise InstrumentError("this reader does not decode the escape \\%s" % ch)
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == '"':
            rest = value[i + 1:].strip()
            if rest and not rest.startswith("#"):
                raise InstrumentError("text after the closing quote of the header block")
            return "".join(out)
        else:
            out.append(ch)
        i += 1
    raise InstrumentError("the header block's opening quote is never closed")


def _step_run(lines, name):
    """The `run:` block scalar of the step called `name`, as Actions reads it."""
    starts = [
        i for i, line in enumerate(lines)
        if re.match(r"^ *- name: %s$" % re.escape(name), line)
    ]
    if len(starts) != 1:
        raise InstrumentError("%d steps named %r (expected 1)" % (len(starts), name))
    start = starts[0]
    step_indent = len(lines[start]) - len(lines[start].lstrip())
    key_indent = step_indent + 2
    end = start + 1
    while end < len(lines):
        line = lines[end]
        if line.strip() and len(line) - len(line.lstrip()) <= step_indent:
            break
        end += 1
    step = lines[start + 1:end]
    run_at = [
        i for i, line in enumerate(step)
        if re.match(r"^ {%d}run: ?[|>][+-]?( .*)?$" % key_indent, line)
    ]
    if len(run_at) != 1:
        raise InstrumentError("the step's `run:` is not one block scalar")
    style = re.match(r"^ {%d}run: ?([|>])" % key_indent, step[run_at[0]]).group(1)
    if style != "|":
        raise InstrumentError("this reader reads literal (`|`) blocks only, found `%s`" % style)
    body = step[run_at[0] + 1:]
    while body and not body[-1].strip():
        body.pop()
    content = [line for line in body if line.strip()]
    if not content:
        raise InstrumentError("the step's `run:` block is empty")
    indent = min(len(line) - len(line.lstrip()) for line in content)
    if indent <= key_indent:
        raise InstrumentError("the step's `run:` block is not indented under its key")
    return "\n".join(line[indent:] for line in body) + "\n"


def read_workflow(text):
    """{header, url, run}: what Actions would hand the guard step."""
    lines = text.replace("\r\n", "\n").split("\n")
    for line in lines:
        if not line.lstrip().startswith("#") and re.match(r"^ *(shell|defaults):", line):
            raise InstrumentError(
                "the workflow declares `shell:` or `defaults:`: this replay knows "
                "Actions' default shell for `run:` (bash -e) only"
            )
    env_start, env_end = _mapping_block(lines, "env:")
    url = _entry(lines[env_start + 1:env_end], "ANTHROPIC_BASE_URL")
    raw = _entry(lines[env_start + 1:env_end], "ANTHROPIC_CUSTOM_HEADERS")
    if url is None or raw is None:
        raise InstrumentError("the workflow-level `env:` carries no ANTHROPIC_BASE_URL / ANTHROPIC_CUSTOM_HEADERS")
    below = lines[:env_start] + lines[env_end:]
    for line in below:
        if not line.lstrip().startswith("#") and re.match(r"^ +ANTHROPIC_(CUSTOM_HEADERS|BASE_URL):", line):
            raise InstrumentError(
                "ANTHROPIC_BASE_URL / ANTHROPIC_CUSTOM_HEADERS are also set outside the "
                "workflow-level `env:`: this reader does not merge job- and step-level overrides"
            )
    header = _double_quoted(raw)
    if header.count(KEY_EXPR) != 1:
        raise InstrumentError(
            "the header block carries %d `%s` (expected 1): the cases cannot be derived"
            % (header.count(KEY_EXPR), KEY_EXPR)
        )
    return {"header": header, "url": url, "run": _step_run(lines, STEP_NAME)}


# ---------------------------------------------------------------------------
# Running the step: Actions' default shell, a curated environment
# ---------------------------------------------------------------------------

def find_bash():
    """The bash that replays the step. On Windows that is Git for Windows';
    `System32\\bash.exe` is the WSL launcher and is skipped on sight."""
    override = os.environ.get("REVIEWER_GUARD_BASH")
    if override:
        return override
    found = shutil.which("bash")
    if os.name != "nt":
        if not found:
            raise InstrumentError("no `bash` on PATH: the step cannot be replayed")
        return found
    candidates = []
    for root in (os.environ.get("ProgramFiles", r"C:\Program Files"),
                 os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
                 os.environ.get("LocalAppData", "")):
        if root:
            candidates.append(os.path.join(root, "Git", "bin", "bash.exe"))
            candidates.append(os.path.join(root, "Programs", "Git", "bin", "bash.exe"))
    git = shutil.which("git")
    if git:
        exec_path = subprocess.run(
            [git, "--exec-path"], capture_output=True, text=True, timeout=30
        ).stdout.strip()
        for _ in range(5):
            if exec_path:
                candidates.append(os.path.join(exec_path, "bin", "bash.exe"))
                exec_path = os.path.dirname(exec_path)
    for candidate in candidates + [found or ""]:
        if candidate and os.path.isfile(candidate) and "system32" not in candidate.lower():
            return candidate
    raise InstrumentError(
        "no bash to replay the step with: Git for Windows' bin\\bash.exe was not "
        "found (set REVIEWER_GUARD_BASH to point at one)"
    )


_PASS_THROUGH = (
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
    "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA",
    "PROGRAMDATA", "PROGRAMFILES", "SYSTEMDRIVE", "OS", "NUMBER_OF_PROCESSORS",
    "LANG", "LC_ALL", "LC_CTYPE", "TERM",
)


def child_env(url, header):
    """The step's environment: the OS, and the two variables it reads. The
    seat's own ANTHROPIC_* variables never reach the child."""
    env = {name: os.environ[name] for name in _PASS_THROUGH if name in os.environ}
    env["ANTHROPIC_BASE_URL"] = url
    env["ANTHROPIC_CUSTOM_HEADERS"] = header
    return env


def run_step(script, bash, url, header):
    """(exit code, everything the step printed) for one input."""
    with tempfile.TemporaryDirectory(prefix="reviewer-guard-") as tmp:
        path = os.path.join(tmp, "script.sh")
        with open(path, "wb") as handle:
            handle.write(script.encode("utf-8"))
        if os.name == "nt":
            drive, rest = os.path.splitdrive(path)
            argv_path = "/%s%s" % (drive.rstrip(":").lower(), rest.replace("\\", "/"))
        else:
            argv_path = path
        try:
            proc = subprocess.run(
                [bash, "-e", argv_path], cwd=tmp, env=child_env(url, header),
                input=b"", capture_output=True, timeout=60,
            )
        except OSError as exc:
            raise InstrumentError("bash could not be started: %s" % exc)
        return proc.returncode, (proc.stdout + proc.stderr).decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# The inputs, the verdict, the table
# ---------------------------------------------------------------------------

class Case(object):
    def __init__(self, name, header, url, passes, cause):
        self.name, self.header, self.url = name, header, url
        self.passes, self.cause = passes, cause


class Row(object):
    def __init__(self, name, rc, cause, printed, problems):
        self.name, self.rc, self.cause = name, rc, cause
        self.printed, self.problems = printed, problems

    @property
    def good(self):
        return not self.problems


def cases(header):
    """Every input DERIVED from the header the file defines, never retyped."""
    lines = header.split("\n")
    key_at = [i for i, line in enumerate(lines) if line.lower().startswith("x-proxy-key:")]
    if len(key_at) != 1:
        raise InstrumentError(
            "the header block carries %d `x-proxy-key:` lines (expected 1)" % len(key_at)
        )
    key_line = lines[key_at[0]]
    rest = lines[:key_at[0]] + lines[key_at[0] + 1:]
    built = [
        Case(_CASE_FULL, header, AS_IN_FILE, True, None),
        Case(_CASE_NO_LINE, "\n".join(rest), AS_IN_FILE, False, KEY_CAUSE),
        Case(_CASE_EMPTY, header.replace(KEY_EXPR, ""), AS_IN_FILE, False, KEY_CAUSE),
        Case(_CASE_BLANK, header.replace(KEY_EXPR, "   "), AS_IN_FILE, False, KEY_CAUSE),
        Case(_CASE_FIRST, "\n".join([key_line] + rest), AS_IN_FILE, True, None),
        Case(_CASE_NO_URL, header, "", False, URL_CAUSE),
        Case(_CASE_KEY_ONLY, key_line, AS_IN_FILE, True, None),
    ]
    if rest:
        built.insert(4, Case(
            _CASE_INSIDE,
            "\n".join(rest[:-1] + [rest[-1] + " x-proxy-key: " + DUMMY_KEY]),
            AS_IN_FILE, False, KEY_CAUSE,
        ))
    return built


def judge(case, rc, out):
    problems = []
    if case.passes:
        if rc != 0:
            problems.append("exit %d, expected 0" % rc)
    else:
        if rc == 0:
            problems.append("exit 0, expected a failure")
        if "::error::" not in out:
            problems.append("no ::error:: line")
        if case.cause not in out:
            problems.append("cause %s not named" % case.cause)
    if DUMMY_KEY in out:
        problems.append("the key value is PRINTED")
    named = [c for c in (URL_CAUSE, KEY_CAUSE) if c in out]
    return Row(case.name, rc, ",".join(named) or "-", DUMMY_KEY in out, problems)


def replay(text, bash=None):
    """One Row per input, for the workflow `text` as written."""
    workflow = read_workflow(text)
    bash = bash or find_bash()
    rows = []
    for case in cases(workflow["header"]):
        header = case.header.replace(KEY_EXPR, DUMMY_KEY)
        url = (workflow["url"].replace(URL_EXPR, DUMMY_URL)
               if case.url is AS_IN_FILE else case.url)
        rc, out = run_step(workflow["run"], bash, url, header)
        rows.append(judge(case, rc, out))
    return rows


def render(rows, title):
    width = max(len(row.name) for row in rows)
    out = [
        "REPLAY  %s  --  step %r  --  shell: bash -e  --  key = a dummy" % (title, STEP_NAME),
        "%-*s  rc  verdict  cause named            value printed" % (width, "input"),
    ]
    for row in rows:
        out.append("%-*s  %2d  %-7s  %-22s  %s" % (
            width, row.name, row.rc, "ok" if row.good else "RED", row.cause,
            "YES" if row.printed else "no",
        ))
    red = [row for row in rows if not row.good]
    tail = "%d/%d as expected" % (len(rows) - len(red), len(rows))
    if red:
        tail += " -- RED: " + "; ".join("%s (%s)" % (r.name, "; ".join(r.problems)) for r in red)
    out.append(tail)
    return "\n".join(out)


def default_text():
    with open(os.path.join(_ROOT, _WORKFLOW_REL), encoding="utf-8") as handle:
        return handle.read()


_TABLE = None


def table():
    """The replay of the workflow in the tree, computed once."""
    global _TABLE
    if _TABLE is None:
        _TABLE = replay(default_text())
    return _TABLE


def _row(name):
    for row in table():
        if row.name == name:
            return row
    raise AssertionError("case %r was not built: the header block no longer has that shape" % name)


# ---------------------------------------------------------------------------
# The pins: one acceptance each, all measured on the same replay
# ---------------------------------------------------------------------------

def test_the_header_block_is_multi_line_with_the_machine_line_first():
    """The premise of the whole file: the `\\n` in the env block is a real
    line feed, so the key line is NOT the first line."""
    workflow = read_workflow(default_text())
    assert workflow["header"].split("\n") == [
        "X-Claudish-Machine: myia-gh-actions", "x-proxy-key: " + KEY_EXPR,
    ], repr(workflow["header"])
    assert workflow["url"] == URL_EXPR, repr(workflow["url"])


def test_the_step_is_read_from_the_workflow_not_retyped():
    """Anti-vacuity: the block under test is the file's own text."""
    workflow = read_workflow(default_text())
    assert "grep -qE" in workflow["run"], workflow["run"]
    assert '"$ANTHROPIC_CUSTOM_HEADERS"' in workflow["run"], workflow["run"]


def test_full_header_passes_and_prints_nothing_of_the_key():
    row = _row(_CASE_FULL)
    assert row.good, row.problems
    assert not row.printed


def test_a_missing_x_proxy_key_line_fails_naming_the_secret():
    row = _row(_CASE_NO_LINE)
    assert row.good, row.problems


def test_an_empty_x_proxy_key_value_fails_naming_the_secret():
    """The shape Actions produces when the repository secret does not exist."""
    row = _row(_CASE_EMPTY)
    assert row.good, row.problems


def test_a_blank_x_proxy_key_value_fails_naming_the_secret():
    row = _row(_CASE_BLANK)
    assert row.good, row.problems


def test_the_key_text_inside_another_line_is_not_a_key_line():
    row = _row(_CASE_INSIDE)
    assert row.good, row.problems


def test_the_test_holds_wherever_the_line_sits():
    """The property the 18/11 audit got wrong: the key line is seen wherever
    it sits in the block, first line or second."""
    for name in (_CASE_FULL, _CASE_FIRST):
        row = _row(name)
        assert row.good, (name, row.problems)


def test_a_missing_hub_url_fails_naming_the_variable():
    row = _row(_CASE_NO_URL)
    assert row.good, row.problems


def test_the_guard_reads_the_key_line_only():
    """What the guard does NOT guard: the `X-Claudish-Machine` line (hub-side
    attribution) can vanish without this step noticing. Pinned so that adding
    that check is a deliberate change of this pin, not an accident."""
    row = _row(_CASE_KEY_ONLY)
    assert row.good, row.problems


# Each mutant: (what it breaks, exact text, replacement, rows that must go RED).
# A mutant that broke EVERYTHING would pass a loose check, so the RED set is
# compared exactly: these rows and no others.
_MUTANTS = [
    (
        "whole-input anchor -- the reading the 18/11 audit gave grep's `^`",
        "grep -qE '^x-proxy-key: [^[:space:]]'",
        "grep -qzE '^x-proxy-key: [^[:space:]]'",
        {_CASE_FULL},
    ),
    (
        "an empty value accepted",
        "'^x-proxy-key: [^[:space:]]'",
        "'^x-proxy-key: '",
        {_CASE_EMPTY, _CASE_BLANK},
    ),
    (
        "line anchor dropped",
        "'^x-proxy-key: [^[:space:]]'",
        "'x-proxy-key: [^[:space:]]'",
        {_CASE_INSIDE},
    ),
    (
        "URL guard removed",
        'if [ -z "$ANTHROPIC_BASE_URL" ]; then',
        "if false; then",
        {_CASE_NO_URL},
    ),
    (
        "the step prints the header it was given -- the `value printed` column "
        "must be able to go red",
        "CLAUDISH_REVIEWER_KEY is empty or missing\"",
        "CLAUDISH_REVIEWER_KEY is empty or missing [$ANTHROPIC_CUSTOM_HEADERS]\"",
        {_CASE_INSIDE},
    ),
]


def _mutate(text, old, new):
    """An exact replacement that PROVES it applied: exactly one occurrence,
    or the mutation did not happen and the green that follows means nothing."""
    count = text.count(old)
    assert count == 1, "mutation target found %d times (expected 1): %r" % (count, old)
    return text.replace(old, new)


def test_the_replay_goes_red_on_each_broken_guard():
    text = default_text()
    for what, old, new, expected_red in _MUTANTS:
        rows = replay(_mutate(text, old, new))
        red = {row.name for row in rows if not row.good}
        assert red == expected_red, "%s: red rows %s, expected %s" % (what, sorted(red), sorted(expected_red))


def test_where_a_yaml_parser_is_importable_the_reader_agrees_with_it():
    """A second opinion on the reader, only where one exists. CI installs no
    PyYAML by design (the replay above ran without it); a seat that has one
    must not carry a reader that drifted from real YAML."""
    try:
        import yaml
    except ImportError:
        raise unittest.SkipTest("PyYAML is not importable here (CI installs pytest and py7zr only)")
    text = default_text()
    document = yaml.safe_load(text)
    workflow = read_workflow(text)
    assert document["env"]["ANTHROPIC_CUSTOM_HEADERS"] == workflow["header"]
    assert document["env"]["ANTHROPIC_BASE_URL"] == workflow["url"]
    steps = [
        step for job in document["jobs"].values()
        for step in job.get("steps", []) if step.get("name") == STEP_NAME
    ]
    assert len(steps) == 1, len(steps)
    assert steps[0]["run"] == workflow["run"]
    assert "shell" not in steps[0]


if __name__ == "__main__":
    import argparse

    _parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    _parser.add_argument("--git-ref", help="replay the workflow as of this git ref (table only)")
    _parser.add_argument("--workflow", help="replay this workflow file instead (table only)")
    _args = _parser.parse_args()
    if _args.git_ref or _args.workflow:
        try:
            if _args.workflow:
                with open(_args.workflow, encoding="utf-8") as _handle:
                    _text = _handle.read()
                _title = _args.workflow
            else:
                _text = subprocess.run(
                    ["git", "-C", _ROOT, "show", "%s:%s" % (_args.git_ref, _WORKFLOW_REL.replace(os.sep, "/"))],
                    capture_output=True, check=True, timeout=60,
                ).stdout.decode("utf-8")
                _title = "%s @ %s" % (_WORKFLOW_REL.replace(os.sep, "/"), _args.git_ref)
            _rows = replay(_text)
        except InstrumentError as _exc:
            print("INSTRUMENT: %s" % _exc)
            sys.exit(2)
        print(render(_rows, _title))
        sys.exit(0 if all(_row.good for _row in _rows) else 1)

    try:
        print(render(table(), "%s @ HEAD" % _WORKFLOW_REL.replace(os.sep, "/")))
    except InstrumentError as _exc:
        print("INSTRUMENT: %s" % _exc)
        sys.exit(2)
    _passed = failures = 0
    for _name, _fn in sorted(globals().items()):
        if _name.startswith("test_") and callable(_fn):
            try:
                _fn()
                _passed += 1
                print("PASS %s" % _name)
            except unittest.SkipTest as _exc:
                print("SKIP %s: %s" % (_name, _exc))
            except AssertionError as _exc:
                failures += 1
                print("FAIL %s: %s" % (_name, _exc))
            except Exception as _exc:  # a crash is a failure, never a skip
                failures += 1
                print("ERROR %s: %r" % (_name, _exc))
    print("--- %d passed, %d failed" % (_passed, failures))
    sys.exit(1 if failures else 0)
