#!/usr/bin/env python3
"""Pins for the time bounds of three instruments: understood, or the run refuses.

One defect class, three instruments, each measured on 2026-11-27 before the
fix. The fixtures here are SYNTHETIC and shape-faithful; no capture was read.

  1. minimax-chain-measure.parse_iso read a bound WITHOUT an offset in the
     host's local zone (`.astimezone()` on a naive datetime presumes the system
     zone): `2026-11-26T00:00Z` -> 00:00Z but `2026-11-26T00:00` -> 23:00Z on a
     Europe/Paris seat, and both -> 00:00Z on a UTC seat. The window moved with
     the machine, silently, and the extraction marker recorded the shifted
     window as its own completeness identity. An offset-less bound is UTC (the
     fleet convention: native-consumption.py, swarm-signal.py).
  2. prompt-size-dist dropped a bound it could not read (`--since 2026-10-26`,
     date only -> None): the run went UNBOUNDED and answered on the whole
     corpus under the caller's window (4 of 4 selected where 3 were asked).
  3. harness-injection-measure compared its bound as a raw string against the
     capture's DASH-form stamp: an ISO bound (`...T09:00`) sorted a capture of
     `09-30` BEFORE it (`-` 0x2D < `:` 0x3A), so the bound's whole hour of
     captures vanished (before_since("...T09-30-00-203Z", "...T09:00") -> True).

Every accepted spelling is pinned for each instrument, with and without the Z
and with an explicit fraction. That is the lesson of #1211 / #1207: pins
written in ONE spelling let the other spell wrongly behind 55 green pins.

The zone pin runs the parser in CHILD processes under different TZ values and
carries its own positive control: the known-buggy reading must shift in at
least one child, otherwise the pin prints a SKIP line -- it never passes as a
proof on a host where every child ran in UTC. On Windows the C runtime reads
an IANA name it does not know (`Europe/Paris` included) as UTC, so there the
control rests on the TZ-less child, which runs in the host's own zone.

Mutation proofs, run before pushing, each red on the VALUE it protects and the
file restored byte-identical (sha256) after each:
  old parse_iso (unconditional astimezone)  -> 2 functions, `23:00Z`
  prompt-size bounds wired back to norm_ts  -> 1, `4 | window: - .. (now]`
  the sub-minute stderr note removed        -> 2
  a refusal made a silent None, both files  -> 2 and 1
  before_since back to the raw compare      -> 1

Run standalone:  python scripts/tests/test_time_bounds.py
Or under pytest: pytest scripts/tests/test_time_bounds.py
"""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS = os.path.dirname(_HERE)


