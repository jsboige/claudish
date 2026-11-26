#!/usr/bin/env python3
"""Pins for scripts/relay-reqnumber-audit.py — the #1193 acceptance row.

No docker, no network: every corpus is synthetic (hosts `hub.example`, machine
`seat-a`, fabricated timestamps). `audit()` is pure, so each verdict is
exercised by handing it lines.

THE TRAPS EACH PIN HOLDS (the wrong-but-plausible row it produces):
  T1 a whole-life window on a seat that served locally reports several
     distinct reqN — read as "the fix works". The acceptance row is the window
     after the last transition back to NOMINAL.
  T2 a per-request relay line mentions AUTONOMOUS without being a transition;
     counting the word inflates the episode count and moves the trim point.
  T3 a window spanning a process restart carries one frozen value per life; a
     whole-window verdict over several lives is invalid.
  T6 without `docker logs -t` the trim is impossible: the script says so
     instead of trimming on line order.
  T7 the subprocess read (only the `--container` path) must pin UTF-8 and
     replace undecodable bytes; the arrow is multi-byte.
  T8 a corpus whose head was rotated away must not read as a whole life.
"""
from __future__ import annotations

import ast
import contextlib
import importlib.util
import io
import json
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "relay-reqnumber-audit.py"

spec = importlib.util.spec_from_file_location("relay_reqnumber_audit", SCRIPT)
assert spec is not None and spec.loader is not None
audit_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_mod)

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"ok - {name}")
    else:
        FAILURES.append(f"{name}: {detail}")
        print(f"not ok - {name}: {detail}")


# --- synthetic corpus builders -------------------------------------------------

def ts(second: int, frac: str = "000000000") -> str:
    return f"2026-11-26T02:06:{second:02d}.{frac}Z"


def startup(second: int = 0) -> str:
    return f"{ts(second)} [Relay] sidecar mode: upstream=http://hub.example:3000 compress=true"


def ttft(second: int, req: int | None, model: str = "claude-sonnet-5-5", frac: str = "000000000") -> str:
    number = "" if req is None else f" reqN={req}"
    return f"{ts(second, frac)}   [ttft] anthropic model={model}{number} headers=1000ms firstEvent=1ms total=1001ms"


def request_line(second: int, model: str = "claude-sonnet-5-5", frac: str = "000000000") -> str:
    return (
        f"{ts(second, frac)} [claudish] [Request] model={model} handler=ComposedHandler"
        f" src=direct stream msgs=3 max_tokens=100 machine=seat-a ua=synthetic"
    )


def transition(second: int, mode: str, frac: str = "000000000") -> str:
    if mode == "AUTONOMOUS":
        return (
            f"{ts(second, frac)} [Relay] upstream http://hub.example:3000 DOWN after 2 failure(s)"
            f" (heartbeat) → AUTONOMOUS"
        )
    return (
        f"{ts(second, frac)} [Relay] upstream http://hub.example:3000 healthy again"
        f" → NOMINAL (relay resumed) — queue RECOVERED→NOMINAL 52.7s"
    )


def audit(lines: list[str], **kwargs) -> dict:
    return audit_mod.audit(lines, **kwargs)


# --- FROZEN: the shape an image older than #1194 produces ---------------------

frozen = audit([startup(0)] + [ttft(i, 0) for i in range(1, 6)])
check("FROZEN: one distinct reqN and no local serving", frozen["verdict"] == "FROZEN", str(frozen["verdict"]))
check("FROZEN: the row carries the frozen value", frozen["reqN_counts"] == {"0": 5}, str(frozen["reqN_counts"]))
check("FROZEN: no [Request] line in the row", frozen["request_lines"] == 0, str(frozen["request_lines"]))
check("FROZEN: acceptance is the same window when nothing was served", frozen["acceptance"] is not None and frozen["acceptance"]["verdict"] == "FROZEN", str(frozen["acceptance"]))
check("T8: a corpus starting on the startup line is a whole life", frozen["window"]["starts_at_process_start"] is True, str(frozen["window"]))
mid_life = audit([ttft(1, 0), ttft(2, 0)])
check("T8 control: a corpus that starts mid-life is not claimed whole", mid_life["window"]["starts_at_process_start"] is False, str(mid_life["window"]))

# --- T4: a [ttft] line without reqN is reported and does not break the row ----

