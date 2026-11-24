#!/usr/bin/env python3
r"""roosync-tree-fork.py — do this seat's two env layers name the SAME RooSync tree?

WHY THIS EXISTS (measured 2026-11-22/23 on myia-po-2024, #1136 -> #1168):
`ROOSYNC_SHARED_PATH` names the tree RooSync reads and writes, and on a seat it
can name TWO DIFFERENT TREES depending on the layer you ask. The process that
runs this instrument inherits the 2025 chain from its session; the User
environment scope holds the 2026 chain. Both directories exist, with disjoint
content at the same write instants (one carries a `v1.2.0-*` snapshot and no
standalone `claude-settings`; the other the standalone and no `v1.2.0`). The
variable was repointed at the User scope; the process predates the repoint and
keeps publishing into the old tree.

Which process is "the process" (T9): the `process` layer is the environment
THIS PROBE INHERITS from the session that launched it — never the MCP host's own
environment, which no process can read from outside. It is a PROXY for the host
(a host started before a repoint still holds the old value, and so does the shell
that launches this probe), and the output says so on every run. What the host
publishes is established by reading the trees, not by this layer alone.

Nothing on the fleet sees this class. `settings-matrix.py` reads whichever path
it is handed (`--shared` / `ROOSYNC_SHARED_PATH`, scripts/settings-matrix.py:532)
and reports it as *the* tree: pointed at the process value it describes a tree
nobody else reads and calls the picture complete. That is a blind spot of the
reader, not of RooSync.

This is an INSTRUMENT. It never writes, never repoints, never restarts a host.
The restart of the MCP host stays the user's arbitration (Q-po2024-8).

VERDICTS
  SAME          both layers were read, name the same tree after normalisation,
                and that tree exists on this seat holding a `configs/<machine>`.
  FORK          the layers disagree — including the asymmetric case (one layer
                names a tree, the other sets nothing) — or, in your words, the
                host may be publishing into a tree no one else reads.
  UNMEASURABLE  the comparison could not be made: the User scope is not
                readable on this host, neither layer sets the variable, or the
                agreed name exists nowhere on this seat. Absence of a signal is
                not a signal, and this verdict is the whole point of the probe.

EXIT CODES
  0 SAME · 2 UNMEASURABLE · 3 FORK

`0` means COMPARED AND SAME. It never means "could not compare". A probe that
answers 0 because it measured nothing reproduces, at its own level, exactly the
defect it was written to expose.

TRAPS (each one produces a wrong-but-plausible answer if you skip it)
  T1 `SAME` from a probe that never compared anything — the failure this
     instrument exists to refuse. Every unreadable path ends at 2.
  T2 Pointing `settings-matrix.py --shared` at the process value cannot reveal
     the fork: it reads one tree. The comparison has to read BOTH layers.
  T3 The User scope is the registry, not `setx` console output, and its value
     may be REG_EXPAND_SZ. Read unexpanded, `%USERPROFILE%\...` compares
     unequal to the same path in the process; it is expanded before comparing,
     and a `%` that survives expansion is reported as a note rather than
     silently compared.
  T4 Normalisation matters in both directions: a trailing separator, `\` vs `/`
     or a doubled separator is NOT a fork (Windows paths are case-insensitive,
     POSIX ones are not — the case folding follows the host, and the flag is
     overridable for the tests).
  T5 Naming the tree by its leaf would report two different trees as identical:
     `.shared-state` is the leaf on BOTH chains. The label keeps the last two
     components, which is exactly what differs ("Synchronisation" vs
     "Synchronisation (1)").
  T6 The newest-write scan is bounded. Truncation is DECLARED, never answered
     from a partial tree as if it were complete.
  T7 An absent `configs/<machine>` is an absence. It never reads as age 0 or as
     "fresh".
  T8 Q85: the report is meant to be quoted in a dashboard post, so nothing
     above the tree name is ever printed — the drive letter and every directory
     under it are replaced by `<gdrive>/…`. The report dict itself carries no
     raw path either, only labels.
  T9 The `process` layer is the environment THIS PROBE INHERITS from its own
     session — not the MCP host's environment, which cannot be read from
     outside that process. It is a proxy for the host (both predate a repoint
     the same way), and every output says so; never quote it as "the host's
     value" (CR 23b, c.7093302681).

USAGE
  python scripts/roosync-tree-fork.py                 # this seat, human output
  python scripts/roosync-tree-fork.py --json          # same, machine-readable
  python scripts/roosync-tree-fork.py --machine X     # read another machine's configs/<machine>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

VAR = "ROOSYNC_SHARED_PATH"
WINDOWS = os.name == "nt"

EXIT_CODES = {"SAME": 0, "UNMEASURABLE": 2, "FORK": 3}

# Bounded scan of `configs/<machine>`: enough for a snapshot tree, small enough
# that a mis-pointed value (a whole drive, say) cannot hang the probe.
DEFAULT_LIMIT = 20000

_DRIVE_RE = re.compile(r"^[A-Za-z]:$")


# --- values ---------------------------------------------------------------


def _named(value) -> bool:
    """True when a layer actually names something ("" and whitespace name nothing)."""
    return isinstance(value, str) and value.strip() != ""


def normalize_path(path: str, case_insensitive: bool | None = None) -> str:
    """Compare-shape for a path: separators, doubled separators, trailing slash, case (T4)."""
    ci = WINDOWS if case_insensitive is None else case_insensitive
    s = str(path).strip().replace("\\", "/")
    while "//" in s:
        s = s.replace("//", "/")
    if len(s) > 1:
        s = s.rstrip("/")
    return s.casefold() if ci else s


def tree_label(path: str, keep: int = 2) -> str:
    """Name the tree, never the path (T5, T8): the last components, prefix masked.

    The leaf alone is useless here — `.shared-state` is the leaf on both chains —
    so the label keeps the last `keep` components, which is the part that
    actually differs between two sibling trees.
    """
    parts = [p for p in str(path).strip().replace("\\", "/").split("/") if p]
    if parts and parts[-1] == ".shared-state":
        parts = parts[:-1]
    if not parts:
        return ""
    tail = parts[-max(1, keep):]
    tail = ["<drive>" if _DRIVE_RE.match(p) else p for p in tail]
    return ("<gdrive>/…/" if len(parts) > len(tail) else "") + "/".join(tail)


def read_user_scope(name: str = VAR) -> dict:
    """The User-scope value, or the reason it cannot be read (T1, T3).

    Returns `{"value": str|None, "error": str|None, "notes": [str]}`. `error`
    set means UNMEASURABLE; `value` None with no error means "read, and it is
    simply not set" — a finding, not a hole.
    """
    out = {"value": None, "error": None, "notes": []}
    if not WINDOWS:
        out["error"] = "the User environment scope has no readable store on %s" % sys.platform
        return out
    try:
        import winreg
    except ImportError:  # pragma: no cover - defensive
        out["error"] = "winreg unavailable: the User scope cannot be read"
        return out
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _kind = winreg.QueryValueEx(key, name)
    except FileNotFoundError:
        return out  # readable, and the name is absent
    except OSError as exc:
        out["error"] = "cannot open HKCU\\Environment: %s" % (exc.strerror or exc)
        return out
    if not _named(value):
        return out
    expanded = os.path.expandvars(str(value))
    if "%" in expanded:
        out["notes"].append(
            "the User value still holds an unexpanded %%VAR%% after expansion; "
            "the comparison is on the literal text"
        )
    out["value"] = expanded
    return out


# --- filesystem half ------------------------------------------------------


def latest_write(root, limit: int = DEFAULT_LIMIT):
    """(newest mtime as aware datetime | None, files seen, truncated) — T6, T7."""
    root = Path(root)
    if not root.is_dir():
        return None, 0, False
    newest = None
    files = 0
    stack = [root]
    while stack:
        directory = stack.pop()
        try:
            entries = list(os.scandir(directory))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(Path(entry.path))
                    continue
                stat = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            files += 1
            if files > limit:
                return newest, limit, True
            mtime = datetime.fromtimestamp(stat.st_mtime, timezone.utc)
            if newest is None or mtime > newest:
                newest = mtime
    return newest, files, False


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_ts(text):
    if not isinstance(text, str) or not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def snapshot_report(shared_path, machine: str, now: datetime, limit: int = DEFAULT_LIMIT) -> dict:
    """What `configs/<machine>` under this tree holds, without inventing anything."""
    configs = Path(shared_path) / "configs" / machine
    newest, files, truncated = latest_write(configs, limit=limit)
    age_h = None
    if newest is not None:
        age_h = round((now - newest).total_seconds() / 3600.0, 1)
    return {
        # `exists` is about THIS MACHINE's configs dir; `tree_exists` keeps the
        # two absences apart — a missing tree is not a missing configs/<machine>.
        "exists": configs.is_dir(),
        "tree_exists": Path(shared_path).is_dir(),
        "newest": _iso(newest),
        "age_h": age_h,
        "files": files,
        "truncated": truncated,
    }


# --- the comparison -------------------------------------------------------


def probe(*, process_value, user_value, user_error, machine, now, snapshot_fn,
          case_insensitive=None, user_notes=None) -> tuple[dict, int]:
    """Build the report and its exit code. Pure: every input is injected.

    `snapshot_fn(shared_path, machine)` returns
    `{"exists", "newest", "age_h", "files"[, "truncated"]}`.
    """
    layers = [
        {"layer": "process", "set": _named(process_value)},
        {"layer": "user", "set": _named(user_value)},
    ]
    raw = {"process": process_value, "user": user_value}
    notes = list(user_notes or [])

    if user_error:
        verdict, reason = "UNMEASURABLE", user_error
    elif not any(layer["set"] for layer in layers):
        verdict, reason = "UNMEASURABLE", "neither layer sets %s: nothing to compare" % VAR
    elif sum(1 for layer in layers if layer["set"]) == 1:
        verdict, reason = "FORK", "one layer names a tree while the other sets nothing"
    else:
        shapes = {normalize_path(raw[layer["layer"]], case_insensitive=case_insensitive)
                  for layer in layers if layer["set"]}
        if len(shapes) > 1:
            verdict, reason = "FORK", "the two layers name different trees"
        else:
            verdict, reason = "SAME", "the two layers name the same tree"

    # One snapshot entry per DISTINCT tree, labelled, carrying which layers name it.
    by_shape: dict[str, dict] = {}
    for layer in layers:
        if not layer["set"]:
            continue
        shape = normalize_path(raw[layer["layer"]], case_insensitive=case_insensitive)
        entry = by_shape.get(shape)
        if entry is None:
            entry = {"tree": tree_label(raw[layer["layer"]]), "layers": []}
            by_shape[shape] = entry
        entry["layers"].append(layer["layer"])

    snapshots = []
    for shape, entry in by_shape.items():
        # Probe the path as the FIRST layer that names it gives it.
        source_layer = entry["layers"][0]
        try:
            snap = dict(snapshot_fn(raw[source_layer], machine))
        except Exception as exc:  # noqa: BLE001 - an unreadable tree is a finding, not a crash
            snap = {"exists": False, "newest": None, "age_h": None, "files": 0,
                    "error": "%s: %s" % (type(exc).__name__, exc)}
        snapshots.append({**entry, **snap})

    # Name each layer's tree from its own entry (never from a leaked loop variable:
    # that wrote the user label onto the process layer and lost the difference).
    label_of = {name: entry["tree"] for entry in by_shape.values() for name in entry["layers"]}
    for layer in layers:
        if layer["set"]:
            layer["tree"] = label_of[layer["layer"]]

    existing = [s for s in snapshots if s.get("exists") and s.get("newest")]
    freshest = None
    if existing:
        winner = max(existing, key=lambda s: _parse_ts(s["newest"]) or datetime.min.replace(tzinfo=timezone.utc))
        others = [s for s in existing if s is not winner]
        delta_h = None
        if others and winner.get("age_h") is not None:
            # 0.0 is a legitimate age (a write this instant); only None means
            # "unknown", so the key must test None rather than truthiness.
            def _age_key(s):
                age = s.get("age_h")
                return float("inf") if age is None else age

            runner_up = min(others, key=_age_key)
            if runner_up.get("age_h") is not None:
                delta_h = round(runner_up["age_h"] - winner["age_h"], 1)
        freshest = {
            "tree": winner["tree"],
            "layer": winner["layers"][0] if len(winner["layers"]) == 1 else "both",
            "age_h": winner.get("age_h"),
            "delta_h": delta_h,
        }
    elif not existing and any(s.get("exists") for s in snapshots):
        notes.append("a tree exists but holds no readable file; its age is unknown, not zero")

    # SAME needs a tree that is actually here — otherwise nothing was established.
    # Name the real absence: a missing tree and a tree without this machine's
    # configs are two different findings, and the reason must not conflate them.
    if verdict == "SAME" and not any(s.get("exists") for s in snapshots):
        verdict = "UNMEASURABLE"
        if any(s.get("tree_exists") for s in snapshots):
            reason = ("both layers name the same tree, but it holds no configs/%s on "
                      "this seat: which tree carries this machine's snapshots is "
                      "unmeasured" % machine)
        else:
            reason = ("both layers name the same tree, but no such tree exists on this "
                      "seat: which tree holds the snapshots here is unmeasured")

    report = {
        "probe": "roosync-tree-fork",
        "variable": VAR,
        "machine": machine,
        "host": sys.platform,
        # T9, on every output: the process layer is what this probe inherited.
        "process_source": (
            "the environment this probe inherited from its own session — a proxy "
            "for the MCP host, whose own environment is never read"
        ),
        "layers": layers,
        "verdict": verdict,
        "reason": reason,
        "snapshots": snapshots,
        "freshest": freshest,
        "notes": notes,
    }
    return report, EXIT_CODES[verdict]


# --- rendering ------------------------------------------------------------


def _consoles_word(layer: str) -> str:
    return "the process tree" if layer == "process" else ("the user tree" if layer == "user" else "both layers")


def render(report: dict) -> str:
    lines = [
        "roosync-tree-fork — seat %s (%s)" % (report["machine"], report["host"]),
        # T9: say WHICH process the process layer reads, on every run, or the
        # report reads as if it had inspected the MCP host itself.
        "layers    process = %s" % report.get(
            "process_source", "the environment this probe inherited from its session"),
    ]
    width = max(len(s.get("tree") or "") for s in report["snapshots"]) if report["snapshots"] else 0
    width = max(width, 12)
    for layer in report["layers"]:
        entry = next((s for s in report["snapshots"] if layer["layer"] in s["layers"]), None)
        name = entry["tree"] if entry else "—"
        state = "" if layer["set"] else "  (unset)"
        lines.append("%-9s %s%s" % (layer["layer"], name.ljust(width).rstrip(), state))
    lines.append("verdict   %s — %s" % (report["verdict"], report["reason"]))
    if report["snapshots"]:
        lines.append("snapshots configs/%s" % report["machine"])
        for snap in report["snapshots"]:
            if snap.get("exists"):
                if snap.get("newest"):
                    lines.append(
                        "  %s  %s files, newest %s (%.1f h ago)%s"
                        % (snap["tree"].ljust(width), snap.get("files", "?"), snap["newest"],
                           snap.get("age_h") or 0.0,
                           ", SCAN TRUNCATED" if snap.get("truncated") else "")
                    )
                else:
                    lines.append("  %s  exists, no readable file (age unknown)" % snap["tree"].ljust(width))
            else:
                lines.append("  %s  absent on this seat" % snap["tree"].ljust(width))
        if report["freshest"]:
            delta = report["freshest"].get("delta_h")
            tail = "" if delta is None else ", %.1f h newer than the other tree" % delta
            lines.append("  freshest: %s%s" % (_consoles_word(report["freshest"]["layer"]), tail))
    for note in report["notes"]:
        lines.append("note      %s" % note)
    return "\n".join(lines)


# --- entry point ----------------------------------------------------------


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Compare the process and User-scope values of %s." % VAR)
    parser.add_argument("--machine", default=None,
                        help="machine id whose configs/<machine> to read (default: hostname)")
    parser.add_argument("--json", action="store_true", help="machine-readable report")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                        help="max files scanned per tree (default %d)" % DEFAULT_LIMIT)
    args = parser.parse_args(argv)

    machine = args.machine or socket.gethostname()
    user = read_user_scope()
    now = datetime.now(timezone.utc)
    report, code = probe(
        process_value=os.environ.get(VAR),
        user_value=user["value"],
        user_error=user["error"],
        user_notes=user["notes"],
        machine=machine,
        now=now,
        snapshot_fn=lambda path, m: snapshot_report(path, m, now, limit=args.limit),
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(render(report))
    return code


if __name__ == "__main__":
    sys.exit(main())
