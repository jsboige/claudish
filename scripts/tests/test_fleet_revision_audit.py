#!/usr/bin/env python3
"""Pins for scripts/fleet-revision-audit.py — which BUILD each seat runs (#1140).

No network, no docker: `classify()` and `seat_row()` are pure, so every state
is exercised by handing them a payload. Each pin carries a POSITIVE CONTROL —
the neighbouring state it must NOT be confused with — because a classifier
that answers "absent" for everything passes every negative assertion.

THE CONFUSIONS EACH PIN HOLDS (the wrong-but-plausible table it prevents):
  C1 `absent` (no #1143 in the image) vs `unknown` (built without the arg):
     different facts about the fleet; a rollout reader acts on each differently.
  C2 `unreachable` vs `absent`: a seat off this route is not an old image, and
     an unread seat never shows a field it did not read.
  C3 a short SHA vs a full one: the same commit, a prefix either way.
  C4 a branch name exported as the build arg is NOT a build.
  C5 an incomplete read (exit 2) must never be reported as "not deployed" (1).
  C6 only whitelisted payload fields may print: the /health body carries live
     request material.
  C7 an empty audit must never read as a green fleet.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import pathlib
import re
import sys
import time

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "fleet-revision-audit.py"

spec = importlib.util.spec_from_file_location("fleet_revision_audit", SCRIPT)
audit = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(audit)

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"ok - {name}")
    else:
        FAILURES.append(f"{name}: {detail}")
        print(f"not ok - {name}: {detail}")


# Synthetic throughout: no real SHA, id or address of the fleet.
FULL = "46a148f7a1b2c3d4e5f60718293a4b5c6d7e8f90"  # 40 hex
SHORT = FULL[:8]
OTHER = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
SEAT = "http://seat.invalid:3000"


def health(**extra) -> dict:
    """A `/health` payload carrying the #1143 fields."""
    payload = {
        "status": "ok",
        "role": "hub",
        "instanceId": "11111111-2222-4333-8444-555555555555",
        "uptimeSec": 68213,
    }
    payload.update(extra)
    return payload


def pre_1143(**extra) -> dict:
    """The measured shape of an image older than #1143: neither key exists."""
    payload = {
        "status": "ok",
        "activeStreams": 0,
        "pendingRequests": 0,
        "uptimeSec": 17064,
        "role": "relay-nominal",
        "upstream": "http://upstream.invalid:3000",
        "instanceId": "66666666-7777-4888-8999-aaaaaaaaaaaa",
    }
    payload.update(extra)
    return payload


def ok(payload, ms: int = 12) -> dict:
    return {"status": 200, "error": None, "json": payload, "elapsed_ms": ms}


def refused(error: str = "refused") -> dict:
    return {"status": None, "error": error, "json": None, "elapsed_ms": 3}


def row(payload=None, status: int | None = 200, expected=None, name: str = "hub") -> dict:
    """One seat row from a canned answer: status None = no HTTP answer."""
    if status is None:
        return audit.seat_row(name, SEAT, refused(), expected)
    body = payload if status == 200 else None
    return audit.seat_row(name, SEAT, {"status": status, "error": None, "json": body, "elapsed_ms": 5}, expected)


def stub(mapping=None, default=None, calls=None, delay=None):
    """A probe_fn standing in for hub-entry-probe's `probe_http`."""
    mapping = mapping or {}

    def fn(url, timeout=6.0):
        if calls is not None:
            calls.append(url)
        if delay:
            time.sleep(delay.get(url, 0))
        if url in mapping:
            return mapping[url]
        return default if default is not None else refused()

    return fn


def row_line(text: str, seat: str = "hub") -> str:
    """The table line of one seat (a line that starts with the seat's name)."""
    for line in text.splitlines():
        if line.startswith(seat + "  "):
            return line
    return ""


# --- deployed: the only state that names a build (the control for every pin below) ---

r = row(health(version="7.1.2", revision=FULL))
check("deployed: a full SHA", r["state"] == "deployed", str(r))
check("deployed ... the revision is carried as read", r["fields"]["revision"] == FULL, str(r["fields"]))
check("deployed ... with uptimeSec read as an int", r["uptimeSec"] == 68213, str(r["uptimeSec"]))
check("C3 deployed: a short SHA is a build too", row(health(revision=SHORT))["state"] == "deployed", str(row(health(revision=SHORT))))
check("deployed: an upper-case SHA is the same commit", row(health(revision=FULL.upper()))["state"] == "deployed", str(row(health(revision=FULL.upper()))))