partly_numbered = audit([startup(0), ttft(1, 1), ttft(2, 2), ttft(3, None)])
check("T4: an unnumbered line is counted, not dropped silently", partly_numbered["ttft"] == 3 and partly_numbered["ttft_without_reqN"] == 1, f"{partly_numbered['ttft']} / {partly_numbered['ttft_without_reqN']}")
check("T4: FIXED compares against the NUMBERED lines only", partly_numbered["verdict"] == "FIXED", str(partly_numbered["verdict"]))

# --- FIXED: distinct numbers, one per numbered [ttft] -------------------------

fixed = audit([startup(0)] + [ttft(i, i) for i in range(1, 6)])
check("FIXED: one number per [ttft] line", fixed["verdict"] == "FIXED", str(fixed["verdict"]))
check("FIXED: distinct == numbered lines", fixed["distinct_reqN"] == fixed["ttft_numbered"] == 5, f"{fixed['distinct_reqN']} vs {fixed['ttft_numbered']}")

# --- INCONCLUSIVE / NO-TRAFFIC ------------------------------------------------

one = audit([startup(0), ttft(1, 7)])
check("INCONCLUSIVE: a single numbered line says nothing", one["verdict"] == "INCONCLUSIVE", str(one["verdict"]))
none_traffic = audit([startup(0), transition(1, "AUTONOMOUS")])
check("NO-TRAFFIC: no [ttft] in the window", none_traffic["verdict"] == "NO-TRAFFIC", str(none_traffic["verdict"]))

# --- T1: the measured po-2024 shape, synthetic --------------------------------
# 3 relayed lines frozen at 0 -> autonomous episode serves 2 locally (numbers
# 1 and 2 taken by the local pipeline) -> back to NOMINAL -> 4 relayed lines
# carry 2, the last number the local pipeline attributed.

episode = (
    [startup(0)]
    + [ttft(1, 0), ttft(2, 0), ttft(3, 0)]
    + [transition(4, "AUTONOMOUS")]
    + [ttft(5, 1), request_line(5), ttft(6, 2), request_line(6)]
    + [transition(7, "NOMINAL")]
    + [ttft(8, 2), ttft(9, 2), ttft(10, 2), ttft(11, 2)]
)
got = audit(episode)
check("T1: the as-measured window reads LOCAL-SERVING", got["window_verdict"] == "LOCAL-SERVING", str(got.get("window_verdict")))
check("T1: the whole window would have been read as several distinct values", got["distinct_reqN"] == 3, str(got["distinct_reqN"]))
check("T1: the quoted verdict is the acceptance one", got["verdict"] == "FROZEN", str(got["verdict"]))
check("T1: the acceptance row is FROZEN", got["acceptance"] is not None and got["acceptance"]["verdict"] == "FROZEN", str(got["acceptance"]))
check("T1: the acceptance row starts after the NOMINAL transition", got["acceptance"] is not None and got["acceptance"]["since"] == ts(7), str(got["acceptance"] and got["acceptance"]["since"]))
check("T1: the acceptance row freezes at the last local number", got["acceptance"] is not None and got["acceptance"]["reqN_counts"] == {"2": 4}, str(got["acceptance"] and got["acceptance"]["reqN_counts"]))
check("T1: the acceptance row has no [Request] line", got["acceptance"] is not None and got["acceptance"]["request_lines"] == 0, str(got["acceptance"] and got["acceptance"]["request_lines"]))
check("T1: the life holding the trim point is kept (it starts after the cut)", len(got["lives"]) == 1 and got["lives"][0]["ttft"] == 4, str(got["lives"]))

# --- T9: the acceptance precondition compares INSTANTS, not strings -----------
# Go's RFC3339Nano trims trailing zeros (and drops the fraction at ns=0), so two
# lines of the same second can carry fractions of different lengths. A raw
# string compare moves the cut the wrong way in BOTH directions (26/11, cycle 8).

after = audit(
    [startup(0), request_line(3)]
    + [transition(8, "NOMINAL", "6")]  # Go prints .600 as ".6"
    + [request_line(8, frac="634")]  # .634 > .600: served AFTER the return
    + [ttft(9, 6), ttft(10, 6)]
)
check("T9: a request after a short-fraction transition leaves no acceptance row", after["verdict"] == "NO-ACCEPTANCE-WINDOW", str(after["verdict"]))
check("T9: and no row is quoted in its place", after["acceptance"] is None, str(after["acceptance"]))

