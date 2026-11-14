#!/usr/bin/env python3
"""Fleet ~/.claude/settings.json matrix, read from the RooSync `claude-settings` snapshots.

The coordinator must know what every roster machine's settings.json holds
(user mandate, 20/10). Each machine publishes a masked snapshot with
`roosync_config(action:"publish", targets:["claude-settings"])`; this script
reads the latest one per machine, with the same lookup order as RSM's
findLatestClaudeSettingsSnapshot (standalone -> latest.json -> versioned
packages by collectedAt), and flags what needs a look.

Never prints a secret marker: a sensitive env key is shown as its NAME plus
set/empty/unset. The snapshot's `<set:len=N:sha256=x>` digest is dropped,
since a length or digest is secret-derived metadata.

Blind spot (as of 20/10): an env key that is neither allow-listed nor
"sensitive" leaves no trace in the snapshot (12/25 names on ai-01, among them
CLAUDE_CODE_SUBAGENT_MODEL). The per-lane shape line in the coordinator
reference (Phase 2) covers it until RSM publishes the names.

Second blind spot (as of 05/11): `permissions` reaches the snapshot as a bare
NAME in `otherTopLevelKeys`, its content never. The deny list (`Artifact`,
`Workflow`, the plan modes...) is invisible here, and its absence from this
output says nothing about the seat. Measured 05/11: a fleet ASK read "no
Artifact/Workflow deny on any machine" off this matrix, while ai-01, po-2024
and po-2028 each carried all four entries in their live settings.json. The
script now says so on every run (`permission_lines`/`permission_flags`).

Usage: settings-matrix.py [--shared DIR] [--stale-hours 48] [--canon-stale-hours 24]
                          [--cascade-container NAME | --cascade-env-file PATH]
                          [--cascade-canon FILE] [--show-cascade-values]
                          [--write-cascade-canon FILE] [machine ...]
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess

DEFAULT_MACHINES = [
    "myia-ai-01", "myia-po-2023", "myia-po-2024", "myia-po-2025",
    "myia-po-2027", "myia-po-2028", "myia-web1", "myia-web2",
]
# A present, non-empty value here makes the client send a credential of its own
# choosing instead of its Anthropic login: the #296 shape-B class (po-2028, 20/10).
CREDENTIAL_KEYS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")
# Values with a decided canon: a machine off it is flagged, whatever the others hold.
# The fleet compaction window sits BELOW Swift's limit (swift-1.5-27b, 262 144
# tokens, onboarded as a haiku lane), with a turn of margin: the previous canon,
# 263000, sat 856 tokens above it, so compaction could never fire before a
# vllm-routed session left the window (user 23/10, Q58: "erreur grossiere, oui
# tu redescends"). ai-01 alone runs higher on purpose (user 20/10).
# Lowered on 05/11 to 230000 / 300000 (user ~08:41Z, verbatim relayed by
# myia-po-2025:claudish on `global` at 08:54Z: "l'inflation des seuils a
# accompagné celle des coûts"). The value is `<<preserve-local>>` in the global
# canon, so Deploy does not carry it: each seat edits its own file, and this
# flag is how a seat still on 250000 / 330000 gets seen.
CANON = {
    "env.CLAUDE_CODE_AUTO_COMPACT_WINDOW": {"*": "230000", "myia-ai-01": "300000"},
}
# Values compared across the fleet; any divergence is listed.
COMPARED = (
    "env.ANTHROPIC_CUSTOM_MODEL_OPTION",
    "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
    "env.ANTHROPIC_DEFAULT_SONNET_MODEL",
    "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "env.ANTHROPIC_DEFAULT_FABLE_MODEL",
    "model",
    "outputStyle",
)
# Model display labels (user mandate 22/10). The picker row shows
# ANTHROPIC_DEFAULT_<ROLE>_MODEL_NAME; when that variable is missing Claude Code
# falls back to the built-in Anthropic name for the pinned id -- the
# "Sonnet 5.5 (1M)" a seat displayed while actually serving glm. Canon (coordinator
# ACK, 22/10): _NAME "Rôle <Role>" plus a generic _DESCRIPTION naming no concrete
# model, for the 4 roles.
ROLES = ("opus", "sonnet", "haiku", "fable")
# Opus is native-Anthropic in nominal, so its canon description legitimately says
# "Anthropic"; the other roles are cascade-served and must not carry Anthropic
# marketing wording.
NATIVE_NOMINAL_ROLES = ("opus",)
# Custom-option canon (coordinator ACK 23/10, superseding the 22/10 "po-2025 only"
# rule): measurement beat the canon -- 7 of 8 seats declared a Sol (gpt-5.6-sol x4,
# gpt-6-sol x2) and the one qwen3.8-max was po-2027's own stale entry (fixed in
# place the same day). A custom, WHERE declared, must be a Sol id; qwen3.8-max is
# forbidden (user 22/10: too expensive on the Alibaba/Qwen token plan, never used).
# Harmonized upward on 24/10 (user: "gpt-5.6-sol, c'est obsolète, on harmonise par
# le haut"): the canon is the newest Sol id the hub routes; the older spellings still
# route to it, but a seat carrying one is behind and gets its own flag, distinct
# from the forbidden class.
CANON_CUSTOM_OPTIONS = ("gpt-6.1-sol",)
OBSOLETE_SOL_OPTIONS = ("gpt-5.6-sol", "gpt-6-sol")
# A canon description starts with "Rôle " and may still mention "Anthropic natif"
# (fable's canon wording says exactly that, to deny it); a description NOT in the
# canon shape that names Anthropic is the marketing drift ("Anthropic Fable 5.1
# (SOTA)", still live on seats as of 22/10).
CANON_DESCRIPTION_PREFIX = "Rôle "

LABEL_KEYS = tuple(
    key
    for role in ROLES
    for key in (
        "env.ANTHROPIC_DEFAULT_%s_MODEL_NAME" % role.upper(),
        "env.ANTHROPIC_DEFAULT_%s_MODEL_DESCRIPTION" % role.upper(),
    )
) + (
    "env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    "env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
)


def read_snapshot(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            snap = json.load(f)
    except (OSError, ValueError):
        return None
    if isinstance(snap, dict) and snap.get("format") == 1 and "harmonization" in snap:
        return snap
    return None


def latest_snapshot(shared, machine):
    cdir = os.path.join(shared, "configs", machine)
    if not os.path.isdir(cdir):
        return None
    standalone = read_snapshot(os.path.join(cdir, "claude-settings", "claude-settings.json"))
    if standalone:
        return standalone
    try:
        with open(os.path.join(cdir, "latest.json"), encoding="utf-8-sig") as f:
            pointer = json.load(f).get("path")
        if pointer:
            snap = read_snapshot(os.path.join(pointer, "claude-settings", "claude-settings.json"))
            if snap:
                return snap
    except (OSError, ValueError, AttributeError):
        pass
    best = None
    for entry in os.listdir(cdir):
        if not entry.startswith("v"):
            continue
        snap = read_snapshot(os.path.join(cdir, entry, "claude-settings", "claude-settings.json"))
        # ISO-8601 strings compare in date order; RSM parses dates and tie-breaks
        # lexically -- same winner unless two versions share a collectedAt.
        if snap and (best is None or snap.get("collectedAt", "") > best.get("collectedAt", "")):
            best = snap
    return best


def presence(marker):
    if marker in (None, "<unset>"):
        return "unset"
    return "empty" if marker == "<empty>" else "set"


# A credential that is DECLARED but VALUELESS (an empty string) is a third shape,
# distinct from #296's shape B (a real credential the client would send). Measured
# on myia-po-2023, 30/10: ANTHROPIC_AUTH_TOKEN = "" in the seat's settings.json --
# the matrix printed it as "empty" and flagged nothing. It never reaches the proxy
# (the cluster key `x-proxy-key` authenticates the request: the hub answered 200
# with an empty bearer AND with no authorization header at all), but every
# SDK-based probe inherits the seat's env and dies on it -- httpx refuses to send
# an invalid header value ("Illegal header value b'Bearer '"). The Claude Code
# client itself is unaffected. Flag it: it is invisible, and it breaks tooling.
CREDENTIAL_SHAPES = {
    "set": "is set (client sends its own credential, #296 shape B)",
    "empty": (
        "is declared but valueless (empty string) -- an SDK client inherits it and "
        "dies on the invalid `Bearer ` header it builds; the proxy never sees it "
        "(the cluster key authenticates), measured 30/10 po-2023"
    ),
}


def credential_flags(machine, masked):
    """Flags for the credential shapes, by masked presence marker.

    `masked` is the snapshot's `maskedEnvKeys` map (name -> "<set>" / "<empty>" /
    "<unset>"): the value is never read, only its presence class."""
    flags = []
    for key, marker in sorted((masked or {}).items()):
        if key not in CREDENTIAL_KEYS:
            continue
        shape = CREDENTIAL_SHAPES.get(presence(marker))
        if shape:
            flags.append("%s: env.%s %s" % (machine, key, shape))
    return flags


def age_hours(iso, now):
    try:
        then = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    return (now - then).total_seconds() / 3600


# A flag read from a STALE snapshot is not a measurement of the seat (Refs #291).
# On 11-12/11 the coordinator's bilans published 330000 (ai-01, po-2023) and
# 250000 (po-2028) as "off canon", read from RooSync snapshots older than the
# live settings.json files. Read live, those seats were AT canon; the one real
# gap was po-2027 (330000 until it applied the canon at 10:20Z on 12/11). A
# snapshot's value can only testify about the
# seat at `collectedAt`; past a threshold the matrix must send the reader to
# the live file, never render the gap as an observed off-canon.
CANON_STALE_HOURS_DEFAULT = 24.0


def canon_flag(machine, key, actual, expected, age, threshold):
    """One CANON flag, qualified by the age of the snapshot it was read from.

    Within `threshold` hours the flag is a measured divergence (and still says
    its age). Beyond it -- or when `collectedAt` cannot be parsed, so the
    snapshot cannot be dated at all -- the flag reports an expired reading and
    points at the live file; it must NOT read as an off-canon measurement.
    """
    age_txt = "age unknown" if age is None else f"age {age:.1f}h"
    if age is None or age > threshold:
        return (
            f"{machine}: {key} = {json.dumps(actual)} -- snapshot STALE ({age_txt}, "
            f"threshold {threshold:g}h): re-read live, not a measured divergence "
            f"(canon {json.dumps(expected)})"
        )
    return (
        f"{machine}: {key} = {json.dumps(actual)} off canon "
        f"(expected {json.dumps(expected)}; snapshot {age_txt})"
    )


def label_lines(harmonization):
    """Printable inventory of the display-label keys. None of them is secret.

    A key the snapshot does not carry is shown as the collector blind spot, not
    skipped: until RSM publishes these names, absence must read as "invisible
    to this instrument", never as compliance.
    """
    lines = []
    for key in LABEL_KEYS:
        value = harmonization.get(key)
        if value is None:
            lines.append("  %s: not published (collector blind spot)" % key)
        else:
            lines.append("  %s = %s" % (key, json.dumps(value, ensure_ascii=False)))
    return lines


def label_flags(harmonization, machine, names_visible=True):
    """Canon flags for the display labels. Fires live wherever the snapshot can
    see the key; a role pinned but with no published _NAME is the exact
    "Sonnet 5.5 (1M)" fallback class.

    `names_visible=False` means no snapshot of the run carries any label key:
    the collector does not publish them, so an ABSENT _NAME says nothing about
    the seat and is not flagged here (main() prints one fleet line instead). A
    present-but-empty _NAME is still flagged -- the snapshot did see that one.
    """
    flags = []
    for role in ROLES:
        upper = role.upper()
        name_key = "env.ANTHROPIC_DEFAULT_%s_MODEL_NAME" % upper
        desc_key = "env.ANTHROPIC_DEFAULT_%s_MODEL_DESCRIPTION" % upper
        pinned = harmonization.get("env.ANTHROPIC_DEFAULT_%s_MODEL" % upper)
        if (
            pinned is not None
            and not harmonization.get(name_key)
            and (names_visible or name_key in harmonization)
        ):
            flags.append(
                "role %s: pinned to %s with no published _MODEL_NAME -- a seat without "
                "one shows the built-in Anthropic name (the \"Sonnet 5.5 (1M)\" class)"
                % (role, json.dumps(pinned))
            )
        if role not in NATIVE_NOMINAL_ROLES:
            description = harmonization.get(desc_key)
            if (
                isinstance(description, str)
                and "anthropic" in description.lower()
                and not description.startswith(CANON_DESCRIPTION_PREFIX)
            ):
                flags.append(
                    "role %s: description names Anthropic on a cascade-served role: %s"
                    % (role, json.dumps(description, ensure_ascii=False))
                )
    option = harmonization.get("env.ANTHROPIC_CUSTOM_MODEL_OPTION")
    if option in OBSOLETE_SOL_OPTIONS:
        flags.append(
            "custom option %s is an obsolete Sol id (canon %s)"
            % (json.dumps(option, ensure_ascii=False), str(CANON_CUSTOM_OPTIONS))
        )
    elif option and option not in CANON_CUSTOM_OPTIONS:
        flags.append(
            "custom option %s is not a canon Sol id %s (qwen3.8-max class: forbidden)"
            % (json.dumps(option, ensure_ascii=False), str(CANON_CUSTOM_OPTIONS))
        )
    return flags


PERMISSIONS_KEY = "permissions"


def permissions_published(harmonization):
    """True when the snapshot carries any of the permissions CONTENT."""
    return any(
        key == PERMISSIONS_KEY or key.startswith(PERMISSIONS_KEY + ".") for key in harmonization
    )


def permission_lines(snap):
    """Per-machine line for the permissions block. Absence of the content must
    read as "invisible to this instrument", never as "no deny entry"."""
    harmonization = snap.get("harmonization", {})
    if permissions_published(harmonization):
        return []
    if PERMISSIONS_KEY in (snap.get("otherTopLevelKeys") or []):
        return [
            "  permissions: present on the seat, content not published (collector blind spot) "
            "-- the deny list is unverifiable here, read settings.json on the seat"
        ]
    return ["  permissions: absent from the snapshot"]


def permission_flags(snaps):
    """One fleet line while no snapshot publishes the permissions content."""
    present = [s for s in snaps if s and PERMISSIONS_KEY in (s.get("otherTopLevelKeys") or [])]
    if present and not any(permissions_published(s.get("harmonization", {})) for s in snaps if s):
        return [
            "permissions content published by no snapshot (collector blind spot) -- "
            "a deny entry (Artifact, Workflow, plan modes) is unverifiable from this matrix; "
            "a claim of absence needs the seat's own settings.json"
        ]
    return []


# ---------------------------------------------------------------------------
# Container cascades (#711 grain 2, Refs #764 criterion 7).
#
# The settings snapshots above say nothing about the budget-failover env of a
# seat's container -- the values live at create time (#310), not in
# settings.json. The coordinator's recurrent control is this section: read the
# container's `CLAUDISH_FAILOVER_*` BY VALUE, publish ONE FINGERPRINT per
# variable, and flag a deviation from the canon -- where the canon file is
# produced by the seat that reads the hub (po-2025), never composed here
# (#711 tenue: "le canon se lit sur le hub, par valeur, jamais ici").
#
# Two rules this section carries by construction:
#   - it never prints a secret. The container's full `printenv` is filtered
#     inside this process (CLAUDISH_PROXY_KEY, provider keys: dropped before
#     anything can format them); a cascade VALUE is a model id, a role or a
#     machine name, and even those are fingerprints unless
#     --show-cascade-values is passed.
#   - a count is never the test (the grain's own wording: "un changement de
#     valeur a nombre de variables egal" must break). Comparison is
#     name -> sha8(value); a count-equal edit still moves exactly one
#     fingerprint.
CASCADE_PREFIX = "CLAUDISH_FAILOVER_"
FAILOVER_ROLES = ("opus", "sonnet", "haiku", "fable")
# Decorators are role-SUFFIXED in the live container (`SONNET_LABEL`,
# `FABLE_DIRECTION`, `FABLE_RESET`...), and the switch family is open
# (`SESSION_DWELL_MS`, `ARM_AFTER`, `WALK_BUDGET_MS`...). So the cascades are
# named POSITIVELY -- the four roles, nothing inferred -- and every other name
# is treated as a switch/decorator. The inverse guess (anything not in a
# hardcoded decorator list is a cascade) turned `SESSION_DWELL_MS=600000` into
# a one-step cascade "600000", measured on the first real render, 14/11.
_CASCADE_STEP_RE = re.compile(r"^(?:role:([a-z][a-z0-9_-]*)|[^\s>@]+@[^\s>]+)$")


def fingerprint(value):
    """8 hex chars -- enough to catch a one-token edit, short enough to read."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]