# --- unknown vs absent (C1) ---

check("unknown: the key says unknown", row(health(version="7.1.2", revision="unknown"))["state"] == "unknown", str(row(health(version="7.1.2", revision="unknown"))))
check("unknown ... read case-insensitively", row(health(revision="UNKNOWN"))["state"] == "unknown", str(row(health(revision="UNKNOWN"))))
r = row(pre_1143())
check("absent: no revision key", r["state"] == "absent", str(r))
check("absent ... version and revision say absent, never a blank", r["fields"]["revision"] == "absent" and r["fields"]["version"] == "absent", str(r["fields"]))
check("absent ... the fields the payload DOES carry are read (control)", r["fields"]["role"] == "relay-nominal" and r["uptimeSec"] == 17064, str(r["fields"]))
check(
    "C1 absent and unknown are different states for payloads differing by two keys",
    row(pre_1143())["state"] != row(pre_1143(version="7.1.2", revision="unknown"))["state"],
    f"absent={row(pre_1143())['state']} unknown={row(pre_1143(version='7.1.2', revision='unknown'))['state']}",
)
check(
    "C1 ... and the two are different EXIT-neighbours of the same word: neither is deployed",
    audit.exit_code([row(pre_1143())]) == 1 and audit.exit_code([row(health(revision="unknown"))]) == 1,
    "",
)

# --- T4: role is printed, never interpreted ---

check("T4 a relay's role is carried as read", row(pre_1143(role="relay-autonomous"))["fields"]["role"] == "relay-autonomous", str(row(pre_1143(role="relay-autonomous"))["fields"]))
check("T4 ... and changes nothing about the build verdict", row(pre_1143(role="hub"))["state"] == "absent", str(row(pre_1143(role="hub"))))

# --- not-a-sha (C4) ---

for value, label in (
    ("main", "a branch name"),
    (FULL + "a", "41 hex chars"),
    ("46a148", "6 hex chars"),
    (1234567, "a JSON number whose digits are hex"),
    (["46a148f"], "a JSON array"),
    ({"sha": FULL}, "a JSON object"),
):
    r = row(health(revision=value))
    check(f"C4 not-a-sha: {label}", r["state"] == "not-a-sha", str(r))
    check(f"C4 not-a-sha: {label} ... the value is shown as read", r["fields"]["revision"] == str(value), str(r["fields"]))
check("C4 ... control: 7 hex chars IS a sha", row(health(revision="46a148f"))["state"] == "deployed", str(row(health(revision="46a148f"))))
check("C4 ... control: the same seven digits AS A STRING are a sha (the type is the difference)", row(health(revision="1234567"))["state"] == "deployed", str(row(health(revision="1234567"))))

# --- unreadable seats (C2) ---

r = row(status=None)
check("unreachable: no HTTP answer", r["state"] == "unreachable", str(r))
check("unreachable ... the failure is named", r["detail"] == "refused", str(r["detail"]))
check(
    "C2 unreachable ... and no field was invented (nothing was read)",
    all(v == "absent" for v in r["fields"].values()) and r["uptimeSec"] is None and r["match"] is None,
    str(r),
)
check("C2 ... control: an old image is absent, not unreachable", row(pre_1143())["state"] == "absent", str(row(pre_1143())))
check("error:503: an HTTP status other than 200", row(status=503)["state"] == "error:503", str(row(status=503)))
check("error:503 ... invents no field either", all(v == "absent" for v in row(status=503)["fields"].values()), str(row(status=503)))
for body, label in ((["not", "an", "object"], "a JSON array"), ("plain text", "a JSON string"), (None, "a body that did not parse")):
    got = audit.seat_row("hub", SEAT, {"status": 200, "error": None, "json": body, "elapsed_ms": 1})["state"]
    check(f"error:body: {label}", got == "error:body", got)
check("a None probe result is unreachable, never an exception", audit.seat_row("x", "http://y.invalid", None)["state"] == "unreachable", str(audit.seat_row("x", "http://y.invalid", None)))

# --- exit codes (C5) ---