before = audit(
    [startup(0)]
    + [request_line(8, frac="6")]  # .600
    + [transition(8, "NOMINAL", "63")]  # .630 > .600: the transition is later
    + [ttft(9, 6), ttft(10, 6)]
)
check("T9: a long-fraction transition after the request still cuts the row", before["acceptance"] is not None, str(before["acceptance"]))
check("T9: the row starts at that transition", before["acceptance"] is not None and before["acceptance"]["since"] == ts(8, "63"), str(before["acceptance"] and before["acceptance"]["since"]))
check("T9: and it excludes the local request", before["acceptance"] is not None and before["acceptance"]["request_lines"] == 0, str(before["acceptance"] and before["acceptance"]["request_lines"]))


nofrac = audit(
    [startup(0), request_line(3)]
    + ["2026-11-26T02:06:08Z [Relay] upstream http://hub.example:3000 healthy again → NOMINAL (relay resumed)"]  # ns=0: no fraction
    + [request_line(8, frac="5")]  # .500 > .000: served AFTER the return
    + [ttft(9, 6), ttft(10, 6)]
)
check("T9: a transition written at the second is still placed by instant", nofrac["verdict"] == "NO-ACCEPTANCE-WINDOW", str(nofrac["verdict"]))

# POSITIVE CONTROL for T1: the same instrument on the same shape minus the
# episode must NOT find an acceptance row to trim — it reads the whole window.
control = audit([startup(0)] + [ttft(i, 0) for i in range(1, 6)])
check("T1 control: no episode, no trim, the window itself is FROZEN", control["verdict"] == "FROZEN" and control["acceptance"] is not None and control["acceptance"]["since"] is None, str(control["acceptance"]))

# --- T2: a per-request line is not a transition -------------------------------

per_request = (
    f"{ts(3)} [Relay] forward failed (aborted-on-autonomous) → this request"
    " served LOCALLY [2/2 before AUTONOMOUS]"
)
only_per_request = audit([startup(0), per_request, ttft(1, 0), ttft(2, 0)])
check("T2: a per-request line yields no transition", only_per_request["autonomous"] == 0, str(only_per_request["autonomous"]))
with_real = audit([startup(0), transition(1, "AUTONOMOUS"), per_request, ttft(2, 0), ttft(3, 0)])
check("T2: the transition is counted once, not twice", with_real["autonomous"] == 1, str(with_real["autonomous"]))

# the encoding-damaged arrow still reads as a transition (same fallback as
# scripts/hub-entry-probe.py)
arrowless = f"{ts(7)} [Relay] upstream http://hub.example:3000 healthy again � NOMINAL (relay resumed)"
damaged = audit([startup(0), ttft(1, 0), request_line(2), ttft(3, 0), arrowless, ttft(4, 0), ttft(5, 0)])
check("T2: an arrowless NOMINAL line still trims the window", damaged["acceptance"] is not None and damaged["acceptance"]["since"] == ts(7), str(damaged["acceptance"] and damaged["acceptance"]["since"]))

# --- the relay never came back: no acceptance row to quote -------------------

still_autonomous = audit([startup(0), ttft(1, 0), transition(2, "AUTONOMOUS"), request_line(3), ttft(4, 1), ttft(5, 1)])
check(
    "still AUTONOMOUS: no clean acceptance window, and the note says why",
    still_autonomous["acceptance"] is None
    and "AUTONOMOUS" in (still_autonomous["trim_note"] or "")
    and still_autonomous["verdict"] == "NO-ACCEPTANCE-WINDOW"
    and still_autonomous["window_verdict"] == "LOCAL-SERVING",
    f"{still_autonomous['acceptance']} / {still_autonomous['trim_note']} / {still_autonomous['verdict']}",
)

# --- T3: two process lives in one window -------------------------------------

two_lives = audit([startup(0)] + [ttft(i, 0) for i in range(1, 4)] + [startup(5)] + [ttft(i, 4) for i in range(6, 9)])
check("T3: the whole-window verdict over two lives is MULTI-LIFE", two_lives["verdict"] == "MULTI-LIFE", str(two_lives["verdict"]))
check("T3: one row per process life", len(two_lives["lives"]) == 2, str(len(two_lives["lives"])))
check("T3: each life is FROZEN on its own value", [l["verdict"] for l in two_lives["lives"]] == ["FROZEN", "FROZEN"], str([l["verdict"] for l in two_lives["lives"]]))
check("T3: the second life freezes at its own base", two_lives["lives"][1]["reqN_counts"] == {"4": 3}, str(two_lives["lives"][1]["reqN_counts"]))

# single life: no per-life rows to distract from the row
check("T3 control: one life prints no life rows", len(frozen["lives"]) == 1 and len(fixed["lives"]) == 1, f"{len(frozen['lives'])} / {len(fixed['lives'])}")

