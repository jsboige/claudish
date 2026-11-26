#!/usr/bin/env python3
"""relay-reqnumber-audit.py — produce the #1193 acceptance row for ONE relay seat.

WHY THIS EXISTS (measured 2026-11-26, po-2024, container `claudish-sidecar`):
#1193's fix (PR #1194) gives a relayed request its own request number. The
acceptance row per seat is "ttft / distinct reqN / [Request] lines" read from
the container log. The row is easy to produce WRONG, and it was produced wrong
in the #1193 thread before this script existed:

  whole life (since StartedAt 25/11 11:04:53Z, read 26/11 05:23Z)
      ttft=5983 request_lines=6 distinct_reqN=7   <- reads "not frozen"
  after the last transition back to NOMINAL (02:07:08.634Z -> 05:22:57Z)
      ttft=1155 request_lines=0 distinct_reqN=1   <- the actual state: FROZEN

The whole-life row moved because ONE autonomous episode (a nightly hub
restart, 02:06:05Z -> 02:07:08Z) served six requests LOCALLY; local serving is
what advances the frozen counter (`logRequest` is its only writer on an image
older than #1194). The fix was not involved. So on a seat that has ever served
locally, the whole-life row is not the acceptance row: the window must start
after the last `[Request]` line, and `request_lines == 0` is the precondition
that makes "one distinct reqN" mean something.

VERDICTS — `window[…]` is the as-measured row, `acceptance[…]` is the row a
report should quote (trimmed after the last transition back to NOMINAL when
local serving exists). The process exit code is 0 whenever a row was produced.

  INCONCLUSIVE   fewer than 2 NUMBERED [ttft] lines: the row says nothing.
  FROZEN         request_lines == 0 and exactly one distinct reqN. That value
                 is the GLOBAL counter of the local pipeline, frozen at the
                 last locally served request (0 on a process that never served
                 locally). An image older than #1194 keeps it for its whole
                 life.
  FIXED          request_lines == 0 and distinct reqN == numbered [ttft] lines:
                 every relayed response took its own number. This is the shape
                 the #1194 image is expected to produce. No such image was in
                 the fleet on 26/11: FIXED has never been observed in
                 production — say so when reporting it.
  AMBIGUOUS      request_lines == 0 but 1 < distinct < numbered: more than one
                 frozen value with no local serving. Usual cause: the window
                 spans a process restart (the counter restarts with the
                 process). Never report AMBIGUOUS as FROZEN or FIXED.
  LOCAL-SERVING  request_lines > 0: the window contains autonomous serving, so
                 a repeated reqN may be correct behaviour. Quote the
                 acceptance row, not this one.
  MULTI-LIFE     the acceptance window spans several process lives: read the
                 `life[…]` rows; the whole-window verdict is not valid.
  NO-ACCEPTANCE-WINDOW  local serving exists and no transition back to NOMINAL
                 follows it (relay still AUTONOMOUS, or a forward failed
                 without a mode change). Nothing may be quoted yet.
  NO-TRAFFIC     no [ttft] line at all in the window.

TRAPS (each one produces a wrong-but-plausible acceptance row):
  T1 A whole-life window on a seat that ever served locally reports several
     distinct reqN — read as "the fix works". It does not: `[Request]` lines
     are the tell, and they must be 0 for the row to mean anything.
  T2 A per-request relay line ("→ this request served LOCALLY [2/2 before
     AUTONOMOUS]") mentions AUTONOMOUS without being a transition. Counting the
     word instead of the transition inflates the episode count and moves the
     trim point; the anchors are the mode name at END of line, the arrow form,
     and a no-arrow fallback for a log whose arrow did not survive encoding —
     the same anchors as scripts/hub-entry-probe.py.
  T3 A window that spans a process restart carries one frozen value per life
     (#1201 noted the same on traffic-live's guard). The script splits on the
     `[Relay] sidecar mode:` startup line and prints `life[…]` rows; a
     whole-window verdict over several lives is invalid, not merely imprecise.
  T4 `reqN` numbers forwards that PRODUCED a [ttft] line in ONE process life: a
     `stream: false` answer prints none, and a forward dying before its first
     useful event prints none either. So `distinct == numbered` is a comparison
     inside one life, never "distinct == requests relayed".
  T5 Per-model distinct counts are the control that catches a mis-read: on a
     frozen counter the same value appears for every model, on a fixed one they
     differ. `--by-model` prints it; it never changes a verdict.
  T6 The log must be read WITH timestamps (`docker logs -t`). Without them no
     transition can be dated and no window can be trimmed: the script says
     `ts=none` and refuses the trim instead of guessing line order.
  T7 A container writes its application lines to stdout AND stderr (`[relay]
     upstream-nonok` and `[Stream]` live on stderr on po-2024's sidecar, 26/11).
     `--container` therefore merges both streams; a file given with `--log` is
     the caller's read, and the script states which lines it could not place.
  T8 `docker logs --since` after a rotation can serve a partial corpus without
     saying so. The script reports `starts_at_process_start`: false when the
     corpus does not begin on a `[Relay] sidecar mode:` line, so a whole-life
     row whose head was rotated away is not mistaken for a complete one.
  T9 Timestamps are compared as normalised INSTANTS, never as raw strings:
     Go's RFC3339Nano trims trailing zeros and drops the fraction at ns=0, so
     ":08.6Z" sorts AFTER ":08.634Z" as a string while .600 precedes .634. A
     raw compare made the acceptance precondition accept a window that still
     held a local-serving request (and refuse a valid one); the precondition
     now uses the same `_key()` normalisation as the cut itself.

READ-ONLY: reads a log (file, stdin, or `--container` via `docker logs -t`),
prints counters, timestamps and verdicts. No writes, no secrets: upstream URLs,
machine tags and request bodies are never printed.

Usage:
  python scripts/relay-reqnumber-audit.py --container claudish-sidecar \
      --since "$(docker inspect claudish-sidecar --format '{{.State.StartedAt}}')"
  docker logs -t claudish-sidecar > seat.log 2>&1
  python scripts/relay-reqnumber-audit.py --log seat.log --by-model
  python scripts/relay-reqnumber-audit.py --log seat.log --since 2026-11-26T02:07:08 --json

Exit codes: 0 a row was produced · 2 the input could not be read.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

# Same anchors as scripts/hub-entry-probe.py (one definition of "a transition").
RELAY_TRANSITION_RE = re.compile(r"(?:→|->)\s*(NOMINAL|AUTONOMOUS)\b")
RELAY_FALLBACK = (("healthy again", "NOMINAL"), ("DOWN after", "AUTONOMOUS"))
TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z\s")
TTFT_RE = re.compile(r"\[ttft\]")
REQN_RE = re.compile(r"reqN=(\d+)")
MODEL_RE = re.compile(r"model=(\S+)")
STARTUP_MARKER = "[Relay] sidecar mode:"
ISO_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?")


def _key(stamp: str) -> tuple[str, str]:
    """Normalise an ISO stamp (or prefix) to a comparable sort key.

    Fractional seconds are right-padded to 9 digits so `…:08.6Z` < `…:08.63Z`
    compares numerically, and a stamp written without a fraction is the START
    of its second (`.000000000`) — the same instant as a bound written at the
    second. A bound shorter than the seconds field keeps a raw prefix compare.
    """
    hit = ISO_RE.match(stamp)
    if not hit:
        return (stamp, "")
    seconds, frac = hit.group(1), hit.group(2) or ""
    return (seconds, (frac + "000000000")[:9])


def _stamp(line: str) -> str | None:
    """The docker `-t` timestamp of a line, or None (T6: no timestamps)."""
    found = TS_RE.match(line)
    if not found:
        return None
    return f"{found.group(1)}.{found.group(2) or ''}Z" if found.group(2) else f"{found.group(1)}Z"


def _transition(line: str) -> str | None:
    """NOMINAL / AUTONOMOUS if this line IS a transition, else None.

    T2: the per-request line ("→ this request served LOCALLY …") carries the
    word too; only a transition line counts.
    """
    if "[Relay]" not in line or "served LOCALLY" in line:
        return None
    if line.rstrip().endswith("AUTONOMOUS"):
        return "AUTONOMOUS"
    found = RELAY_TRANSITION_RE.search(line)
    if found:
        return found.group(1)
    for needle, mode in RELAY_FALLBACK:
        if needle in line:
            return mode
    return None


def _window_stats(lines: list[str]) -> dict:
    ttft = [l for l in lines if TTFT_RE.search(l)]
    requests = [l for l in lines if "[Request]" in l]
    numbers: dict[str, int] = {}
    per_model: dict[str, set[str]] = {}
    numbered = 0
    for line in ttft:
        hit = REQN_RE.search(line)
        if hit:
            numbered += 1
            numbers[hit.group(1)] = numbers.get(hit.group(1), 0) + 1
        model = MODEL_RE.search(line)
        if model:
            per_model.setdefault(model.group(1), set()).add(hit.group(1) if hit else "?")
    transitions = [
        (stamp, mode)
        for stamp, mode in ((_stamp(l), _transition(l)) for l in lines)
        if mode is not None
    ]
    return {
        "lines": len(lines),
        "ttft": len(ttft),
        "ttft_numbered": numbered,
        "ttft_without_reqN": len(ttft) - numbered,
        "request_lines": len(requests),
        "distinct_reqN": len(numbers),
        "reqN_counts": numbers,
        "per_model": {k: sorted(v) for k, v in sorted(per_model.items())},
        "first_ts": _stamp(lines[0]) if lines else None,
        "last_ts": _stamp(lines[-1]) if lines else None,
        "autonomous": sum(1 for _, m in transitions if m == "AUTONOMOUS"),
        "nominal": sum(1 for _, m in transitions if m == "NOMINAL"),
        "last_transition": transitions[-1] if transitions else None,
        "last_request_ts": _stamp(requests[-1]) if requests else None,
    }


def _verdict(stats: dict) -> str:
    if stats["ttft"] == 0:
        return "NO-TRAFFIC"
    if stats["request_lines"] > 0:
        return "LOCAL-SERVING"
    if stats["ttft_numbered"] < 2:
        return "INCONCLUSIVE"
    if stats["distinct_reqN"] == 1:
        return "FROZEN"
    if stats["distinct_reqN"] == stats["ttft_numbered"]:
        return "FIXED"
    return "AMBIGUOUS"


def _split_lives(lines: list[str]) -> list[list[str]]:
    """Split on the relay startup line — one list per process life (T3/T8)."""
    lives: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        if STARTUP_MARKER in line:
            if current:
                lives.append(current)
            current = [line]
        else:
            current.append(line)
    if current:
        lives.append(current)
    return lives


def audit(lines: list[str], since: str | None = None, until: str | None = None) -> dict:
    """Counters + verdicts for the window. Pure: no I/O, never raises on content.

    `since` / `until` are ISO prefixes compared against the line timestamps;
    `until` written at the second includes that whole second. A line without a
    timestamp is DROPPED when a bound is given — it cannot be placed in the
    window — and kept when no bound is given (T6: the caller loses the trim,
    not the counters).
    """
    non_empty = [l for l in lines if l.strip()]
    placed = [l for l in non_empty if _stamp(l) is not None]
    has_timestamps = bool(placed) and len(placed) == len(non_empty)

    until_key = None
    if until:
        hit = ISO_RE.match(until)
        # A bound written at the second means "through the end of that second".
        until_key = _key(until if (hit and hit.group(2)) or not hit else f"{until}.999999999")

    window = []
    for line in non_empty:
        stamp = _stamp(line)
        if (since or until) and stamp is None:
            continue
        if stamp is None:
            window.append(line)
            continue
        if since and _key(stamp) < _key(since):
            continue
        if until_key is not None and _key(stamp) > until_key:
            continue
        window.append(line)

    stats = _window_stats(window)
    result = {
        "window": {
            "since": since,
            "until": until,
            "has_timestamps": has_timestamps,
            "starts_at_process_start": bool(window) and STARTUP_MARKER in window[0],
            "unplaced_lines": len(non_empty) - len(placed) if has_timestamps is False else 0,
        },
        "verdict": _verdict(stats),
        **stats,
    }

    # The acceptance window: after the last transition back to NOMINAL, when it
    # follows the last local request (T1 — the precondition of the row).
    acceptance: dict | None = None
    acceptance_lines: list[str] = window
    trim_note: str | None = None
    if stats["request_lines"] > 0:
        if not has_timestamps:
            trim_note = "no timestamps in the corpus (use `docker logs -t`): the acceptance window cannot be placed"
        elif stats["last_transition"] and stats["last_transition"][1] == "NOMINAL" and (
            # Compared as NORMALISED keys, never as raw strings: Go's
            # RFC3339Nano trims trailing zeros (and drops the fraction at ns=0),
            # so "…:08.6Z" > "…:08.634Z" and "…:08.5Z" > "…:08.500Z" as strings
            # while the instants say the opposite. The cut below already uses
            # _key(); the precondition must agree with it.
            _key(stats["last_transition"][0] or "") >= _key(stats["last_request_ts"] or "")
        ):
            cut = stats["last_transition"][0] or ""
            cut_key = _key(cut)
            acceptance_lines = [l for l in window if _stamp(l) is not None and _key(_stamp(l) or "") > cut_key]
            acceptance = {"since": cut, **_window_stats(acceptance_lines)}
        else:
            trim_note = (
                "no transition back to NOMINAL follows the last local request"
                f" ({stats['last_request_ts']}): the relay is still AUTONOMOUS, or a forward failed without a"
                " mode change — no clean acceptance window yet (pass --since just after it to measure a window by hand)"
            )
    else:
        acceptance = {"since": since, **stats}
    if acceptance is not None:
        acceptance["verdict"] = _verdict(acceptance)
    result["acceptance"] = acceptance
    result["trim_note"] = trim_note

    # Per-life rows over the acceptance window (T3) — the only valid unit when
    # several process lives are inside it. The life that contains the trim
    # point is the first row (it no longer starts on a startup line). With no
    # acceptance window there is nothing to quote: the verdict says so.
    lives: list[dict] = []
    if acceptance is not None:
        for life in _split_lives(acceptance_lines):
            life_stats = _window_stats(life)
            lives.append({"start_ts": _stamp(life[0]) if life else None, **life_stats, "verdict": _verdict(life_stats)})
        if len(lives) > 1:
            result["verdict"] = "MULTI-LIFE"
        elif acceptance["verdict"] != result["verdict"]:
            # The quoted verdict is the acceptance one; keep the as-measured one
            # readable under its own name.
            result["window_verdict"] = result["verdict"]
            result["verdict"] = acceptance["verdict"]
    else:
        result["window_verdict"] = result["verdict"]
        result["verdict"] = "NO-ACCEPTANCE-WINDOW"
    result["lives"] = lives
    return result


def _fmt_row(label: str, row: dict, verdict: str | None = None) -> str:
    numbers = ",".join(
        f"{k}x{v}" for k, v in sorted(row["reqN_counts"].items(), key=lambda kv: int(kv[0]))
    )
    extra = f" numbered={row['ttft_numbered']} no_reqN={row['ttft_without_reqN']}" if row["ttft_without_reqN"] else ""
    return (
        f"[relay-reqN] {label} ttft={row['ttft']} request_lines={row['request_lines']}"
        f" distinct_reqN={row['distinct_reqN']}{extra} verdict={verdict or row['verdict']}"
        f" reqN={numbers or '-'} autonomous={row['autonomous']} nominal={row['nominal']}"
        f" first={row['first_ts'] or 'none'} last={row['last_ts'] or 'none'}"
    )


def render(result: dict) -> str:
    window = result["window"]
    out = [
        _fmt_row(
            f"window[{window['since'] or 'start'}..{window['until'] or 'end'}]",
            result,
            result.get("window_verdict", result["verdict"]),
        )
    ]
    if not window["has_timestamps"]:
        out.append("[relay-reqN] ts=none — no timestamps in the corpus: the trim is unavailable (use `docker logs -t`)")
    if result["acceptance"] is not None and result["request_lines"] > 0:
        out.append(
            _fmt_row(f"acceptance[>{result['acceptance']['since'] or 'start'}]", result["acceptance"])
        )
    elif result["trim_note"]:
        out.append(f"[relay-reqN] acceptance=unavailable — {result['trim_note']}")
    if not window["starts_at_process_start"] and result["ttft"]:
        out.append(
            "[relay-reqN] note: the corpus does not start on a `[Relay] sidecar mode:` line"
            " — expected for a trimmed window; for a whole-life row, check that its head was not rotated away"
        )
    for life in result["lives"] if len(result["lives"]) > 1 else []:
        out.append(_fmt_row(f"life[{life['start_ts'] or '?'}]", life))
    if result["verdict"] == "MULTI-LIFE":
        out.append(
            "[relay-reqN] MULTI-LIFE: the acceptance window spans several process lives"
            " — read the life[…] rows, the whole-window verdict is not valid"
        )
    if result["verdict"] == "AMBIGUOUS" or (
        result["acceptance"] is not None and result["acceptance"]["verdict"] == "AMBIGUOUS"
    ):
        out.append(
            "[relay-reqN] AMBIGUOUS: more than one frozen value with no local serving"
            " — split the window per process life before any verdict"
        )
    if result["verdict"] == "FIXED" or (
        result["acceptance"] is not None and result["acceptance"]["verdict"] == "FIXED"
    ):
        out.append(
            "[relay-reqN] note: FIXED is the shape #1194 is expected to produce;"
            " no such image was observed in production on 26/11 — quote the image id and build date with it"
        )
    return "\n".join(out)


def _read_input(args, stdin_bytes: bytes | None) -> str | None:
    """The log text, or None when it cannot be read. Never raises."""
    if args.log:
        try:
            with open(args.log, "rb") as handle:
                return handle.read().decode("utf-8", "replace")
        except OSError as exc:
            print(f"[relay-reqN] cannot read --log {args.log}: {type(exc).__name__}", file=sys.stderr)
            return None
    if args.container:
        cmd = ["docker", "logs", "-t"]
        if args.since:
            cmd += ["--since", args.since]
        cmd.append(args.container)
        try:
            proc = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,  # T7: application lines live on stderr too
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
            )
        except Exception as exc:
            print(f"[relay-reqN] docker logs failed: {type(exc).__name__}", file=sys.stderr)
            return None
        text = proc.stdout or ""
        if proc.returncode != 0 and not any(_stamp(l) for l in text.splitlines()):
            first = next((l for l in text.splitlines() if l.strip()), "")
            print(f"[relay-reqN] docker logs exit {proc.returncode}: {first[:160]}", file=sys.stderr)
            return None
        return text
    if stdin_bytes is not None:
        return stdin_bytes.decode("utf-8", "replace")
    return sys.stdin.buffer.read().decode("utf-8", "replace")


def main(argv: list[str] | None = None, stdin_bytes: bytes | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--log", default=None, help="a file holding `docker logs -t <container>` (default: --container, else stdin)")
    ap.add_argument("--container", default=None, help="read `docker logs -t --since <--since>` from this container (stdout and stderr merged)")
    ap.add_argument("--since", default=None, help="ISO prefix (e.g. 2026-11-26T02:07:08); also passed to docker logs with --container")
    ap.add_argument("--until", default=None, help="ISO prefix, includes its own second")
    ap.add_argument("--by-model", action="store_true", help="print distinct reqN per model (the T5 control)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    text = _read_input(args, stdin_bytes)
    if text is None:
        return 2

    # With --container, docker already applied --since; keep the boundary out of
    # the Python filter so the first second of the life is not double-trimmed.
    since = None if args.container else args.since
    result = audit(text.splitlines(), since=since, until=args.until)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(render(result))
        if args.by_model:
            # T5: the control belongs to the ACCEPTANCE window when one exists
            # (the whole window mixes local numbers with the frozen value).
            source = result["acceptance"] if result["acceptance"] is not None else result
            for model, values in source["per_model"].items():
                print(f"[relay-reqN] per_model model={model} distinct_reqN={len(values)} values={','.join(values)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
