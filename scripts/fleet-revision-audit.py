#!/usr/bin/env python3
"""fleet-revision-audit.py — which BUILD does each claudish node actually run?

WHY THIS EXISTS (#1140, fleet-rollout rule of 2026-09-12): "the container
moved" is not "the fleet migrated". A fleet-affecting change declared DONE
needs a measured per-consumer artifact that names the build it probed. On this
fork `/health`'s `version` cannot do it — it has read "7.1.2" since 2026-05
across a thousand commits, because deploys go through `docker compose build`
and never a release bump. #1143 therefore added `revision`: the git SHA the
IMAGE was built from, baked at build time (`CLAUDISH_REVISION` build arg ->
`generate-version.ts` -> `version.ts`, fed from compose `build.args`). No
runtime env can change it, by design.

One bounded GET /health per named seat, then ONE table. Nothing else is
consulted for the build:

  T1  The OCI image label `org.opencontainers.image.revision` is NOT the
      build. Measured twice — po-2023 relay (26/11, #1140) and po-2024 sidecar
      (27/11): it reads bun's commit (0d9b296a...). The label comes with the
      base image (`FROM oven/bun:1.3-alpine`) and this Dockerfile declares no
      LABEL, so an image rebuilt from main carries the same foreign value
      under the same key.

STATES — what was READ, never what was intended:
  deployed       7..40 hex chars. The image carries #1143 and was built with
                 the arg. The only state that names a build.
  unknown        the key says "unknown". The image carries #1143 but was built
                 without the arg. Measured on the hub (25/11): a RECREATE of
                 such an image keeps answering unknown — the value is baked at
                 build time, so only a BUILD delivers it.
  absent         no `revision` value — the shape of an image older than #1143
                 (measured 26/11 on the po-2023 relay and the po-2024 sidecar,
                 both on images built 18/11; a `replatform/v14` image answers
                 this too, its /health route carries no #1140).
  not-a-sha      the key carries something that is not a commit SHA: a branch
                 name exported as the arg, or a non-string. Shown as read; it
                 can never count as deployed (only a STRING names a commit —
                 the number 1234567 stringifies to seven hex digits).
  unreachable    no HTTP answer before the timeout (refused, timeout, DNS,
                 TLS...). A seat off this network's route reads here — it is
                 NOT "absent", and the note names which failure it was.
  error:<code>   an HTTP status other than 200 (`error:503`); `error:body` for
                 a 200 whose body is not a JSON object; `error:no-endpoint`
                 when `--local` could not discover the container's port.

  `absent` and `unknown` are different facts and must not be merged: one says
  "older than the field", the other "newer than the field, built without the
  arg". A fleet table that folds them tells a rollout reader the wrong story.

EXIT CODES
  0  every seat is `deployed` (and equals `--expect` when given)
  1  at least one seat is not `deployed`, or is not the expected build
  2  at least one seat could not be READ (unreachable / error:*) — the table
     is INCOMPLETE, so it proves nothing about the fleet. Exit 2 wins over 1.
     Usage errors are 2 as well.

TRAPS
  T2  `uptimeSec` is computed inside the container and is not immune to a host
      clock step (hub-entry-probe.py T3): it is printed as read, never turned
      into a start time. A value outside [0, 7 d] gets a note under the table.
  T3  The /health body carries live request material
      (`proxyKeyPreviousHits`, gauges of in-flight work). Only a whitelist is
      ever printed: status, role, version, revision, instanceId, uptimeSec.
  T4  `role` is printed, never interpreted: a relay answers
      `relay-nominal`/`relay-autonomous`, a hub answers `hub`
      (hub-entry-probe.py T6). Reading a relay's role as the hub's is how a
      probe calls a sidecar "the entry form".
  T5  A seat name is the caller's label. Two seats may share an endpoint after
      a migration; the table names what was probed by its endpoint as well.

READ-ONLY: HTTP GETs on /health, plus one read-only `docker port` under
`--local`. No writes, no secrets, no actuator.

Usage:
  python scripts/fleet-revision-audit.py                  # hub + relay
  python scripts/fleet-revision-audit.py --local           # + this seat's sidecar
  python scripts/fleet-revision-audit.py --seat po-2028=http://192.168.0.60:3000
  python scripts/fleet-revision-audit.py --no-defaults --seat hub=http://x:3000
  python scripts/fleet-revision-audit.py --expect <sha> --json
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import importlib.util
import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))

# The two seats the work order names. A sidecar's LAN address is seat- and
# network-dependent, so it is never guessed: pass --seat NAME=URL for those.
DEFAULT_HUB = "http://192.168.0.50:3000"
# po-2023's published port, the literal docs/deployment/fleet-state.md records
# (VERIFIED 07/09 from ai-01's /health). A sidecar's port is discovered, not
# guessed — see --local.
DEFAULT_RELAY = "http://192.168.0.46:3000"
DEFAULT_SEATS = (("hub", DEFAULT_HUB), ("relay", DEFAULT_RELAY))
DEFAULT_CONTAINER = "claudish-sidecar"
# A seat's sidecar answers 3000/tcp under one of two names, and which one is a
# property of the seat, not of the audit: `claudish-sidecar` on the sidecar
# seats, `claudish-proxy` on po-2023's relay. Probing a single name turns
# "my container is called something else" into `error:no-endpoint`, which reads
# as "this seat has no build" (#1140, po-2023's reserve of 28/11).
LOCAL_CONTAINER_NAMES = (DEFAULT_CONTAINER, "claudish-proxy")

# #1143's field carries `git rev-parse HEAD` (40 hex) or a short SHA as the
# build script passed it; anything else is not a commit.
SHA_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")
# T3 — the only fields that may reach the output, in table order.
FIELDS = ("status", "role", "version", "revision", "instanceId", "uptimeSec")
# T2 — outside this range, uptimeSec is not a plausible duration.
MAX_PLAUSIBLE_UPTIME_SEC = 7 * 24 * 3600
# A remote string is printed bounded and without control characters.
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _load_sibling_probe():
    """`hub-entry-probe.py`'s bounded HTTP reader and docker-port discovery.

    One copy, on purpose: both scripts must agree on what "refused" vs
    "timeout" is, and on how the seat's own sidecar URL is discovered (the
    published port differs per seat — 3915 here, 3914 elsewhere — so a
    hardcoded one would silently probe nothing). Returns (probe_http,
    local_sidecar_url), or (None, None) when the sibling is unreadable: that
    is a READER failure (exit 2), never a tracedback.
    """
    path = os.path.join(_HERE, "hub-entry-probe.py")
    try:
        spec = importlib.util.spec_from_file_location("hub_entry_probe", path)
        if spec is None or spec.loader is None:
            return None, None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.probe_http, module.local_sidecar_url
    except Exception:  # noqa: BLE001 - an unreadable sibling is a verdict
        return None, None


_PROBE_HTTP, _LOCAL_SIDECAR_URL = _load_sibling_probe()


def readable(value, limit: int = 64) -> str:
    """A string read from a remote endpoint, safe to print."""
    return _CTRL_RE.sub("?", str(value))[:limit]


def classify(payload, expected: str | None = None) -> dict:
    """One parsed /health payload -> what it says about the build. Pure.

    Returns {state, fields, uptimeSec, match}. `fields` carries what was READ
    per whitelisted key, `absent` for a key the payload does not have —
    never a guess. `match` is True/False only when an expected SHA was given
    AND the seat names a build; None otherwise (nothing to compare).
    """
    fields = {}
    for key in FIELDS:
        value = payload.get(key) if isinstance(payload, dict) else None
        fields[key] = "absent" if value is None else readable(value)

    raw_revision = payload.get("revision") if isinstance(payload, dict) else None
    revision = fields["revision"]
    if revision == "absent":
        state = "absent"
    elif revision.lower() == "unknown":
        state = "unknown"
    elif isinstance(raw_revision, str) and SHA_RE.match(revision):
        state = "deployed"
    else:
        # Only a STRING can name a commit: a JSON number 1234567 stringifies
        # to seven hex digits and would pass the pattern above.
        state = "not-a-sha"

    match = None
    if expected and state == "deployed":
        got, want = revision.lower(), expected.lower()
        # A seat may carry the full SHA while the caller names a short one, or
        # the reverse: a prefix either way is the same commit.
        match = got.startswith(want) or want.startswith(got)

    raw_uptime = fields["uptimeSec"]
    uptime = None
    if raw_uptime != "absent":
        try:
            uptime = int(raw_uptime)
        except ValueError:
            uptime = None

    return {"state": state, "fields": fields, "uptimeSec": uptime, "match": match}


def seat_row(name: str, url: str, probe_result, expected: str | None = None) -> dict:
    """The full row for one seat from a probe_http result. Pure, never raises."""
    row = {
        "seat": name,
        "endpoint": url,
        "detail": None,
        "elapsedMs": (probe_result or {}).get("elapsed_ms"),
    }
    # Start from "every field absent" so an unreadable seat never borrows a
    # value it did not read (an unread seat with a revision from nowhere would
    # be the exact failure this instrument exists to prevent).
    row.update(classify({}, expected))
    if not probe_result or probe_result.get("status") is None:
        row["state"] = "unreachable"
        row["detail"] = readable((probe_result or {}).get("error") or "no answer", 120)
        return row
    if probe_result["status"] != 200:
        row["state"] = f"error:{probe_result['status']}"
        return row
    payload = probe_result.get("json")
    if not isinstance(payload, dict):
        row["state"] = "error:body"
        return row
    row.update(classify(payload, expected))
    return row


def unreadable(row: dict) -> bool:
    """A seat whose build could not be READ at all (as opposed to not-deployed)."""
    return row["state"] == "unreachable" or row["state"].startswith("error:")


def exit_code(rows: list[dict]) -> int:
    """0 fully deployed · 1 a readable seat is not deployed · 2 incomplete read."""
    if any(unreadable(r) for r in rows):
        return 2
    if any(r["state"] != "deployed" for r in rows):
        return 1
    if any(r["match"] is False for r in rows):
        return 1
    return 0


def parse_seat(spec: str) -> tuple[str, str]:
    """`NAME=URL` -> (name, url). Raises ValueError with a readable reason."""
    name, sep, url = spec.partition("=")
    name, url = name.strip(), url.strip()
    if not sep or not name or not url:
        raise ValueError(f"seat spec must be NAME=URL, got {spec!r}")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError(f"seat {name!r}: URL must start with http:// or https://, got {url!r}")
    return name, url


def audit(seats, expected=None, timeout: float = 6.0, probe_fn=None, max_workers=None) -> list[dict]:
    """Probe every seat CONCURRENTLY (bounded), one row each, order preserved.

    A seat whose probe raises is an `unreachable` row whose detail names the
    exception — the audit never loses a seat to one endpoint's failure.
    """
    probe = probe_fn or _PROBE_HTTP
    rows: list[dict | None] = [None] * len(seats)

    def one(index: int) -> None:
        name, url = seats[index]
        if probe is None:
            rows[index] = seat_row(name, url, {"status": None, "error": "reader module unreadable"}, expected)
            return
        try:
            result = probe(f"{url.rstrip('/')}/health", timeout=timeout)
        except Exception as exc:  # noqa: BLE001 - one endpoint never sinks the audit
            result = {"status": None, "error": f"probe raised {type(exc).__name__}: {exc}"}
        rows[index] = seat_row(name, url, result, expected)

    workers = max_workers or max(1, min(8, len(seats)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, range(len(seats))))
    return [r for r in rows if r is not None]


def render(rows: list[dict], expected: str | None = None) -> list[str]:
    """The table, its notes, and the verdict line — as printable lines."""
    header = ("seat", "endpoint", "role", "version", "revision", "instanceId", "uptimeSec", "state")
    table = [header]
    for r in rows:
        f = r["fields"]
        instance = f["instanceId"]
        if instance != "absent" and len(instance) > 8:
            instance = instance[:8] + "…"
        uptime = "-" if r["uptimeSec"] is None else str(r["uptimeSec"])
        table.append((r["seat"], r["endpoint"], f["role"], f["version"], f["revision"], instance, uptime, r["state"]))

    widths = [max(len(str(row[i])) for row in table) for i in range(len(header))]
    lines = [f"fleet revision audit — {_now_iso()} (reader clock)"]
    for row in table:
        lines.append("  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(row)).rstrip())

    for r in rows:
        if r["state"] == "unreachable":
            lines.append(f"note: {r['seat']} ({r['endpoint']}) — unreadable: {r['detail']}")
        elif r["state"].startswith("error:"):
            # The detail carries the remedy when there is one (#1140): a
            # `no-endpoint` row is a discovery failure, not a missing build.
            detail = f" — {r['detail']}" if r.get("detail") else ""
            lines.append(f"note: {r['seat']} ({r['endpoint']}) — HTTP/read failure: {r['state']}{detail}")
        if r["uptimeSec"] is not None and not (0 <= r["uptimeSec"] <= MAX_PLAUSIBLE_UPTIME_SEC):
            lines.append(
                f"note: {r['seat']} uptimeSec={r['uptimeSec']} is outside [0, 7 d] — reported, "
                "never turned into a start time (a host clock step moves it)"
            )

    # Counted by EXACT state: "unreachable 1" and "error:no-endpoint 1" send
    # the reader to different repairs, so they are not folded into one family.
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    deployed = sum(1 for r in rows if r["state"] == "deployed" and r["match"] is not False)
    parts = [f"{deployed}/{len(rows)} deployed"] + [f"{k} {v}" for k, v in sorted(counts.items()) if k != "deployed"]
    lines.append(f"exit {exit_code(rows)} — " + " · ".join(parts))
    if expected:
        matches = sum(1 for r in rows if r["match"] is True)
        differs = sum(1 for r in rows if r["match"] is False)
        other = len(rows) - matches - differs
        lines.append(f"expect {expected.lower()} — match {matches} · differ {differs} · not-comparable {other}")
    return lines


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(argv: list[str] | None = None, probe_fn=None, local_url_fn=None, stream=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seat", action="append", default=[], metavar="NAME=URL")
    ap.add_argument("--no-defaults", action="store_true", help="drop the built-in hub+relay seats")
    ap.add_argument("--local", action="store_true", help="add this seat's own sidecar (published port)")
    ap.add_argument("--local-name", default="local")
    ap.add_argument("--container", default=DEFAULT_CONTAINER)
    ap.add_argument("--expect", default=None, help="the SHA the fleet must carry (comparison, never a filter)")
    ap.add_argument("--timeout", type=float, default=6.0)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    out = stream or sys.stdout
    if stream is None:
        # The table carries "…" and "—". On a console whose code page lacks
        # them a print must degrade ("?"), never raise: a reader that dies on
        # its own output is a traceback, not a verdict.
        try:
            out.reconfigure(errors="replace")
        except Exception:  # noqa: BLE001 - a stream that cannot be reconfigured is left alone
            pass

    seats: list[tuple[str, str]] = [] if args.no_defaults else list(DEFAULT_SEATS)
    try:
        for spec in args.seat:
            seats.append(parse_seat(spec))
    except ValueError as exc:
        print(f"fleet-revision-audit: {exc}", file=sys.stderr)
        return 2
    names = [name for name, _ in seats]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        print(f"fleet-revision-audit: duplicate seat name(s): {', '.join(dupes)}", file=sys.stderr)
        return 2
    if args.expect is not None and not SHA_RE.match(args.expect):
        print(f"fleet-revision-audit: --expect must be a 7..40 hex commit sha, got {args.expect!r}", file=sys.stderr)
        return 2
    if not seats and not args.local:
        # An empty audit would exit 0 ("every seat is deployed"), which reads
        # as a green fleet — the one verdict an empty table must never give.
        print("fleet-revision-audit: no seat to audit (drop --no-defaults, or pass --seat NAME=URL)", file=sys.stderr)
        return 2
    if args.local:
        discover = local_url_fn or _LOCAL_SIDECAR_URL
        # The explicit name is tried first, then the two names a seat's sidecar
        # actually carries: an unnamed seat must be FOUND, not reported absent.
        tried = [args.container] + [n for n in LOCAL_CONTAINER_NAMES if n != args.container]
        url = None
        for name in tried:
            if not discover:
                break
            url = discover(name)
            if url:
                break
        if url:
            seats.append((args.local_name, url))
        else:
            # A discovery failure is a READER failure, named as one: the seat
            # was asked for and could not even be located. The note spells out
            # every name tried and the flag that overrides them, so the reader
            # never mistakes it for "this seat runs no build".
            rows = audit(seats, args.expect, args.timeout, probe_fn)
            rows.append(
                seat_row(args.local_name, f"container:{'|'.join(tried)}", {"status": None, "error": "no published port"}, args.expect)
            )
            rows[-1]["state"] = "error:no-endpoint"
            rows[-1]["detail"] = (
                "no published port on 3000/tcp for " + ", ".join(tried)
                + " — pass --container <name> if this seat names its sidecar differently"
            )
            return _emit(rows, args, out)

    rows = audit(seats, args.expect, args.timeout, probe_fn)
    return _emit(rows, args, out)


def _emit(rows: list[dict], args, out) -> int:
    code = exit_code(rows)
    if args.json:
        print(
            json.dumps(
                {"generatedAt": _now_iso(), "expect": args.expect, "seats": rows, "exit": code},
                ensure_ascii=False,
                indent=2,
            ),
            file=out,
        )
    else:
        for line in render(rows, args.expect):
            print(line, file=out)
    return code


if __name__ == "__main__":
    sys.exit(main())