# --- AMBIGUOUS: several frozen values, no local serving ----------------------

ambiguous = audit([startup(0), ttft(1, 0), ttft(2, 0), ttft(3, 0), ttft(4, 1), ttft(5, 2)])
check("AMBIGUOUS: several values without [Request] is not FROZEN and not FIXED", ambiguous["verdict"] == "AMBIGUOUS", str(ambiguous["verdict"]))

# --- T6: no timestamps -------------------------------------------------------

untimed = [startup(0).split(" ", 1)[1], ttft(1, 0).split(" ", 1)[1], request_line(2).split(" ", 1)[1], ttft(3, 0).split(" ", 1)[1]]
no_ts = audit(untimed)
check("T6: counters still work without timestamps", no_ts["ttft"] == 2 and no_ts["request_lines"] == 1, f"{no_ts['ttft']} / {no_ts['request_lines']}")
check("T6: the trim is refused, not guessed", no_ts["acceptance"] is None and "timestamps" in (no_ts["trim_note"] or ""), f"{no_ts['acceptance']} / {no_ts['trim_note']}")
check("T6: has_timestamps says so", no_ts["window"]["has_timestamps"] is False, str(no_ts["window"]))

# --- window bounds, fractional seconds included ------------------------------

# the line inside the bound second carries a NON-ZERO fraction, as every real
# `docker logs -t` stamp does: a bound written at the second must keep it.
bounded = audit(
    [startup(0), ttft(1, 0), ttft(2, 0, frac="500000000"), ttft(3, 0, frac="250000000")],
    since="2026-11-26T02:06:02",
    until="2026-11-26T02:06:02",
)
check("bounds: since/until written at the second keep that whole second and only it", bounded["ttft"] == 1 and bounded["first_ts"] == ts(2, "500000000"), f"{bounded['ttft']} / {bounded['first_ts']}")
second_start = audit([startup(0), ttft(2, 0, frac="500000000")], since="2026-11-26T02:06:02")
check("bounds: since at the second keeps a line later in that second", second_start["ttft"] == 1, str(second_start["ttft"]))
fractional = audit(
    [
        f"2026-11-26T02:06:01.250000000Z [claudish] [Request] model=m handler=h src=direct stream",
        "2026-11-26T02:06:01.750000000Z   [ttft] anthropic model=m reqN=1 headers=1ms firstEvent=1ms total=2ms",
    ],
    since="2026-11-26T02:06:01.5",
)
check("bounds: a fraction compares numerically, not as text", fractional["request_lines"] == 0 and fractional["ttft"] == 1, f"{fractional['request_lines']} / {fractional['ttft']}")

# --- T10: an `until` bound means the same second with and without the Z ------
# The suffix used to be appended to the caller's text ("…:00Z" + ".999999999"),
# where ISO_RE never reads it: the bound collapsed to the START of its second,
# so two lines inside it counted 0 with the Z and 2 without.

in_second = [startup(0), ttft(2, 0, frac="100000000"), ttft(2, 0, frac="200000000")]
bare_until = audit(in_second, until="2026-11-26T02:06:02")
zed_until = audit(in_second, until="2026-11-26T02:06:02Z")
check("T10: a bound without Z keeps both lines of its second", bare_until["ttft"] == 2, str(bare_until["ttft"]))
check("T10: a bound WITH Z keeps both lines of its second", zed_until["ttft"] == 2, str(zed_until["ttft"]))
check("T10: the two spellings agree on the row", (bare_until["ttft"], bare_until["first_ts"], bare_until["last_ts"]) == (zed_until["ttft"], zed_until["first_ts"], zed_until["last_ts"]), f"{bare_until['ttft']} / {zed_until['ttft']}")
check("T10: the next second stays out", audit(in_second + [ttft(3, 0)], until="2026-11-26T02:06:02Z")["ttft"] == 2, "next second kept")
check("T10: an explicit fraction with Z is a ceiling, not the end of the second", audit(in_second, until="2026-11-26T02:06:02.1Z")["ttft"] == 1, str(audit(in_second, until="2026-11-26T02:06:02.1Z")["ttft"]))
check("T10: … and it agrees without the Z", audit(in_second, until="2026-11-26T02:06:02.1")["ttft"] == 1, str(audit(in_second, until="2026-11-26T02:06:02.1")["ttft"]))
check("T10: a fraction below the lines excludes them", audit(in_second, until="2026-11-26T02:06:02.05Z")["ttft"] == 0, str(audit(in_second, until="2026-11-26T02:06:02.05Z")["ttft"]))