def _load(name):
    key = "_time_bounds_" + name.replace("-", "_")
    spec = importlib.util.spec_from_file_location(key, os.path.join(_SCRIPTS, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[key] = mod
    spec.loader.exec_module(mod)
    return mod


mcm = _load("minimax-chain-measure")
psd = _load("prompt-size-dist")
him = _load("harness-injection-measure")

FAILS = []
UTC = timezone.utc


def check(name, cond, detail=""):
    """RAISES on failure (#378 CR): a check that only appends to FAILS is green
    under pytest whatever the code does -- pytest never runs main()."""
    if cond:
        print(f"  ok   {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name}  {detail}")
        raise AssertionError(f"{name}  {detail}")


def refusal(fn, *args):
    """The SystemExit message fn(*args) raises, or None when it returns."""
    try:
        fn(*args)
    except SystemExit as e:
        return str(e)
    return None


# ---------------------------------------------------------------- minimax
def test_mcm_offset_less_is_utc():
    print("case: minimax-chain-measure -- a bound without an offset is UTC")
    z = mcm.parse_iso("2026-11-26T00:00Z")
    check("with Z is the instant", z == datetime(2026, 11, 26, 0, 0, tzinfo=UTC), z.isoformat())
    b = mcm.parse_iso("2026-11-26T00:00")
    check("without Z is the SAME instant (was one host-offset earlier)", b == z, b.isoformat())
    check("... at the second", mcm.parse_iso("2026-11-26T00:00:00") == z, "second parity")
    half = datetime(2026, 11, 26, 0, 0, 0, 500000, tzinfo=UTC)
    check("... with an explicit fraction, without the Z", mcm.parse_iso("2026-11-26T00:00:00.5") == half,
          "fraction parity")
    check("... with an explicit fraction and the Z", mcm.parse_iso("2026-11-26T00:00:00.5Z") == half,
          "fraction parity, Z")
    check("an explicit offset is converted, never overwritten",
          mcm.parse_iso("2026-11-26T02:00+02:00") == z, "+02:00")
    check("... a negative one too", mcm.parse_iso("2026-11-25T19:00-05:00") == z, "-05:00")
    check("no bound is no bound", mcm.parse_iso(None) is None and mcm.parse_iso("") is None)


_CHILD = r"""
import importlib.util, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location("mcm_child", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
# the KNOWN-BUGGY reading: astimezone() presumes the SYSTEM zone for a naive value
print(datetime.fromisoformat("2026-11-26T00:00").astimezone(timezone.utc).isoformat())
print(m.parse_iso("2026-11-26T00:00").isoformat())
"""


def _child(tz):
    env = dict(os.environ)
    env.pop("TZ", None)
    if tz:
        env["TZ"] = tz
    r = subprocess.run(
        [sys.executable, "-I", "-c", _CHILD, os.path.join(_SCRIPTS, "minimax-chain-measure.py")],
        env=env, capture_output=True, text=True, timeout=120)
    check(f"child process under TZ={tz!r} ran", r.returncode == 0, (r.stderr or "")[-300:])
    buggy, fixed = r.stdout.split()
    return buggy, fixed


def test_mcm_zone_independent():
    print("case: minimax-chain-measure -- the same bound in child processes under three zones")
    rows = {tz: _child(tz) for tz in (None, "UTC", "Europe/Paris")}
    for tz, (_, fixed) in rows.items():
        check(f"parse_iso is 00:00Z under TZ={tz!r}", fixed == "2026-11-26T00:00:00+00:00", fixed)
    if any(buggy != "2026-11-26T00:00:00+00:00" for buggy, _ in rows.values()):
        check("positive control: the buggy reading shifts in a non-UTC child", True)
    else:
        print("  SKIP no child ran in a non-UTC zone: this host cannot tell the fix from the defect here")


# ------------------------------------------------------------ prompt-size
def test_psd_bound_spellings():
    print("case: prompt-size-dist -- every accepted spelling resolves to a minute key")
    for text, key in [
        ("2026-10-26", "2026-10-26T00:00"),             # date only: used to be DROPPED
        ("2026-10-26T09", "2026-10-26T09:00"),          # date-hour: used to be DROPPED
        ("2026-10-26T09:00", "2026-10-26T09:00"),
        ("2026-10-26T09:00Z", "2026-10-26T09:00"),
        ("2026-10-26T09:00:00", "2026-10-26T09:00"),
        ("2026-10-26T09:00:00Z", "2026-10-26T09:00"),
        ("2026-10-26T09:00:00.000Z", "2026-10-26T09:00"),
        ("2026-10-26 09:00", "2026-10-26T09:00"),
        ("2026-10-26T09-00", "2026-10-26T09:00"),       # the captures' own dash form
        ("2026-10-26T09-00-00", "2026-10-26T09:00"),
        ("2026-10-26T09-00-00-204Z", "2026-10-26T09:00"),   # read before: keeps its key
        ("2026-10-26T09:00:30", "2026-10-26T09:00"),        # documented minute reading
        (" 2026-10-26T09:00Z ", "2026-10-26T09:00"),
    ]:
        got = psd.bound_key(text, "--since")
        check(f"bound_key({text!r}) -> {key}", got == key, got)
    check("no bound is no bound",
          psd.bound_key(None, "--since") is None and psd.bound_key("", "--until") is None)


def _stderr_note(text, flag="--since"):
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        key = psd.bound_key(text, flag)
    return key, buf.getvalue()


def test_psd_subminute_note():
    print("case: prompt-size-dist -- a sub-minute bound says how it was read")
    key, note = _stderr_note("2026-10-26T09:00:30")
    check("the reading is the minute", key == "2026-10-26T09:00", key)
    check("... and stderr names it once, with the flag and the key",
          note.count("note:") == 1 and "--since" in note and "2026-10-26T09:00" in note, repr(note))
    key, note = _stderr_note("2026-10-26T09-00-00-204Z", "--until")
    check("the capture form with real milliseconds says so too", key == "2026-10-26T09:00" and "note:" in note,
          repr(note))
    for quiet in ("2026-10-26T09:00", "2026-10-26T09:00:00Z", "2026-10-26T09-00-00", "2026-10-26"):
        key, note = _stderr_note(quiet)
        check(f"{quiet!r} carries no sub-minute digits -> no note", note == "", repr(note))


def test_psd_bound_refusals():
    print("case: prompt-size-dist -- an unreadable bound refuses the run")
    for text in ("2026-13-45T09:00", "2026-10-26T25:00", "2026-10-26T09:61",
                 "yesterday", "10/26/2026", "2026-10-26T09:00:00Zjunk", "2026-10-26T"):
        msg = refusal(psd.bound_key, text, "--since")
        check(f"{text!r} refuses", msg is not None and repr(text) in msg, str(msg))
    check("the message names the flag it refuses",
          "--until" in (refusal(psd.bound_key, "nope", "--until") or ""))


_CORPUS = [
    ("req-1-0001-2026-10-25T22-00-00-000Z-direct.json", "2026-10-25T22-00-00-000Z"),
    ("req-1-0002-2026-10-26T09-00-10-000Z-direct.json", "2026-10-26T09-00-10-000Z"),
    ("req-1-0003-2026-10-26T09-30-00-000Z-direct.json", "2026-10-26T09-30-00-000Z"),
    ("req-1-0004-2026-10-27T09-30-00-000Z-direct.json", "2026-10-27T09-30-00-000Z"),
]


def _corpus(root):
    for name, ts in _CORPUS:
        doc = {"ts": ts, "src": "direct", "machine": "synthetic-a", "model": "claude-haiku-4-5",
               "pid": 1, "workload": "interactive",
               "body": {"model": "claude-haiku-4-5",
                        "messages": [{"role": "user", "content": "hello"}]}}
        with open(os.path.join(root, name), "w", encoding="utf-8", newline="\n") as f:
            json.dump(doc, f)


def _run(root, *extra):
    """(requests selected or None on refusal, refusal message, window line, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            psd.main(["--captures", root, *extra])
        except SystemExit as e:
            return None, str(e), "", err.getvalue()
    lines = out.getvalue().splitlines()
    n = int(next(ln for ln in lines if ln.startswith("requests selected:")).rsplit(" ", 1)[1])
    return n, None, " ".join(next(ln for ln in lines if " window:" in ln).split()), err.getvalue()


def test_psd_end_to_end():
    print("case: prompt-size-dist -- the window asked for is the window applied")
    with tempfile.TemporaryDirectory() as d:
        _corpus(d)
        n, _, win, _ = _run(d, "--since", "2026-10-26")
        check("a date-only bound is APPLIED (was dropped: 4 of 4)", n == 3, f"{n} | {win}")
        check("... and echoed resolved", "window: 2026-10-26T00:00 .. (now]" in win, win)
        n2, _, _, _ = _run(d, "--since", "2026-10-26T00:00Z")
        check("the same bound with the Z selects the same rows", n2 == 3, str(n2))
        n3, _, _, _ = _run(d, "--since", "2026-10-26T09")
        check("a date-hour bound is APPLIED (was dropped too)", n3 == 3, str(n3))
        a, _, _, _ = _run(d, "--since", "2026-10-26T09:00", "--until", "2026-10-26T11:00")
        b, _, _, _ = _run(d, "--since", "2026-10-26T09:00:00Z", "--until", "2026-10-26T11:00:00Z")
        check("the minute window, with and without the Z, selects the same rows",
              (a, b) == (2, 2), f"{a}/{b}")
        n4, _, win4, err4 = _run(d, "--since", "2026-10-26T09:00:30")
        check("a sub-minute bound keeps its documented reading (the 09:00 minute line counts)",
              n4 == 3 and "window: 2026-10-26T09:00 .. (now]" in win4, f"{n4} | {win4}")
        check("... and the run SAYS so on stderr", "sub-minute" in err4, repr(err4))
        n, err, _, _ = _run(d, "--since", "yesterday")
        check("an unreadable bound refuses the run (was: unbounded)",
              n is None and "'yesterday'" in (err or ""), str(err))


# ------------------------------------------------------ harness-injection
def test_him_bound_spellings():
    print("case: harness-injection-measure -- the bound is read in the captures' own form")
    for text, key in [
        ("2026-11-05", "2026-11-05"),                     # the documented form
        ("2026-11-05T13-30", "2026-11-05T13-30"),
        ("2026-11-05T13", "2026-11-05T13-00"),          # the hour alone worked before: keeps working
        ("2026-11-05 13:30", "2026-11-05T13-30"),       # a space separator, read as T
        ("2026-11-05T13-30-00", "2026-11-05T13-30-00"),
        ("2026-11-05T13-30-00-204Z", "2026-11-05T13-30-00-204"),
        ("2026-11-05T13:30", "2026-11-05T13-30"),
        ("2026-11-05T13:30Z", "2026-11-05T13-30"),
        ("2026-11-05T13:30:00", "2026-11-05T13-30-00"),
        ("2026-11-05T13:30:00Z", "2026-11-05T13-30-00"),
        ("2026-11-05T13:30:00.5Z", "2026-11-05T13-30-00-500"),
        ("2026-11-05T13:30:00.204", "2026-11-05T13-30-00-204"),
    ]:
        got = him.norm_bound(text)
        check(f"norm_bound({text!r}) -> {key}", got == key, got)
        check("... idempotent (main normalises, before_since normalises again)",
              him.norm_bound(got) == got, him.norm_bound(got))
    check("no bound is no bound", him.norm_bound(None) is None and him.norm_bound("") is None)


def test_him_before_since():
    print("case: harness-injection-measure -- an ISO bound no longer swallows its own hour")
    at_0930 = "2026-10-26T09-30-00-203Z"
    for since in ("2026-10-26T09:00", "2026-10-26T09:00:00", "2026-10-26T09:00Z",
                  "2026-10-26T09-00", "2026-10-26"):
        check(f"a capture of 09:30 is NOT before --since {since!r}",
              him.before_since(at_0930, since) is False, since)
    at_0830 = "2026-10-26T08-30-00-203Z"
    for since in ("2026-10-26T09:00", "2026-10-26T09:00Z", "2026-10-26T09-00", "2026-10-26T10"):
        check(f"a capture of 08:30 IS before --since {since!r}",
              him.before_since(at_0830, since) is True, since)
    check("the bound's own second is kept (inclusive lower bound)",
          him.before_since("2026-10-26T09-00-00-000Z", "2026-10-26T09:00") is False)
    check("a fractional bound is a ceiling: 203 ms is before 500 ms",
          him.before_since(at_0930, "2026-10-26T09:30:00.5") is True)
    check("... and not before 100 ms",
          him.before_since(at_0930, "2026-10-26T09:30:00.1") is False)
    check("the documented date-only form is unchanged (the PIEGE 9 pins)",
          him.before_since("2026-11-04T23-59-59-000Z", "2026-11-05") is True
          and him.before_since("2026-11-05T00-00-00-000Z", "2026-11-05") is False)
    check("no bound, or no stamp, bounds nothing",
          him.before_since("2026-11-04T23-59-59-000Z", None) is False
          and him.before_since(None, "2026-11-05") is False)


def test_him_bound_refusals():
    print("case: harness-injection-measure -- an unreadable bound refuses the run")
    for text in ("2026-13-45", "2026-10-26T25:00", "2026-10-26T09:61", "2026-10-26T09:00:61",
                 "2026-10-26T09:00:00.5000", "yesterday", "2026/10/26", "2026-10-26T09:00Zx"):
        msg = refusal(him.norm_bound, text)
        check(f"{text!r} refuses", msg is not None and repr(text) in msg, str(msg))


def main():
    test_mcm_offset_less_is_utc()
    test_mcm_zone_independent()
    test_psd_bound_spellings()
    test_psd_subminute_note()
    test_psd_bound_refusals()
    test_psd_end_to_end()
    test_him_bound_spellings()
    test_him_before_since()
    test_him_bound_refusals()
    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} -> {FAILS}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