check("exit 0: every seat deployed", audit.exit_code([row(health(revision=FULL)), row(health(revision=SHORT), name="relay")]) == 0, "")
check("exit 1: one seat unknown", audit.exit_code([row(health(revision=FULL)), row(health(revision="unknown"))]) == 1, "")
check("exit 1: one seat absent", audit.exit_code([row(health(revision=FULL)), row(pre_1143())]) == 1, "")
check("exit 1: one seat not-a-sha", audit.exit_code([row(health(revision=FULL)), row(health(revision="main"))]) == 1, "")
check("C5 exit 2 beats exit 1: an unreadable seat is an incomplete read", audit.exit_code([row(pre_1143()), row(status=None)]) == 2, "")
check("C5 ... the same table without the unreadable seat is exit 1", audit.exit_code([row(pre_1143())]) == 1, "")
check("C5 ... and with the unreadable seat DEPLOYED next to it, still 2", audit.exit_code([row(health(revision=FULL)), row(status=None)]) == 2, "")
check("exit 2: an error:body seat", audit.exit_code([audit.seat_row("h", SEAT, {"status": 200, "error": None, "json": [], "elapsed_ms": 1})]) == 2, "")

# --- --expect (C3) ---

check("expect: same full SHA", row(health(revision=FULL), expected=FULL)["match"] is True, str(row(health(revision=FULL), expected=FULL)))
check("C3 expect: the seat carries the full SHA, the caller names a short one", row(health(revision=FULL), expected=SHORT)["match"] is True, str(row(health(revision=FULL), expected=SHORT)))
check("C3 expect: the seat carries a short SHA, the caller names the full one", row(health(revision=SHORT), expected=FULL)["match"] is True, str(row(health(revision=SHORT), expected=FULL)))
near = SHORT[:7] + "b"  # shares 7 chars with SHORT, is not it
check("expect: a shared prefix that is not the same commit is no match", row(health(revision=FULL), expected=near)["match"] is False, str(row(health(revision=FULL), expected=near)))
check("expect: another build", row(health(revision=OTHER), expected=SHORT)["match"] is False, str(row(health(revision=OTHER), expected=SHORT)))
check("expect: nothing to compare on an absent seat is None, never False", row(pre_1143(), expected=SHORT)["match"] is None, str(row(pre_1143(), expected=SHORT)))
check("expect: nothing to compare on an unreadable seat is None", row(status=None, expected=SHORT)["match"] is None, str(row(status=None, expected=SHORT)))
check("expect: no expected SHA gives no match verdict", row(health(revision=FULL))["match"] is None, str(row(health(revision=FULL))))
check(
    "expect: a deployed seat on another build fails the audit (exit 1)",
    audit.exit_code([row(health(revision=OTHER), expected=SHORT)]) == 1,
    str(audit.exit_code([row(health(revision=OTHER), expected=SHORT)])),
)
check("expect: two seats on the expected build are exit 0", audit.exit_code([row(health(revision=FULL), expected=SHORT), row(health(revision=SHORT), expected=SHORT, name="relay")]) == 0, "")
check("expect: an unreadable seat stays exit 2 whatever the expectation", audit.exit_code([row(status=None, expected=SHORT)]) == 2, "")

# --- the whitelist (C6) ---

loaded = health(
    version="7.1.2",
    revision=FULL,
    proxyKeyPreviousHits={"sk-never-print-me": 2},
    upstream="http://upstream.invalid:3000",
    eventLoopMax60sMs=17,
)
rows = [audit.seat_row("hub", SEAT, ok(loaded))]
table = "\n".join(audit.render(rows))
blob = json.dumps(rows)
check("C6 the table prints the whitelisted fields (control)", FULL in table and "68213" in table and "7.1.2" in table, table)
for needle in ("sk-never-print-me", "proxyKeyPreviousHits", "eventLoopMax60sMs", "upstream.invalid"):
    check(f"C6 ... and never `{needle}`", needle not in table, table)
    check(f"C6 ... nor in the row that --json prints: `{needle}`", needle not in blob, blob)
check("C6 ... the whitelist is exactly the documented fields", tuple(rows[0]["fields"]) == audit.FIELDS and rows[0]["fields"]["status"] == "ok", str(tuple(rows[0]["fields"])))
check(
    "the table shows 8 chars of instanceId; --json keeps it whole",
    "11111111…" in table and "11111111…" not in blob and "11111111-2222-4333-8444-555555555555" in blob,
    table,
)

