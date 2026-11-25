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
it is handed (`--shared` / `ROOSYNC_SHARED_PATH`, scripts/settings-matrix.py:503)
and reports it as *the* tree: pointed at the process value it describes a tree
nobody else reads and calls the picture complete. That is a blind spot of the
reader, not of RooSync.

A second blind spot of the same shape (measured 2026-11-25 on myia-po-2024): the
cascade canon store `roosync_claudish_cascade` reads is `<tree>/claudish-cascade`,
and the tool answers `store_present` for the tree ITS OWN process holds. On this
seat the store exists in one tree only. The reader bound to the other tree
answered `store_present: false`, and a message went out saying no canon had ever
been published for the fleet — while four versions sat in the other tree. The
probe now reports the store under EACH tree, so a reader's "absent" can be told
from a seat's binding before it is quoted as a fleet fact.

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
  T10 A store-bound reader's "absent" is bound to ONE tree. `roosync_claudish_cascade
      list` answers `store_present` for `<ROOSYNC_SHARED_PATH>/claudish-cascade` as
      its own process resolves the variable. On a forked seat the canon can sit
      entirely in the other tree, so `false` is a seat reading until BOTH trees
      agree. The probe reads the store under each tree with the tool's own rules
      (versions = `versions/v*` holding a readable `manifest.json`; the head is
      `latest.json`, never the newest directory). A pointer the tool would read
      as `null` is reported as absent or unreadable — the tool collapses both,
      and the difference is what tells a never-published store from a damaged one.
      One thing the probe does NOT mirror: the tool prints any `version` string
      it finds, and this report is quoted on dashboards (T8), so a label is shown
      only when it is a version label by the publisher's own rule.

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

# The canon store `roosync_claudish_cascade` reads, resolved exactly as the tool
# resolves it (`cascade-store.ts`): a direct sub-directory of the shared tree.
CASCADE_STORE_SUBDIR = "claudish-cascade"
CASCADE_POINTER = "latest.json"

_DRIVE_RE = re.compile(r"^[A-Za-z]:$")
# The rule a publish enforces on a version label (`cascade-store.ts`, VERSION_RE).
_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


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


# --- the cascade canon store under a tree (T10) ----------------------------


def _safe_error(exc, *roots) -> str:
    """An error text without a path (T8): the type and the reason, never a filename."""
    reason = getattr(exc, "strerror", None) or getattr(exc, "msg", None) or ""
    text = "%s: %s" % (type(exc).__name__, reason) if reason else type(exc).__name__
    for root in roots:
        for spelling in {str(root), str(root).replace("\\", "/")}:
            if spelling:
                text = text.replace(spelling, "<tree>")
    return text


def _aware(dt: datetime | None) -> datetime | None:
    """A parsed timestamp as aware UTC. A bare local time reads as UTC, never as this host's zone."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _count_versions(versions_dir, limit: int):
    """(count | None, truncated, error) — counted the way the tool LISTS them.

    `None` means the directory itself could not be read: an unknown count is
    never written as zero. A missing `versions/` IS zero — the tool lists none.
    """
    count = 0
    try:
        with os.scandir(versions_dir) as entries:
            for entry in entries:
                if not entry.name.startswith("v"):
                    continue
                try:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    manifest = (Path(entry.path) / "manifest.json").read_text(encoding="utf-8-sig")
                except OSError:
                    continue
                try:
                    json.loads(manifest)
                except ValueError:
                    continue
                count += 1
                if count > limit:
                    return limit, True, None
        return count, False, None
    except FileNotFoundError:
        return 0, False, None
    except OSError as exc:
        return None, False, _safe_error(exc)


def cascade_store_report(shared_path, now, limit: int = DEFAULT_LIMIT) -> dict:
    """What `<tree>/claudish-cascade` holds, read with the tool's own rules (T10).

    `status` is one of:
      present       the store directory is there — the tool's `store_present: true`
      absent        the tree is on this seat and holds no store directory
      tree-missing  the tree itself is not on this seat: nothing was measured here
      error         the tree could not be examined

    Nothing is guessed from a partial read: an uncountable `versions/` gives
    `versions: None`, and a head the tool would read as `null` is named
    `pointer: absent` or `pointer: unreadable`.
    """
    out = {
        "status": None, "versions": None, "latest": None, "published_at": None,
        "age_h": None, "pointer": None, "truncated": False, "error": None,
    }
    try:
        if not Path(shared_path).is_dir():
            out["status"] = "tree-missing"
            return out
        store = Path(shared_path) / CASCADE_STORE_SUBDIR
        if not store.is_dir():
            out["status"] = "absent"
            return out
    except OSError as exc:
        out["status"], out["error"] = "error", _safe_error(exc, shared_path)
        return out

    out["status"] = "present"
    out["versions"], out["truncated"], out["error"] = _count_versions(store / "versions", limit)

    pointer = store / CASCADE_POINTER
    try:
        raw = pointer.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        out["pointer"] = "absent"
        return out
    except OSError as exc:
        out["pointer"] = "unreadable"
        out["error"] = out["error"] or _safe_error(exc, shared_path)
        return out
    try:
        data = json.loads(raw)
    except ValueError as exc:
        out["pointer"] = "unreadable"
        out["error"] = out["error"] or _safe_error(exc)
        return out
    # What the tool requires of a pointer before it reads one.
    if (not isinstance(data, dict) or not isinstance(data.get("dirName"), str)
            or not isinstance(data.get("payloadPath"), str)):
        out["pointer"] = "unreadable"
        return out
    out["pointer"] = "ok"
    label = data.get("version")
    if isinstance(label, str) and _VERSION_RE.fullmatch(label):
        out["latest"] = label
    published = data.get("publishedAt")
    published = _aware(_parse_ts(published)) if isinstance(published, str) else None
    if published is not None:
        out["published_at"] = _iso(published)
        out["age_h"] = round((now - published).total_seconds() / 3600.0, 1)
    return out


# --- the comparison -------------------------------------------------------


def probe(*, process_value, user_value, user_error, machine, now, snapshot_fn,
          case_insensitive=None, user_notes=None, cascade_fn=None) -> tuple[dict, int]:
    """Build the report and its exit code. Pure: every input is injected.

    `snapshot_fn(shared_path, machine)` returns
    `{"exists", "newest", "age_h", "files"[, "truncated"]}`.
    `cascade_fn(shared_path)` returns a `cascade_store_report` entry; omitted, the
    report says `not-probed` for every tree instead of staying silent about it.
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
        if cascade_fn is None:
            # No reader injected: say so, rather than let a missing line read as "absent".
            cascade = {"status": "not-probed"}
        else:
            try:
                cascade = dict(cascade_fn(raw[source_layer]))
            except Exception as exc:  # noqa: BLE001 - an unreadable store is a finding, not a crash
                cascade = {"status": "error", "error": _safe_error(exc, raw[source_layer])}
        snapshots.append({**entry, **snap, "cascade": cascade})

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

    # Which trees hold the cascade canon store (T10). `divergent` is None — not
    # False — whenever the question was not asked or a tree could not answer.
    with_store, without_store, unmeasured = [], [], []
    for snap in snapshots:
        cascade = snap["cascade"]
        if cascade["status"] == "not-probed":
            continue
        who = snap["layers"][0] if len(snap["layers"]) == 1 else "both"
        if cascade["status"] == "present":
            with_store.append(who)
        elif cascade["status"] == "absent":
            without_store.append(who)
        else:
            unmeasured.append(who)
    cascade_summary = {
        "probed": bool(with_store or without_store or unmeasured),
        "divergent": None,
        "with_store": with_store,
        "without_store": without_store,
        "unmeasured": unmeasured,
    }
    if cascade_summary["probed"] and not unmeasured:
        cascade_summary["divergent"] = bool(with_store) and bool(without_store)
        if cascade_summary["divergent"]:
            notes.append(
                "the cascade canon store is under ONE tree only (named by: %s): "
                "`roosync_claudish_cascade list` answers `store_present: false` from a "
                "reader bound to the other tree — that absence is a seat reading, "
                "never a fleet fact" % ", ".join(with_store)
            )

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
        "cascade": cascade_summary,
        "notes": notes,
    }
    return report, EXIT_CODES[verdict]


# --- rendering ------------------------------------------------------------


def _consoles_word(layer: str) -> str:
    return "the process tree" if layer == "process" else ("the user tree" if layer == "user" else "both layers")


def _cascade_words(cascade: dict) -> str:
    """One line per tree for the canon store. A tree that answered nothing says so (T10)."""
    status = cascade.get("status")
    if status == "tree-missing":
        return "tree not on this seat — store unmeasured"
    if status == "absent":
        return "no canon store under this tree"
    if status != "present":
        return "UNMEASURED" if not cascade.get("error") else "UNMEASURED — %s" % cascade["error"]
    words = []
    count = cascade.get("versions")
    words.append("versions uncounted" if count is None
                 else "%d version%s" % (count, "" if count == 1 else "s"))
    pointer = cascade.get("pointer")
    if pointer == "ok":
        if cascade.get("latest"):
            age = cascade.get("age_h")
            words.append("latest %s, published %s%s" % (
                cascade["latest"], cascade.get("published_at") or "at an unreadable date",
                "" if age is None else " (%.1f h old)" % age))
        else:
            words.append("pointer holds no version label")
    elif pointer == "absent":
        words.append("no head pointer")
    elif pointer == "unreadable":
        words.append("head pointer unreadable")
    if cascade.get("truncated"):
        words.append("SCAN TRUNCATED")
    if cascade.get("error"):
        words.append("ERROR %s" % cascade["error"])
    return ", ".join(words)


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
    # T10: only trees that were actually asked — a tree nobody probed prints nothing,
    # so an unprinted line can never be misread as "no store under this tree".
    cascades = [s for s in report["snapshots"]
                if s.get("cascade") and s["cascade"].get("status") != "not-probed"]
    if cascades:
        lines.append("cascade   canon store under each tree")
        for snap in cascades:
            lines.append("  %s  %s" % (snap["tree"].ljust(width), _cascade_words(snap["cascade"])))
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
        cascade_fn=lambda path: cascade_store_report(path, now, limit=args.limit),
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(render(report))
    return code


if __name__ == "__main__":
    sys.exit(main())