def parse_env_dump(text):
    """`NAME=VALUE` lines -> {short_name: value}, `CLAUDISH_FAILOVER_*` ONLY.

    Filtering happens here, in the process, so a credential living in the same
    environment is never carried past this function -- the caller cannot print
    what was never kept. The suffix (SONNET, HAIKU, ...) is the key, matching
    the issue's table.
    """
    env = {}
    for line in text.splitlines():
        line = line.rstrip("\r")
        name, sep, value = line.partition("=")
        if not sep or not name.startswith(CASCADE_PREFIX):
            continue
        env[name[len(CASCADE_PREFIX):]] = value
    return env


def read_cascade_env(container):
    """(env, error). `docker exec NAME printenv`, filtered by parse_env_dump.

    A container read is a create-time snapshot (#310): it measures what the
    running process holds, which is exactly what a cascade control needs.
    """
    try:
        proc = subprocess.run(
            ["docker", "exec", container, "printenv"],
            capture_output=True, text=True, encoding="utf-8", timeout=20,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {}, "%r" % (exc,)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        return {}, "docker exec exit %d (%s)" % (
            proc.returncode, detail[-1][:160] if detail else "no output")
    return parse_env_dump(proc.stdout), None


def is_cascade(var):
    """True only for the four role cascades -- never inferred by exclusion.

    Env suffixes are UPPERCASE (`SONNET`); the role vocabulary is lowercase.
    Comparing them as-is silently matched nothing, and every structural check
    went quiet while the pins still had a green look -- measured 14/11.
    """
    return var.lower() in FAILOVER_ROLES


def cascade_steps(value):
    return [step.strip() for step in value.split(">")] if value else []


def structural_flags(env):
    """Canon-free checks: a cascade that cannot be what it claims to be.

    These catch what a value comparison cannot name -- a typo'd role, a step
    that is not a step, a LABEL/DIRECTION whose segment count no longer matches
    its cascade (the hub's own 05/11 row checked exactly this).
    """
    flags = []
    auto = env.get("AUTO")
    if auto not in (None, "", "0", "1"):
        flags.append("cascade AUTO = %s is neither 0 nor 1" % json.dumps(auto))
    role_models = env.get("ROLE_MODELS")
    if role_models:
        for entry in role_models.replace(",", " ").split():
            model_id, sep, role = entry.rpartition(":")
            if not sep or not model_id:
                flags.append("cascade ROLE_MODELS entry %s is not <id>:<role>"
                             % json.dumps(entry))
            elif role not in FAILOVER_ROLES:
                flags.append("cascade ROLE_MODELS maps %s to unknown role %s"
                             % (json.dumps(model_id), json.dumps(role)))
    for var, value in sorted(env.items()):
        if not is_cascade(var):
            continue
        steps = cascade_steps(value)
        for step in steps:
            match = _CASCADE_STEP_RE.match(step)
            if not match:
                flags.append("cascade %s: step %s is neither provider@model nor role:<r>"
                             % (var, json.dumps(step)))
            elif match.group(1) and match.group(1) not in FAILOVER_ROLES:
                flags.append("cascade %s: delegates to unknown role %s"
                             % (var, json.dumps(match.group(1))))
        for family in ("LABEL", "DIRECTION"):
            decorated = env.get("%s_%s" % (var, family))
            if decorated and value and len(cascade_steps(decorated)) != len(steps):
                flags.append(
                    "cascade %s: %s_%s has %d segment(s) for %d step(s)"
                    % (var, var, family, len(cascade_steps(decorated)), len(steps)))
    return flags


def canon_deviations(env, canon):
    """Per-variable deviation against `{name: sha8}`. NEVER a count test.

    Counts are equal in the failure this exists for: a one-token edit on a live
    cascade keeps every name and every name's position.
    """
    flags = []
    for name in sorted(set(env) | set(canon)):
        if name not in env:
            flags.append("cascade %s: declared in the canon, absent from the container" % name)
        elif name not in canon:
            flags.append("cascade %s: present in the container, undeclared in the canon" % name)
        elif fingerprint(env[name]) != canon[name]:
            flags.append("cascade %s: sha8 %s off canon %s"
                         % (name, fingerprint(env[name]), canon[name]))
    return flags


def cascade_lines(env, show_values):
    """One line per variable: fingerprint always, value only on request."""
    if not env:
        return ["  none declared (no %s* in the source)" % CASCADE_PREFIX]
    lines = []
    for name in sorted(env):
        value = env[name]
        line = "  %s sha8=%s %s" % (
            name, fingerprint(value), "len=%d" % len(value) if value else "(empty)")
        if show_values and value:
            line += " = %s" % value
        lines.append(line)
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--shared", default=os.environ.get("ROOSYNC_SHARED_PATH", ""))
    ap.add_argument("--stale-hours", type=float, default=48.0)
    ap.add_argument(
        "--canon-stale-hours", type=float, default=CANON_STALE_HOURS_DEFAULT,
        help="age in hours past which an off-canon reading is reported as an "
             "expired snapshot to re-read live, never as a measured off-canon "
             "(default 24, Refs #291)",
    )
    ap.add_argument("machines", nargs="*", default=DEFAULT_MACHINES)
    ap.add_argument(
        "--cascade-container", metavar="NAME",
        help="also read the budget-failover env BY VALUE from this container "
             "(`docker exec NAME printenv`, CLAUDISH_FAILOVER_* kept, the rest "
             "dropped before it can be printed)",
    )
    ap.add_argument(
        "--cascade-env-file", metavar="PATH",
        help="same variables from a saved `printenv` dump (offline reading of a "
             "seat's container, and the tests' seam -- no docker needed)",
    )
    ap.add_argument(
        "--cascade-canon", metavar="PATH",
        help="JSON {name: sha8} expected fingerprints; produced by the seat that "
             "reads the hub (never composed here) and compared per variable -- "
             "a count-equal value change still breaks",
    )
    ap.add_argument(
        "--show-cascade-values", action="store_true",
        help="print each cascade value next to its fingerprint (model ids, roles, "
             "machine names -- never a credential)",
    )
    ap.add_argument(
        "--write-cascade-canon", metavar="PATH",
        help="write this source's fingerprints as a canon file (the hub-reading "
             "seat's side of the loop)",
    )
    args = ap.parse_args()
    if not args.shared:
        ap.error("--shared or ROOSYNC_SHARED_PATH is required")

    now = dt.datetime.now(dt.timezone.utc)
    flags, seen = [], {key: {} for key in COMPARED}
    snaps = {machine: latest_snapshot(args.shared, machine) for machine in args.machines}
    # Until the collector publishes the label keys, every pinned role reads as
    # name-less on every seat: 4 flags x 8 machines carrying no information,
    # burying the flags that do (measured on the first run, 22/10). One fleet
    # line instead, until any snapshot carries a label key.
    names_visible = any(
        key in snap.get("harmonization", {}) for snap in snaps.values() if snap for key in LABEL_KEYS
    )
    if not names_visible:
        flags.append(
            "label keys published by no snapshot (collector blind spot) -- picker-fallback "
            "check suspended fleet-wide, an absent _MODEL_NAME is unverifiable"
        )
    flags.extend(permission_flags(list(snaps.values())))
    for machine in args.machines:
        snap = snaps[machine]
        print(f"=== {machine}")
        if not snap:
            print("  NOT COVERED: no claude-settings snapshot published")
            flags.append(f"{machine}: NOT COVERED")
            continue
        hours = age_hours(snap.get("collectedAt"), now)
        print(f"  collectedAt={snap.get('collectedAt')} state={snap.get('state')}")
        if hours is None or hours > args.stale_hours:
            flags.append(f"{machine}: snapshot stale ({snap.get('collectedAt')})")
        if snap.get("state") != "ok":
            flags.append(f"{machine}: settings state={snap.get('state')}")
        harmonization = snap.get("harmonization", {})
        for key, value in sorted(harmonization.items()):
            # Display labels are rendered below, including missing-key coverage.
            if key not in LABEL_KEYS:
                print(f"  {key} = {json.dumps(value, ensure_ascii=False)}")
        for key in COMPARED:
            if key in harmonization:
                seen[key].setdefault(json.dumps(harmonization[key], ensure_ascii=False), []).append(machine)
        for key, canon in CANON.items():
            expected = canon.get(machine, canon["*"])
            actual = harmonization.get(key)
            if actual != expected:
                flags.append(canon_flag(
                    machine, key, actual, expected, hours, args.canon_stale_hours))
        for line in label_lines(harmonization):
            print(line)
        flags.extend(
            "%s: %s" % (machine, flag) for flag in label_flags(harmonization, machine, names_visible)
        )
        masked = snap.get("maskedEnvKeys", {})
        for key, marker in sorted(masked.items()):
            print(f"  env.{key}: {presence(marker)} (sensitive, value never shown)")
        flags.extend(credential_flags(machine, masked))
        for line in permission_lines(snap):
            print(line)
        print(f"  otherTopLevelKeys = {snap.get('otherTopLevelKeys')}")

    for key, values in seen.items():
        if len(values) > 1:
            spread = "; ".join(f"{v} x{len(ms)} ({', '.join(ms)})" for v, ms in values.items())
            flags.append(f"divergent {key}: {spread}")
    if args.cascade_container and args.cascade_env_file:
        ap.error("--cascade-container and --cascade-env-file are mutually exclusive")
    if args.cascade_container or args.cascade_env_file:
        source = args.cascade_container or args.cascade_env_file
        print("=== cascade (%s)" % (
            "container %s" % source if args.cascade_container else "env file %s" % source))
        if args.cascade_container:
            env, error = read_cascade_env(args.cascade_container)
        else:
            try:
                with open(args.cascade_env_file, encoding="utf-8") as f:
                    env, error = parse_env_dump(f.read()), None
            except OSError as exc:
                env, error = {}, "%r" % (exc,)
        if error:
            print("  UNREADABLE: %s" % error)
            flags.append("cascade: source %s unreadable (%s)" % (source, error))
        else:
            for line in cascade_lines(env, args.show_cascade_values):
                print(line)
            flags.extend(structural_flags(env))
            if args.cascade_canon:
                try:
                    with open(args.cascade_canon, encoding="utf-8") as f:
                        canon = json.load(f)
                    if not isinstance(canon, dict):
                        raise ValueError("expected a {name: sha8} object")
                except (OSError, ValueError) as exc:
                    print("  canon: UNREADABLE %r" % (exc,))
                    flags.append("cascade: canon file %s unreadable (%r)"
                                 % (args.cascade_canon, exc))
                else:
                    print("  canon: %d fingerprint(s) from %s"
                          % (len(canon), args.cascade_canon))
                    flags.extend(canon_deviations(env, canon))
            else:
                print("  canon: none supplied (fingerprints only -- rerun with "
                      "--cascade-canon to flag deviations)")
            if args.write_cascade_canon:
                try:
                    with open(args.write_cascade_canon, "w", encoding="utf-8") as f:
                        json.dump({k: fingerprint(v) for k, v in sorted(env.items())},
                                  f, indent=2, sort_keys=True)
                        f.write("\n")
                except OSError as exc:
                    flags.append("cascade: could not write canon %s (%r)"
                                 % (args.write_cascade_canon, exc))
                else:
                    print("  canon written: %s" % args.write_cascade_canon)
    elif args.cascade_canon or args.write_cascade_canon or args.show_cascade_values:
        flags.append("cascade: --cascade-canon/--write-cascade-canon/--show-cascade-values "
                     "given with no cascade source (--cascade-container or --cascade-env-file)")
    print("=== flags")
    for flag in flags or ["none"]:
        print(f"  - {flag}")


# Exit status is always 0, flags included: this is a per-cycle reading instrument,
# not a gate. A CI consumer that wants a failing mode must add one explicitly.
if __name__ == "__main__":
    main()