# --- uptimeSec (T2) ---

for value, label, wants_note in ((-12, "negative", True), (8 * 24 * 3600, "beyond 7 days", True), (68213, "plausible", False)):
    lines = audit.render([row(health(revision=FULL, uptimeSec=value))])
    noted = any("outside [0, 7 d]" in ln for ln in lines)
    check(f"T2 uptimeSec {label}: {'a note under the table' if wants_note else 'no note (control)'}", noted == wants_note, " | ".join(lines))
    check(f"T2 uptimeSec {label}: printed as read in its column", re.search(r"\s%s\s+deployed$" % value, row_line("\n".join(lines))) is not None, row_line("\n".join(lines)))
    check(f"T2 uptimeSec {label}: never turned into a start time", "started" not in "\n".join(lines) and "Z (" not in row_line("\n".join(lines)), " | ".join(lines))
lines = audit.render([row(health(revision=FULL, uptimeSec="not-a-number"))])
check("T2 a non-numeric uptimeSec prints '-' in its column and raises nothing", re.search(r"\s-\s+deployed$", row_line("\n".join(lines))) is not None, row_line("\n".join(lines)))
check("T2 ... and is None in the row", row(health(revision=FULL, uptimeSec="not-a-number"))["uptimeSec"] is None, str(row(health(revision=FULL, uptimeSec="not-a-number"))["uptimeSec"]))
r = row(pre_1143(uptimeSec=None))
check("T2 an absent uptimeSec prints '-' (an older image, or a stalled read)", r["uptimeSec"] is None and re.search(r"\s-\s+absent$", row_line("\n".join(audit.render([r])))) is not None, row_line("\n".join(audit.render([r]))))

# --- notes name the failure ---

lines = "\n".join(audit.render([row(status=None, name="relay"), audit.seat_row("s1", SEAT, {"status": 503, "error": None, "json": None, "elapsed_ms": 1})]))
check("a note names WHICH failure an unreachable seat had", "relay" in lines and "unreadable: refused" in lines, lines)
check("... a timeout reads timeout (never folded into refused)", "unreadable: timeout" in "\n".join(audit.render([audit.seat_row("x", SEAT, refused("timeout"))])), "")
check("a note names the HTTP status of an error seat", "HTTP/read failure: error:503" in lines, lines)

# --- a remote string is printed bounded, without control characters ---

text = "\n".join(audit.render([row(health(revision="\x1b[31mevil\x1b[0m"))]))
check("a revision carrying an escape sequence prints without the control characters", "\x1b" not in text and "not-a-sha" in text and "?[31mevil?[0m" in text, repr(text))
check("a remote string is bounded to 64 chars", len(row(health(revision="f" * 400))["fields"]["revision"]) == 64, str(len(row(health(revision="f" * 400))["fields"]["revision"])))
check("... control: 40 f's are a sha", row(health(revision="f" * 40))["state"] == "deployed", str(row(health(revision="f" * 40))))

# --- seat spec parsing ---

check("parse_seat: NAME=URL, trimmed", audit.parse_seat(" po-2028 = http://192.0.2.10:3000 ") == ("po-2028", "http://192.0.2.10:3000"), str(audit.parse_seat(" po-2028 = http://192.0.2.10:3000 ")))
check("parse_seat: an https URL is accepted", audit.parse_seat("wan=https://claudish.example/health-less")[1] == "https://claudish.example/health-less", "")
for bad, label in (
    ("po-2028", "no ="),
    ("=http://x.invalid", "no name"),
    ("po-2028=", "no url"),
    ("po-2028=ftp://x.invalid", "a non-http scheme"),
    ("po-2028=x.invalid:3000", "a bare host:port"),
):
    try:
        audit.parse_seat(bad)
        check(f"parse_seat refuses {label}", False, bad)
    except ValueError as exc:
        check(f"parse_seat refuses {label}", str(exc) != "", "")


# --- audit(): concurrent, order kept, one seat's failure is its own row ---