# --- T7: the only subprocess read pins UTF-8 and replaces bad bytes ----------

source = SCRIPT.read_text(encoding="utf-8")
tree = ast.parse(source)
subprocess_calls = []
bad_opens = []
for node in ast.walk(tree):
    if isinstance(node, ast.Call):
        func = node.func
        name = getattr(func, "attr", getattr(func, "id", ""))
        if name == "run" and getattr(getattr(func, "value", None), "id", "") == "subprocess":
            subprocess_calls.append(node)
        if name == "open":
            modes = [k.value.value for k in node.keywords if k.arg == "mode" and isinstance(k.value, ast.Constant)]
            modes += [a.value for a in node.args[1:2] if isinstance(a, ast.Constant)]
            encodings = [k for k in node.keywords if k.arg == "encoding"]
            if not any("b" in str(m) for m in modes) and not encodings:
                bad_opens.append(getattr(node, "lineno", -1))
check("T7: the docker read exists and pins encoding/errors", bool(subprocess_calls) and all(
    any(k.arg == "encoding" and getattr(k.value, "value", "") == "utf-8" for k in call.keywords)
    and any(k.arg == "errors" and getattr(k.value, "value", "") == "replace" for k in call.keywords)
    for call in subprocess_calls
), f"{len(subprocess_calls)} subprocess.run call(s)")
check("T7: every text open states its encoding", not bad_opens, str(bad_opens))

# --- CLI: text, json, stdin, exit codes --------------------------------------

text_out = io.StringIO()
with contextlib.redirect_stdout(text_out):
    code = audit_mod.main([], stdin_bytes="\n".join(episode).encode("utf-8", "replace"))
rendered = text_out.getvalue()
check("CLI: exit 0 when a row was produced", code == 0, str(code))
check("CLI: the text row names both windows", "window[" in rendered and "acceptance[>" in rendered, rendered[:200])
check("CLI: the acceptance row carries the FROZEN verdict", "acceptance[>" in rendered and "verdict=FROZEN" in rendered.split("acceptance[>", 1)[1], rendered[:400])
window_part = rendered.split("acceptance[>", 1)[0]
check("CLI: the window row keeps its own LOCAL-SERVING verdict", "verdict=LOCAL-SERVING" in window_part and "verdict=FROZEN" not in window_part, window_part[:300])

json_out = io.StringIO()
with contextlib.redirect_stdout(json_out):
    code = audit_mod.main(["--json"], stdin_bytes="\n".join(episode).encode("utf-8", "replace"))
payload = json.loads(json_out.getvalue())
check("CLI: --json exits 0 and parses", code == 0, str(code))
check("CLI: --json carries the same acceptance numbers", payload["acceptance"]["reqN_counts"] == {"2": 4}, str(payload["acceptance"]["reqN_counts"]))
check("CLI: --json keeps both verdicts under their own names", payload["verdict"] == "FROZEN" and payload["window_verdict"] == "LOCAL-SERVING", f"{payload['verdict']} / {payload.get('window_verdict')}")

broken = io.StringIO()
with contextlib.redirect_stdout(broken), contextlib.redirect_stderr(io.StringIO()):
    code = audit_mod.main(["--log", str(REPO_ROOT / "scripts" / "tests" / "no-such-file.log")])
check("CLI: an unreadable --log exits 2", code == 2, str(code))

undecodable = "".join(line + "\n" for line in [startup(0), ttft(1, 0), ttft(2, 0)]).encode("utf-8") + b"\xff\xfe garbage\n"
undecoded_out = io.StringIO()
with contextlib.redirect_stdout(undecoded_out):
    code = audit_mod.main([], stdin_bytes=undecodable)
check("CLI: undecodable stdin bytes degrade, they do not raise", code == 0 and "verdict=FROZEN" in undecoded_out.getvalue(), undecoded_out.getvalue()[:200])

# --- by-model control (T5) ----------------------------------------------------

by_model = io.StringIO()
with contextlib.redirect_stdout(by_model):
    audit_mod.main(["--by-model"], stdin_bytes="\n".join(
        [startup(0), ttft(1, 0, "model-a"), ttft(2, 0, "model-b")]
    ).encode("utf-8"))
check("T5: --by-model prints one distinct value per model on a frozen counter", "model=model-a distinct_reqN=1" in by_model.getvalue() and "model=model-b distinct_reqN=1" in by_model.getvalue(), by_model.getvalue()[:300])

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S):")
    for failure in FAILURES:
        print(f"  - {failure}")
    sys.exit(1)
print("all pins green")
