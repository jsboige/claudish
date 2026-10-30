#!/usr/bin/env python3
"""hub-entry-probe.py — is the fleet-facing entry form up, and WHICH layer is down?

WHY THIS EXISTS (measured 2026-10-30, po-2024, seat claudish):
the fleet entry form (the published hub port) was unreachable for ~55 min
(09:26:48Z -> 10:32:23Z, measured from a seat's own relay log); the WAN facade
answered 502 throughout; the hub container was restarted at 10:32:01Z. Nothing
on any seat SAID so, because no instrument answers "is the entry form up?":
the traffic instruments count requests (and the MCP `claudish_traffic` renders
a false GAP on a healthy relay sidecar), `fleet-matrix.ps1` describes the LOCAL
seat, `seat-readiness-audit.ps1` answers "would this seat survive the hub
dying" (static), `claudish-mode-watch.ps1` persists the local role over time.
The path itself was unmonitored. This probes it, in layers, from any seat.

THE POINT OF THE LAYERS (this is the whole reason for two probes):
a 502 from the WAN facade is NOT proof that the hub process is dead — the ARR
rewrite may point somewhere else, the socket may be orphaned (30/09 incident),
the firewall may have moved. Probing the published port directly says which
layer answers. One probe cannot tell "hub down" from "path down"; that
distinction decides who gets paged.

LAYERS
  L1 entry   the published hub port (the fleet-facing form, docs/reference/
             relay-internals.md §"Stable entry form"): GET /health -> role=hub.
  L2 facade  the WAN facade in front of it: GET /v1/models. A 502/503/504 here
             with L1 alive = the facade's forwarder is broken, not the hub.
  L3 seat    this seat's own relay mode — read LIVE from the seat's own
             /health (role=relay-nominal|relay-autonomous), with the date of
             the last transition read from the local container log. It dates
             the outage: "down since 09:36Z" is actionable, "down" is not.

VERDICTS
  NOMINAL            L1 answers 200 with role=hub, and (if probed) L2 is not a
                     gateway error, and (if probed) the seat is still relaying.
  ENTRY-DOWN         L1 unreachable AND L2 is a gateway error -> the fleet
                     entry form does not serve. ESCALATE (fleet rule: an outage
                     detected is an outage escalated in the SAME cycle).
  PATH-BROKEN        L1 unreachable but L2 answers (2xx/4xx) -> the hub answers
                     the facade but not the published port: the break is between
                     them (forwarder/port/socket/firewall), not the hub process.
  FACADE-502-ONLY    L1 alive but L2 is a gateway error -> the hub is fine, the
                     facade's forwarder is not (an ARR/port change).
  SEAT-DETACHED      L1 alive, L2 fine, but this seat's relay is AUTONOMOUS ->
                     the seat stopped forwarding while the hub is healthy
                     (stuck hysteresis, key mismatch): it serves locally and
                     looks healthy while the fleet is not.
  UNKNOWN            a probe was inconclusive (no status, timeout) -> exit 2.
                     Absence of signal is not a signal.

EXIT CODES
  0 NOMINAL · 1 degraded (any other verdict) · 2 UNKNOWN or usage error.

TRAPS (each one produces a wrong-but-plausible answer if you skip it):
  T1 A gateway error from the facade alone would be reported as "the hub is
     down" — wrong when the hub is alive and the forwarder moved. L1 decides.
  T2 A SIDECAR's /health answers role=relay-nominal, not role=hub. Probing the
     wrong port and reading `role` concludes "the entry form is a sidecar" or
     worse, "the hub is a sidecar". L1 only counts when role == "hub".
  T3 `uptimeSec` is computed inside the container (Date.now() - start) and is
     therefore NOT immune to a host wall-clock step: after a clock jump it can
     read absurdly (negative, or hours off). It is reported, never used to
     derive a start time, and a value outside [0, 7d] is flagged.
  T4 `docker logs --since` serves the OLD file after a rotation and says
     nothing. The seat layer therefore reads `--tail` only (the last N lines
     are never a rotated-away segment) and never filters by a time window.
  T5 Reading the hub's /health body wholesale would print whatever the proxy
     exposes (headers of in-flight requests live in sibling fields). Only
     whitelisted fields are ever printed.
  T6 The seat's role vocabulary is NOT the hub's: the hub answers role=hub, a
     sidecar answers role=relay-nominal|relay-autonomous. Reading the seat's
     role as the entry form's would make the probe call a sidecar "the hub".
  T7 A per-request relay line ("→ this request served LOCALLY [1/2 before
     AUTONOMOUS]") MENTIONS a mode without BEING a transition. Reading those
     as transitions dates the outage to a per-request failure instead of the
     mode change, and the report then claims a transition that never happened.

READ-ONLY: HTTP GETs, one bounded `docker logs --tail`, no writes, no
secrets (hosts, statuses, verdicts and timestamps only).

Usage:
  python scripts/hub-entry-probe.py
  python scripts/hub-entry-probe.py --facade https://models.myia.io/v1/models --json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request

DEFAULT_ENTRY = "http://192.168.0.50:3000"
DEFAULT_FACADE = "https://models.myia.io/v1/models"
DEFAULT_CONTAINER = "claudish-sidecar"

# T2: only role=hub is the fleet-facing entry form.
ENTRY_ROLE = "hub"
GATEWAY_ERRORS = (502, 503, 504)
# T3: outside this range, uptimeSec is not a duration.
MAX_PLAUSIBLE_UPTIME_SEC = 7 * 24 * 3600

RELAY_TRANSITION_RE = re.compile(r"(?:→|->)\s*(NOMINAL|AUTONOMOUS)\b")
# Fallback for a log whose arrow did not survive the encoding.
RELAY_FALLBACK = (("healthy again", "NOMINAL"), ("DOWN after", "AUTONOMOUS"))
TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)")


def scan_relay_log(text: str) -> dict:
    """Read the seat's relay log: last TRANSITION (mode + when), last served.

    T7: a transition carries the arrow and a mode name. The per-request lines
    ("→ this request served LOCALLY [1/2 before AUTONOMOUS]") mention a mode
    without being one — reading them as transitions dates the outage to the
    wrong second.
    """
    mode = None
    since = None
    last_served = None
    for line in text.splitlines():
        ts = TS_RE.match(line)
        stamp = ts.group(1) if ts else None
        if "[ttft]" in line:
            last_served = stamp or last_served
        if "[Relay]" not in line or "served LOCALLY" in line:
            continue
        found = RELAY_TRANSITION_RE.search(line)
        if found:
            mode, since = found.group(1), stamp or since
            continue
        for needle, fallback_mode in RELAY_FALLBACK:
            if needle in line:
                mode, since = fallback_mode, stamp or since
                break
    return {"last_transition_mode": mode, "since": since, "last_served": last_served}


def probe_http(url: str, timeout: float = 6.0) -> dict:
    """GET url, bounded. Never raises. Returns {status, error, json, elapsed_ms}."""
    import time

    req = urllib.request.Request(url, headers={"User-Agent": "claudish-hub-entry-probe/1"})
    started = time.monotonic()
    status: int | None = None
    body = b""
    error: str | None = None
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.getcode()
            body = resp.read(8192)
    except urllib.error.HTTPError as exc:
        status = exc.code  # a 502 IS a measurement, not a failure
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, ConnectionRefusedError):
            error = "refused"
        elif isinstance(reason, socket.timeout):
            error = "timeout"
        else:
            error = f"{type(reason).__name__}: {str(reason)[:120]}"
    except Exception as exc:  # never let a probe break a cycle
        error = f"{type(exc).__name__}: {str(exc)[:120]}"
    payload = None
    if body:
        try:
            payload = json.loads(body.decode("utf-8", "replace"))
        except Exception:
            payload = None
    return {
        "status": status,
        "error": error,
        "json": payload,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


def local_sidecar_url(container: str) -> str | None:
    """The seat's own sidecar URL, from the published port of its container.

    Seat-agnostic on purpose: the host port differs from seat to seat (3915
    here, 3914 elsewhere), so a hardcoded one would silently probe nothing.
    """
    try:
        proc = subprocess.run(
            ["docker", "port", container, "3000/tcp"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
    except Exception:
        return None
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        port = line.split()[-1].rsplit(":", 1)[-1]
        if port.isdigit():
            return f"http://127.0.0.1:{port}"
    return None


def seat_mode_from_role(role: str | None) -> str | None:
    """The SEAT's role vocabulary is not the hub's (T6).

    The hub answers role=hub; a sidecar answers role=relay-nominal or
    role=relay-autonomous. Reading the seat's role as if it were the entry
    form's would make the probe call a seat "the hub".
    """
    if role == "relay-autonomous":
        return "AUTONOMOUS"
    if role == "relay-nominal":
        return "NOMINAL"
    return None


def read_seat_mode(container: str, tail: int = 20000, seat_url: str | None = None) -> dict | None:
    """Current relay mode of this seat, plus the date of the last transition.

    Two sources, deliberately:
      - the seat's OWN /health is authoritative for the CURRENT mode (it is
        live; the log is a history that a busy seat outruns);
      - the container log gives WHEN the last transition happened — that date
        is what turns "the fleet is down" into "the fleet has been down since
        09:36:59Z". T4: `--tail` only, never `--since` (a rotated segment
        would be served silently).
    """
    url = seat_url or local_sidecar_url(container)
    role = None
    if url:
        live = probe_http(f"{url.rstrip('/')}/health", timeout=4.0)
        payload = live.get("json")
        if isinstance(payload, dict):
            role = payload.get("role")
    mode = seat_mode_from_role(role)

    last_transition_mode = None
    since = None
    last_served = None
    try:
        proc = subprocess.run(
            ["docker", "logs", "--tail", str(tail), "-t", container],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except Exception:
        proc = None
    if proc is not None:
        out = proc.stdout or ""
        if not out.strip():
            out = proc.stderr or ""
        scanned = scan_relay_log(out)
        last_transition_mode = scanned["last_transition_mode"]
        since = scanned["since"]
        last_served = scanned["last_served"]
    if mode is None and last_transition_mode is None and last_served is None:
        return None
    return {
        "mode": mode or last_transition_mode,
        "since": since,
        "last_served": last_served,
        "role": role,
        "url": url,
        "last_transition_mode": last_transition_mode,
    }


def entry_is_the_form(entry: dict) -> bool:
    """T2: a sidecar answers role=relay-nominal; only role=hub is the form."""
    if entry.get("status") != 200:
        return False
    payload = entry.get("json")
    return isinstance(payload, dict) and payload.get("role") == ENTRY_ROLE


def classify(entry: dict, facade: dict | None = None, seat: dict | None = None) -> dict:
    """Pure: layers in, verdict out. No I/O — this is what the pins exercise."""
    facts: dict = {}
    form_alive = entry_is_the_form(entry)

    if entry.get("status") is not None:
        facts["entry_status"] = entry["status"]
    if entry.get("error"):
        facts["entry_error"] = entry["error"]
    payload = entry.get("json")
    if isinstance(payload, dict):
        # T5: whitelist only.
        for key in ("role", "instanceId", "uptimeSec"):
            if key in payload:
                facts[key] = payload[key]
        up = payload.get("uptimeSec")
        # T3: reported, never used to derive a start time; flagged when absurd.
        if isinstance(up, (int, float)) and not (0 <= up <= MAX_PLAUSIBLE_UPTIME_SEC):
            facts["uptimeSec_implausible"] = True
    if facade is not None:
        facts["facade_status"] = facade.get("status")
        if facade.get("error"):
            facts["facade_error"] = facade["error"]
    if seat is not None:
        facts["seat_mode"] = seat.get("mode")
        facts["seat_mode_since"] = seat.get("since")
        facts["seat_last_served"] = seat.get("last_served")

    facade_gw = bool(facade is not None and facade.get("status") in GATEWAY_ERRORS)
    facade_answers = bool(
        facade is not None and facade.get("status") is not None and not facade_gw
    )

    if form_alive:
        if facade_gw:
            verdict, reason = (
                "FACADE-502-ONLY",
                "the hub answers its published port but the WAN facade returns a "
                "gateway error: the forwarder in front of it is broken",
            )
        elif seat is not None and seat.get("mode") == "AUTONOMOUS":
            verdict, reason = (
                "SEAT-DETACHED",
                "the hub is healthy but this seat stopped forwarding "
                "(relay AUTONOMOUS): it serves locally and looks healthy",
            )
        else:
            verdict, reason = ("NOMINAL", "the fleet entry form answers and the seat still relays")
    else:
        if facade_gw:
            verdict, reason = (
                "ENTRY-DOWN",
                "the published hub port does not answer and the WAN facade "
                "returns a gateway error: the fleet entry form is down",
            )
        elif facade_answers:
            verdict, reason = (
                "PATH-BROKEN",
                "the published hub port does not answer but the WAN facade does: "
                "the break is on the path, not in the hub process",
            )
        else:
            verdict, reason = (
                "UNKNOWN",
                "no layer gave a verdict (no status, timeout): absence of signal "
                "is not a signal",
            )

    degraded = verdict != "NOMINAL"
    return {
        "verdict": verdict,
        "reason": reason,
        "degraded": degraded,
        "exit_code": 0 if verdict == "NOMINAL" else (1 if verdict != "UNKNOWN" else 2),
        "facts": facts,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--hub", default=os.environ.get("CLAUDISH_RELAY_UPSTREAM") or DEFAULT_ENTRY)
    ap.add_argument("--facade", default=DEFAULT_FACADE)
    ap.add_argument("--no-facade", action="store_true", help="skip the WAN layer")
    ap.add_argument("--container", default=DEFAULT_CONTAINER)
    ap.add_argument("--seat-url", default=None, help="the seat's own sidecar URL (default: read from the container's published port)")
    ap.add_argument("--no-seat", action="store_true", help="skip the local relay-mode layer")
    ap.add_argument("--timeout", type=float, default=6.0)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    entry = probe_http(f"{args.hub.rstrip('/')}/health", timeout=args.timeout)
    facade = None
    if not args.no_facade:
        facade = probe_http(args.facade, timeout=args.timeout)
    seat = None
    if not args.no_seat:
        seat = read_seat_mode(args.container, seat_url=args.seat_url)

    result = classify(entry, facade, seat)
    result["entry_url"] = args.hub
    if facade is not None:
        result["facade_url"] = args.facade
    result["at_utc"] = _now_iso()

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        facts = result["facts"]
        print(f"[hub-entry] {result['verdict']} — {result['reason']}")
        print(
            f"[hub-entry] entry={args.hub} status={facts.get('entry_status', '-')}"
            f" role={facts.get('role', '-')} instance={str(facts.get('instanceId', '-'))[:8]}"
            f" uptimeSec={facts.get('uptimeSec', '-')}"
            f" err={facts.get('entry_error', '-')}"
        )
        if facade is not None:
            print(
                f"[hub-entry] facade={args.facade} status={facts.get('facade_status', '-')}"
                f" err={facts.get('facade_error', '-')}"
            )
        if seat is not None:
            print(
                f"[hub-entry] seat mode={facts.get('seat_mode', '-')}"
                f" since={facts.get('seat_mode_since', '-')}"
                f" last_served={facts.get('seat_last_served', '-')}"
            )
    return result["exit_code"]


def _now_iso() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


if __name__ == "__main__":
    sys.exit(main())