calls: list[str] = []
rows = audit.audit(
    [("a", "http://a.invalid:3000"), ("b", "http://b.invalid:3000"), ("c", "http://c.invalid:3000")],
    probe_fn=stub(
        {
            "http://a.invalid:3000/health": ok(health(revision=FULL)),
            "http://b.invalid:3000/health": ok(pre_1143()),
        },
        default=refused("timeout"),
        calls=calls,
        delay={"http://a.invalid:3000/health": 0.08},
    ),
)
check("audit: one probe per seat, on /health", sorted(calls) == ["http://a.invalid:3000/health", "http://b.invalid:3000/health", "http://c.invalid:3000/health"], str(calls))
check("audit: rows keep the caller's seat order whatever the answer order", [x["seat"] for x in rows] == ["a", "b", "c"], str([x["seat"] for x in rows]))
check("audit: the states follow the answers", [x["state"] for x in rows] == ["deployed", "absent", "unreachable"], str([x["state"] for x in rows]))
check("audit: a timeout is named as a timeout", rows[2]["detail"] == "timeout", str(rows[2]))


def raising(url, timeout=6.0):
    raise RuntimeError("boom")


rows = audit.audit([("x", "http://x.invalid:3000")], probe_fn=raising)
check("audit: a probe that raises becomes an unreachable row naming the exception", rows[0]["state"] == "unreachable" and "RuntimeError" in (rows[0]["detail"] or ""), str(rows))
check("audit: an empty seat list gives an empty table without raising", audit.audit([], probe_fn=stub()) == [] and audit.render([])[0].startswith("fleet revision audit"), str(audit.render([])))


# --- main(): end to end with the stub probe ---

def run_main(argv, probe_fn=None, local_url_fn=None):
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        code = audit.main(argv, probe_fn=probe_fn, local_url_fn=local_url_fn, stream=out)
    return code, out.getvalue(), err.getvalue()


HUB = audit.DEFAULT_HUB + "/health"
RELAY = audit.DEFAULT_RELAY + "/health"
S1 = "http://192.0.2.10:3000/health"

calls = []
probe = stub({HUB: ok(health(version="7.1.2", revision=FULL)), RELAY: ok(pre_1143())}, calls=calls)
code, out, err = run_main(["--json"], probe)
doc = json.loads(out)
check("main: the defaults are the hub and the relay, each probed once", [s["seat"] for s in doc["seats"]] == ["hub", "relay"] and sorted(calls) == sorted([HUB, RELAY]), out)
check("main: hub deployed + relay absent is exit 1", code == 1 and doc["exit"] == 1, f"{code} {out}")
check("main --json: carries the reader clock (UTC) and the rows", re.match(r"^2026-\d\d-\d\dT\d\d:\d\d:\d\dZ$", doc["generatedAt"]) is not None and len(doc["seats"]) == 2, out)
check("main --json: the default URLs are the documented ones", audit.DEFAULT_HUB == "http://192.168.0.50:3000" and audit.DEFAULT_RELAY == "http://192.168.0.46:3000", f"{audit.DEFAULT_HUB} {audit.DEFAULT_RELAY}")

code, out, err = run_main(["--json", "--expect", SHORT], probe)
doc = json.loads(out)
check("main --expect: the hub matches, the relay is not-comparable", code == 1 and doc["seats"][0]["match"] is True and doc["seats"][1]["match"] is None and doc["expect"] == SHORT, out)

calls = []
probe = stub({HUB: ok(health(revision=FULL)), RELAY: ok(health(revision=FULL)), S1: ok(health(revision=OTHER))}, calls=calls)
code, out, err = run_main(["--seat", "s1=http://192.0.2.10:3000", "--expect", SHORT], probe)
check("main --seat: added to the defaults (3 probed)", len(calls) == 3 and S1 in calls, str(calls))
check("main --expect: a seat on another build is exit 1 with the counts on the table", code == 1 and "differ 1" in out and "match 2" in out, out)
check("main (text): the verdict line carries the exit and the per-state counts", out.splitlines()[-2].startswith("exit 1 — 2/3 deployed") and "differ 1" in out, out)
code, out, err = run_main(["--no-defaults", "--seat", "hub=http://192.0.2.10:3000", "--json"], probe)
check("main --no-defaults: only the named seat is probed", len(json.loads(out)["seats"]) == 1, out)
code, out, err = run_main(["--no-defaults"], probe)
check("C7 main: no seat at all is a usage error (exit 2), never a green fleet", code == 2 and out == "" and "no seat to audit" in err, f"{code} | {out} | {err}")

