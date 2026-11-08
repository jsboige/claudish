#!/usr/bin/env python3
"""Pins for scripts/hub-entry-probe.py — the fleet-entry-form probe.

No network, no docker: `classify()` is pure, so every verdict is exercised by
handing it layer results. Each pin carries a POSITIVE CONTROL — the healthy
shape it must NOT be confused with — because a verdict function that returns
"degraded" for everything passes every negative assertion.

THE TRAPS EACH PIN HOLDS (the wrong-but-plausible answer it produces):
  T1 a gateway error from the facade alone looks like "the hub is down"; it is
     only the hub's death if the published port is dead too.
  T2 a sidecar's /health answers role=relay-nominal: reading `role` from the
     wrong port says "the entry form is a sidecar".
  T3 uptimeSec inside the container is not immune to a host clock step: it can
     read negative. It is reported, never turned into a start time.
  T4 `docker logs --since` serves a rotated-away segment silently — the seat
     layer must read `--tail` only.
  T5 the /health body carries live request material (proxyKeyPreviousHits):
     only whitelisted fields may reach the output.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "hub-entry-probe.py"

spec = importlib.util.spec_from_file_location("hub_entry_probe", SCRIPT)
probe = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(probe)

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"ok - {name}")
    else:
        FAILURES.append(f"{name}: {detail}")
        print(f"not ok - {name}: {detail}")


def entry_ok(**extra) -> dict:
    payload = {"status": "ok", "role": "hub", "instanceId": "ca6c14b5-48c9-4c4a-8149-2c6c9b27e7ee", "uptimeSec": 1019}
    payload.update(extra)
    return {"status": 200, "error": None, "json": payload, "elapsed_ms": 12}


def entry_refused() -> dict:
    return {"status": None, "error": "refused", "json": None, "elapsed_ms": 3}


def entry_sidecar() -> dict:
    return {
        "status": 200,
        "error": None,
        "json": {"role": "relay-nominal", "upstream": "http://192.168.0.50:3000", "instanceId": "48b7f466"},
        "elapsed_ms": 8,
    }


def facade(status: int | None = 401, error: str | None = None) -> dict:
    return {"status": status, "error": error, "json": None, "elapsed_ms": 40}


def seat(
    mode: str = "NOMINAL",
    since: str | None = None,
    last: str | None = None,
    role: str | None = None,
    last_transition_mode: str | None = None,
    log_lines: int | None = None,
) -> dict:
    """A seat layer result, shaped like `read_seat_mode`'s output.

    `role` is the LIVE vocabulary (relay-nominal / relay-autonomous) read from
    the seat's own /health; `last_transition_mode` is what the LOG ended on.
    The hang verdicts (T9) only trust the live one.
    """
    out = {"mode": mode, "since": since, "last_served": last, "role": role}
    if last_transition_mode is not None:
        out["last_transition_mode"] = last_transition_mode
    if log_lines is not None:
        out["log_lines"] = log_lines
        out["log_source"] = "--tail 1000"
        out["log_readable"] = True
    return out


# --- the healthy baseline, and the control that proves the verdict is sensitive

base = probe.classify(entry_ok(), facade(401), seat("NOMINAL"))
check("NOMINAL verdict", base["verdict"] == "NOMINAL", base["verdict"])
check("NOMINAL exit code is 0", base["exit_code"] == 0, str(base["exit_code"]))
check("NOMINAL is not degraded", base["degraded"] is False, str(base["degraded"]))

# POSITIVE CONTROL for every negative pin below: the same call with the hub
# healthy must read NOMINAL, so a "always degraded" classifier cannot pass.
control = probe.classify(entry_ok(), facade(200), seat("NOMINAL"))
check(
    "positive control: the same call is NOMINAL when the hub answers",
    control["verdict"] == "NOMINAL",
    control["verdict"],
)

# --- T1: the facade's gateway error alone is NOT the hub's death

down = probe.classify(entry_refused(), facade(502), seat("AUTONOMOUS", "2026-10-30T09:36:59Z"))
check("T1 unreachable entry + gateway error -> ENTRY-DOWN", down["verdict"] == "ENTRY-DOWN", down["verdict"])
check("T1 ENTRY-DOWN exit code is 1", down["exit_code"] == 1, str(down["exit_code"]))
check("T1 ENTRY-DOWN is degraded", down["degraded"] is True, str(down["degraded"]))
check(
    "T1 the seat's last transition is carried (the outage is dated)",
    down["facts"].get("seat_mode_since") == "2026-10-30T09:36:59Z",
    str(down["facts"].get("seat_mode_since")),
)

path = probe.classify(entry_refused(), facade(401), seat("NOMINAL"))
check("T1 unreachable entry but facade answers -> PATH-BROKEN", path["verdict"] == "PATH-BROKEN", path["verdict"])
check(
    "T1 PATH-BROKEN is not ENTRY-DOWN (the path, not the hub, is broken)",
    path["verdict"] != "ENTRY-DOWN",
    path["verdict"],
)

facade_only = probe.classify(entry_ok(), facade(502), seat("NOMINAL"))
check(
    "T1 hub alive + gateway error from the facade -> FACADE-502-ONLY",
    facade_only["verdict"] == "FACADE-502-ONLY",
    facade_only["verdict"],
)

# --- T2: a sidecar's /health is not the fleet entry form

side = probe.classify(entry_sidecar(), facade(502), seat("NOMINAL"))
check("T2 a sidecar port is not the entry form", side["verdict"] != "NOMINAL", side["verdict"])
check("T2 ... it reads ENTRY-DOWN, not NOMINAL", side["verdict"] == "ENTRY-DOWN", side["verdict"])
check(
    "T2 the role it answered is still reported (diagnosis, not a verdict)",
    side["facts"].get("role") == "relay-nominal",
    str(side["facts"].get("role")),
)

# --- T3: an absurd uptimeSec is flagged, and never becomes a start time

absurd = probe.classify(entry_ok(uptimeSec=-5), facade(401), seat("NOMINAL"))
check("T3 a negative uptimeSec is flagged", absurd["facts"].get("uptimeSec_implausible") is True, str(absurd["facts"]))
check(
    "T3 no start time is derived from uptimeSec",
    "startedAt" not in absurd["facts"] and "start" not in absurd["facts"],
    str(absurd["facts"]),
)
plausible = probe.classify(entry_ok(uptimeSec=1019), facade(401), seat("NOMINAL"))
check(
    "T3 a plausible uptimeSec is not flagged (positive control)",
    "uptimeSec_implausible" not in plausible["facts"],
    str(plausible["facts"]),
)

# --- T4: the seat layer must never read a rotated-away segment

# The check is on the CODE, not on the file: the docstrings name `--since`
# precisely because it must never be used. Docstring literals are excluded.
import ast  # noqa: E402

_tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
_docs = set()
for _node in ast.walk(_tree):
    if isinstance(_node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        _d = ast.get_docstring(_node, clean=False)
        if _d is not None:
            _docs.add(_d)
_code_strings = [
    n.value
    for n in ast.walk(_tree)
    if isinstance(n, ast.Constant) and isinstance(n.value, str) and n.value not in _docs
]
check(
    "T4 no --since argument anywhere in the code",
    not [s for s in _code_strings if s.startswith("--since")],
    str([s for s in _code_strings if s.startswith("--since")]),
)
check(
    "T4 the seat layer reads --tail",
    any(s == "--tail" for s in _code_strings),
    "--tail missing",
)

# --- T5: only whitelisted fields reach the output

leaky = probe.classify(
    entry_ok(proxyKeyPreviousHits={"x-proxy-key": "secret"}, activeStreams=2),
    facade(401),
    seat("NOMINAL"),
)
facts_text = repr(leaky["facts"])
check("T5 no live request material in the facts", "secret" not in facts_text, facts_text)
check("T5 no request-header field in the facts", "proxyKeyPreviousHits" not in facts_text, facts_text)
check(
    "T5 the whitelisted identity fields survive (the probe is still useful)",
    leaky["facts"].get("instanceId", "").startswith("ca6c14b5"),
    str(leaky["facts"].get("instanceId")),
)

# --- UNKNOWN: absence of signal is not a signal

unknown = probe.classify(
    {"status": None, "error": "timeout", "json": None, "elapsed_ms": 6000},
    facade(None, "timeout"),
    None,
)
check("UNKNOWN when no layer answers", unknown["verdict"] == "UNKNOWN", unknown["verdict"])
check("UNKNOWN exit code is 2 (inconclusive, not degraded)", unknown["exit_code"] == 2, str(unknown["exit_code"]))

# --- ENTRY-UNRESPONSIVE / PROBE-BLIND: a measured hang is not "no signal" ---

timeout_entry = {"status": None, "error": "timeout", "json": None, "elapsed_ms": 6000}
timeout_entry_py = {"status": None, "error": "TimeoutError: timed out", "json": None, "elapsed_ms": 6000}
timeout_facade = {"status": None, "error": "TimeoutError: The read operation timed out", "elapsed_ms": 6000}

hang_auto = probe.classify(
    timeout_entry,
    timeout_facade,
    seat("AUTONOMOUS", "2026-10-30T15:20:11Z", role="relay-autonomous", last_transition_mode="AUTONOMOUS"),
)
check("a hang at both layers + LIVE AUTONOMOUS seat -> ENTRY-UNRESPONSIVE", hang_auto["verdict"] == "ENTRY-UNRESPONSIVE", hang_auto["verdict"])
check("ENTRY-UNRESPONSIVE is degraded, exit 1", hang_auto["degraded"] is True and hang_auto["exit_code"] == 1, str(hang_auto))
check(
    "the other timeout spelling is recognised too",
    probe.classify(timeout_entry_py, timeout_facade, seat("AUTONOMOUS", role="relay-autonomous"))["verdict"] == "ENTRY-UNRESPONSIVE",
    probe.classify(timeout_entry_py, timeout_facade, seat("AUTONOMOUS", role="relay-autonomous"))["verdict"],
)

blind_seat = probe.classify(timeout_entry, timeout_facade, seat("NOMINAL", role="relay-nominal"))
check("the same timeouts + a LIVE NOMINAL seat -> PROBE-BLIND", blind_seat["verdict"] == "PROBE-BLIND", blind_seat["verdict"])
check(
    "PROBE-BLIND is inconclusive: exit 2, not degraded",
    blind_seat["exit_code"] == 2 and blind_seat["degraded"] is False,
    str(blind_seat),
)
check(
    "the same timeouts with no seat state -> UNKNOWN",
    probe.classify(timeout_entry, timeout_facade, None)["verdict"] == "UNKNOWN",
    probe.classify(timeout_entry, timeout_facade, None)["verdict"],
)

# --- T9: a mode read from the LOG alone cannot corroborate a hang ---
# The CR's reproduced case: the seat's /health does not answer (sidecar hung
# too), but the log ends on a NOMINAL transition — possibly hours old. The
# pre-fix code rendered PROBE-BLIND ("do not escalate") on exactly the outage
# the probe exists to catch.

stale_nominal = seat("NOMINAL", "2026-10-30T10:32:23Z", role=None, last_transition_mode="NOMINAL", log_lines=1)
r1_stale = probe.classify(timeout_entry, timeout_facade, stale_nominal)
check(
    "T9 two timeouts + a LOG-only NOMINAL -> UNKNOWN, not PROBE-BLIND",
    r1_stale["verdict"] == "UNKNOWN",
    r1_stale["verdict"],
)
check(
    "T9 ... and it is inconclusive (exit 2): no escalation, but no suppression either",
    r1_stale["exit_code"] == 2,
    str(r1_stale["exit_code"]),
)
check(
    "T9 the facts name the mode source as the log",
    r1_stale["facts"].get("seat_mode_source") == "log",
    str(r1_stale["facts"]),
)

stale_autonomous = seat("AUTONOMOUS", "2026-10-30T09:36:59Z", role=None, last_transition_mode="AUTONOMOUS", log_lines=1)
r1_stale_escalation = probe.classify(timeout_entry, timeout_facade, stale_autonomous)
check(
    "T9 same root, benign direction: a LOG-only AUTONOMOUS does not conjure ENTRY-UNRESPONSIVE",
    r1_stale_escalation["verdict"] == "UNKNOWN",
    r1_stale_escalation["verdict"],
)

check(
    "T9 a LIVE role is still named as the source",
    blind_seat["facts"].get("seat_mode_source") == "live",
    str(blind_seat["facts"]),
)
check(
    "T9 a seat with neither source asserts none",
    probe.classify(timeout_entry, timeout_facade, seat(None))["facts"].get("seat_mode_source") is None,
    str(probe.classify(timeout_entry, timeout_facade, seat(None))["facts"]),
)

# POSITIVE CONTROLS: the new branch must not swallow the shapes it sits beside.
check(
    "entry timeout + gateway error stays ENTRY-DOWN",
    probe.classify(timeout_entry, facade(502), seat("NOMINAL"))["verdict"] == "ENTRY-DOWN",
    probe.classify(timeout_entry, facade(502), seat("NOMINAL"))["verdict"],
)
check(
    "entry timeout + facade answers stays PATH-BROKEN",
    probe.classify(timeout_entry, facade(401), seat("NOMINAL"))["verdict"] == "PATH-BROKEN",
    probe.classify(timeout_entry, facade(401), seat("NOMINAL"))["verdict"],
)
check(
    "entry refused + facade silent -> ENTRY-DOWN (a refusal is a measurement)",
    probe.classify(entry_refused(), timeout_facade, seat("NOMINAL"))["verdict"] == "ENTRY-DOWN",
    probe.classify(entry_refused(), timeout_facade, seat("NOMINAL"))["verdict"],
)
check(
    "hub alive + facade timeout -> FACADE-UNRESPONSIVE",
    probe.classify(entry_ok(), timeout_facade, seat("NOMINAL"))["verdict"] == "FACADE-UNRESPONSIVE",
    probe.classify(entry_ok(), timeout_facade, seat("NOMINAL"))["verdict"],
)

# --- T10: a facade that produced NO STATUS is never "fine" ---
# Measured on the pre-fix branch (hub alive, live NOMINAL seat): a refused,
# DNS-failed or TLS-broken facade fell through to NOMINAL — while the facade
# is the door clients actually knock on. Invariant: no no-status shape may
# return NOMINAL (the mirror of "a refusal is a measurement" at the entry).

for no_status_error in ("refused", "gaierror: [Errno 11001] getaddrinfo failed", "SSLError: CERTIFICATE_VERIFY_FAILED"):
    r2 = probe.classify(entry_ok(), facade(None, no_status_error), seat("NOMINAL", role="relay-nominal"))
    short = no_status_error.split(":")[0]
    check(
        f"T10 a facade with no status ({short}) is never NOMINAL",
        r2["verdict"] != "NOMINAL",
        f'{r2["verdict"]} ({no_status_error})',
    )

r2_refused = probe.classify(entry_ok(), facade(None, "refused"), seat("NOMINAL", role="relay-nominal"))
check(
    "T10 a REFUSED facade -> FACADE-UNRESPONSIVE, degraded, exit 1",
    r2_refused["verdict"] == "FACADE-UNRESPONSIVE" and r2_refused["degraded"] is True and r2_refused["exit_code"] == 1,
    str(r2_refused),
)
check(
    "T10 ... and the reason names the facade's own error",
    "refused" in r2_refused["reason"],
    r2_refused["reason"],
)
check(
    "T10 positive control: a facade that ANSWERS 401 keeps the verdict NOMINAL",
    probe.classify(entry_ok(), facade(401), seat("NOMINAL", role="relay-nominal"))["verdict"] == "NOMINAL",
    probe.classify(entry_ok(), facade(401), seat("NOMINAL", role="relay-nominal"))["verdict"],
)

# --- the seat's own detachment, with a healthy hub

detached = probe.classify(entry_ok(), facade(401), seat("AUTONOMOUS", "2026-10-30T09:36:59Z"))
check("a healthy hub + AUTONOMOUS seat -> SEAT-DETACHED", detached["verdict"] == "SEAT-DETACHED", detached["verdict"])

# --- T6: the seat's role vocabulary is not the hub's

check("T6 relay-autonomous maps to AUTONOMOUS", probe.seat_mode_from_role("relay-autonomous") == "AUTONOMOUS")
check("T6 relay-nominal maps to NOMINAL", probe.seat_mode_from_role("relay-nominal") == "NOMINAL")
check("T6 the hub's own role maps to no seat mode", probe.seat_mode_from_role("hub") is None)
check("T6 an unknown role maps to no seat mode", probe.seat_mode_from_role(None) is None)
check(
    "T6 the entry form requires role=hub (a seat's role is never it)",
    probe.entry_is_the_form(entry_sidecar()) is False,
    "a sidecar passed as the entry form",
)

# --- T7: a per-request line mentions a mode without being a transition

real_log = """2026-10-30T09:36:59.187Z [Relay] upstream http://192.168.0.50:3000 DOWN after 2 failure(s) (heartbeat) → AUTONOMOUS
2026-10-30T09:37:01.100Z [Relay] forward failed (hub HTTP 502) → this request served LOCALLY [1/2 before AUTONOMOUS]
2026-10-30T09:50:04.130Z [Relay] deep probe failed: TimeoutError: The operation timed out.
2026-10-30T10:32:23.853Z [Relay] upstream http://192.168.0.50:3000 healthy again → NOMINAL (relay resumed)
2026-10-30T10:52:47.762Z [ttft] model=glm-5.3 ttft=812ms
"""
scanned = probe.scan_relay_log(real_log)
check("T7 the last transition is the mode change, not a per-request line", scanned["last_transition_mode"] == "NOMINAL", str(scanned))
check("T7 the transition carries its timestamp", scanned["since"] == "2026-10-30T10:32:23.853Z", str(scanned["since"]))
check("T7 the last served request is dated", scanned["last_served"] == "2026-10-30T10:52:47.762Z", str(scanned["last_served"]))
only_autonomous = probe.scan_relay_log(
    "2026-10-30T09:36:59.187Z [Relay] upstream http://192.168.0.50:3000 DOWN after 2 failure(s) (heartbeat) → AUTONOMOUS"
)
check(
    "T7 an AUTONOMOUS transition is recognised on its own",
    only_autonomous["last_transition_mode"] == "AUTONOMOUS",
    str(only_autonomous),
)
check(
    "T7 a per-request failure line alone yields NO transition",
    probe.scan_relay_log("2026-10-30T09:37:01.100Z [Relay] forward failed (hub HTTP 502) → this request served LOCALLY [1/2 before AUTONOMOUS]")[
        "last_transition_mode"
    ]
    is None,
    "a per-request line was read as a transition",
)

# --- T8: a large --tail can render a BUSY log empty (measured on ai-01) ---

BUSY_LOG = (
    "2026-10-30T09:36:59.187Z [Relay] upstream http://192.168.0.50:3000 DOWN after 2 failure(s) (heartbeat) → AUTONOMOUS\n"
    "2026-10-30T10:32:23.853Z [Relay] upstream http://192.168.0.50:3000 healthy again → NOMINAL (relay resumed)\n"
    "2026-10-30T10:52:47.762Z [ttft] model=glm-5.3 ttft=812ms\n"
)


def fake_runner(mapping):
    """Pretend `docker logs`: the tail value selects the answer (None = no tail)."""

    def _run(cmd):
        tail = None
        if "--tail" in cmd:
            tail = int(cmd[cmd.index("--tail") + 1])
        return mapping.get(tail, "")

    return _run


def fake_health(role):
    def _probe(url, timeout=4.0):
        if role is None:
            return {"status": None, "error": "refused", "json": None, "elapsed_ms": 1}
        return {"status": 200, "error": None, "json": {"role": role, "uptimeSec": 1200}, "elapsed_ms": 1}

    return _probe


def no_tail_empty(container):
    return "", 0


laddered = probe.read_seat_mode(
    "claudish-sidecar",
    tail=20000,
    seat_url="http://127.0.0.1:3915",
    runner=fake_runner({20000: "", 5000: "", 1000: BUSY_LOG}),
    health_probe=fake_health("relay-nominal"),
    no_tail_reader=no_tail_empty,
)
check("T8 the ladder recovers a log a large --tail renders empty", laddered["since"] == "2026-10-30T10:32:23.853Z", str(laddered))
check("T8 the read names which tail answered", laddered["log_source"] == "--tail 1000", str(laddered.get("log_source")))
check("T8 the log is reported readable", laddered["log_readable"] is True and laddered["log_lines"] > 0, str(laddered))

direct = probe.read_seat_mode(
    "claudish-sidecar",
    tail=20000,
    seat_url="http://127.0.0.1:3915",
    runner=fake_runner({20000: BUSY_LOG}),
    health_probe=fake_health("relay-nominal"),
    no_tail_reader=no_tail_empty,
)
check("T8 positive control: a working large tail is used as-is", direct["log_source"] == "--tail 20000", str(direct.get("log_source")))

blind = probe.read_seat_mode(
    "claudish-sidecar",
    tail=20000,
    seat_url="http://127.0.0.1:3915",
    runner=fake_runner({}),
    health_probe=fake_health(None),
    no_tail_reader=no_tail_empty,
)
check("T8 an unreadable log is reported as such", blind["log_readable"] is False and blind["log_lines"] == 0, str(blind))
check("T8 an unreadable log claims no transition", blind["last_transition_mode"] is None and blind["since"] is None, str(blind))
blind_verdict = probe.classify(entry_ok(), facade(401), blind)
check("T8 unreadable seat log does not fabricate a detachment", blind_verdict["verdict"] == "NOMINAL", blind_verdict["verdict"])
check(
    "T8 ... and the facts say the log was unreadable",
    blind_verdict["facts"].get("seat_log_unreadable") is True,
    str(blind_verdict["facts"]),
)

detached_blind = probe.read_seat_mode(
    "claudish-sidecar",
    tail=20000,
    seat_url="http://127.0.0.1:3915",
    runner=fake_runner({}),
    health_probe=fake_health("relay-autonomous"),
    no_tail_reader=no_tail_empty,
)
check("T8 a live AUTONOMOUS role survives an unreadable log", detached_blind["mode"] == "AUTONOMOUS", str(detached_blind))
check(
    "T8 ... and the verdict follows the live role",
    probe.classify(entry_ok(), facade(401), detached_blind)["verdict"] == "SEAT-DETACHED",
    str(probe.classify(entry_ok(), facade(401), detached_blind)["verdict"]),
)

# --- RELAY_FALLBACK: a line whose arrow did not survive the encoding ---

for arrowless, expected in (
    ("2026-10-30T10:32:23.853Z [Relay] upstream http://x:3000 healthy again � NOMINAL (relay resumed)", "NOMINAL"),
    ("2026-10-30T09:36:59.187Z [Relay] upstream http://x:3000 DOWN after 2 failure(s) (heartbeat) � AUTONOMOUS", "AUTONOMOUS"),
):
    got_fallback = probe.scan_relay_log(arrowless)
    check(f"RELAY_FALLBACK: an arrowless line reads {expected}", got_fallback["last_transition_mode"] == expected, str(got_fallback))

check(
    "RELAY_FALLBACK: an arrowless per-request line still yields no transition",
    probe.scan_relay_log(
        "2026-10-30T09:37:01.100Z [Relay] forward failed (hub HTTP 502) � this request served LOCALLY [1/2 before AUTONOMOUS]"
    )["last_transition_mode"]
    is None,
    "a per-request line was read as a transition via the fallback",
)

# --- the probe layer itself is bounded and never raises

try:
    bad = probe.probe_http("http://127.0.0.1:1/health", timeout=0.5)
    check("a refused connection returns a result, not an exception", bad["status"] is None and bad["error"] is not None, str(bad))
except Exception as exc:  # pragma: no cover
    check("a refused connection returns a result, not an exception", False, f"raised {exc!r}")

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S):")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all pins green")