for argv, label in (
    (["--seat", "broken"], "a malformed seat spec"),
    (["--seat", "hub=http://192.0.2.10:3000"], "a seat name that shadows a default"),
    (["--seat", "a=http://192.0.2.1:3000", "--seat", "a=http://192.0.2.2:3000"], "a duplicate seat name"),
    (["--expect", "not-a-sha"], "a malformed --expect"),
    (["--expect", "12345"], "a too-short --expect"),
):
    calls = []
    code, out, err = run_main(argv, stub({}, calls=calls))
    check(f"main: {label} is refused before any probe (exit 2)", code == 2 and out == "" and calls == [], f"{code} | {out} | {calls} | {err}")
    check(f"main: {label} ... with a reason on stderr", err.strip() != "", repr(err))

LOCAL = "http://127.0.0.1:3915/health"
calls = []
probe = stub({HUB: ok(health(revision=FULL)), RELAY: ok(health(revision=FULL)), LOCAL: ok(health(role="relay-nominal", revision=SHORT))}, calls=calls)
code, out, err = run_main(["--local", "--json", "--expect", SHORT], probe, local_url_fn=lambda container: "http://127.0.0.1:3915")
doc = json.loads(out)
check("main --local: the seat's own sidecar is discovered and probed", LOCAL in calls and doc["seats"][-1]["seat"] == "local", out)
check("main --local: ... and the table is exit 0 when it carries the build", code == 0, out)
code, out, err = run_main(["--local", "--json"], probe, local_url_fn=lambda container: None)
doc = json.loads(out)
check("main --local: an undiscoverable port is a reader failure (exit 2), named", code == 2 and doc["exit"] == 2 and doc["seats"][-1]["state"] == "error:no-endpoint", out)
check("main --local ... the two readable seats are still in the table (not lost to the failure)", len(doc["seats"]) == 3 and doc["seats"][0]["state"] == "deployed", out)
code, out, err = run_main(["--local"], probe, local_url_fn=lambda container: None)
check("main --local ... and the text table counts it as unreadable with its note", "error:no-endpoint 1" in out and "HTTP/read failure: error:no-endpoint" in out, out)
check("main --local ... --json carries no verdict line (counts live in the text table only)", "error:no-endpoint 1" not in json.dumps(doc), "")

# --- the real reader is wired (sibling import) ---

check("the real probe_http and local_sidecar_url are imported from hub-entry-probe.py", audit._PROBE_HTTP is not None and audit._LOCAL_SIDECAR_URL is not None, "sibling unreadable")
try:
    bad = audit._PROBE_HTTP("http://127.0.0.1:1/health", timeout=0.5)
    check("the real reader: a closed port returns a result, not an exception", bad["status"] is None and bad["error"] is not None, str(bad))
    check("the real reader ... which the audit reads as unreachable, exit 2", audit.seat_row("x", "http://127.0.0.1:1", bad)["state"] == "unreachable", str(audit.seat_row("x", "http://127.0.0.1:1", bad)))
except Exception as exc:  # pragma: no cover
    check("the real reader: a closed port returns a result, not an exception", False, f"raised {exc!r}")

# --- a console that cannot encode the table's "…" / "—" / "·" degrades, never raises ---

real_stdout = sys.stdout
sink = io.BytesIO()
wrapper = io.TextIOWrapper(sink, encoding="ascii", errors="strict")  # a code page without them
sys.stdout = wrapper  # `wrapper` stays referenced: dropping it would close the sink
boom = None
code = None
try:
    code = audit.main(["--no-defaults", "--seat", "hub=http://192.0.2.10:3000"], stub({S1: ok(health(revision=FULL))}))
except Exception as exc:  # the pin below reports it — a crash is not a verdict
    boom = repr(exc)
finally:
    sys.stdout = real_stdout
wrapper.flush()  # a block-buffered pipe holds its text until flushed (as at interpreter exit)
text = sink.getvalue().decode("ascii")
check("a console code page without the table's punctuation prints '?' in their place, never raises", code == 0 and boom is None and "11111111?" in text and "exit 0" in text, f"{boom} | {text}")
check("... and the ASCII that the code page CAN carry is intact", boom is None and "fleet revision audit" in text and FULL in text and "deployed" in text, text)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S):")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all pins green")
