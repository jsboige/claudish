#!/usr/bin/env python3
r"""Settings-path witness (claudish #291) — is the DECLARED client path the
LIVE one?

#291 exists because a per-machine traffic path verified one day was silently
different days later and nobody noticed: on myia-po-2023 the 2026-10-01 relay
switch (`ANTHROPIC_BASE_URL=http://127.0.0.1:3000`) was applied, then absent
from the live settings while `_intentional_diffs` still declared it as the
intent (measured 2026-10-06). The contradiction is mechanically detectable —
this script detects it, on any machine, read-only.

What it compares, per settings file:

  env.ANTHROPIC_BASE_URL            the LIVE value the clients actually use
  _intentional_diffs.ANTHROPIC_BASE_URL
                                    the DECLARED intent — the fleet writes it
                                    as `<url> = <prose>` (URL first, then a
                                    human explanation); at least one entry in
                                    the wild carries the prose FIRST with the
                                    URL after the `=`. Both shapes are read,
                                    and the prose fallback takes the LAST URL
                                    (annotations say "old X replaced by Y" —
                                    the operative path is the last one named).

Scope: this reads the GLOBAL file (~/.claude/settings.json). A
`settings.local.json` or a project `.claude/settings.json` can override `env`
for one workspace — on the machine this witness was built on, none does
(measured 2026-10-06); read a `match` as "the global intent is in force",
not as "every project reaches that path".

Verdicts (one line each, first column is the machine-readable token):

  match              declared URL == live URL — the intent is in force
  CONTRADICTION      both present, different — a silent revert OR a stale
                     annotation; the two must agree before either is trusted.
                     A live value with no URL shape (a token pasted by
                     mistake) is CONTRADICTION against any declared URL.
  live-only          live value present, no declared diff (nothing to check)
  intent-only        declared diff, no live value (settings lost the key)
  absent             neither — the clients take the canon default

A schemeless `host:port` live value (`127.0.0.1:3000`, the curl form) is
compared as its `http://` equivalent, so it does not fake a contradiction
against a schemed declaration.

Exit codes: 0 = no contradiction · 1 = at least one contradiction · 2 = the
file is missing or unparsable — a malformed settings file (root or `env` not
a JSON object) is UNREADABLE, exit 2, never exit 1: a reader that cannot read
must not render as either "clean" or "contradicted".

Secrets: this script prints ONLY the two base URLs, with any userinfo
(`https://user:pass@host`) masked to `https://***@host` on every output path,
text and --json. `settings.json` holds auth tokens; nothing else from it is
ever echoed, and a live value that does not look like a URL at all is
reported as `no-url` rather than printed whole.

Read-only, replayable:
    python scripts/verify-settings-path.py                       # ~/.claude/settings.json
    python scripts/verify-settings-path.py --settings <path>     # any machine's file
    python scripts/verify-settings-path.py --json
"""

import argparse
import json
import os
import re
import sys

KEY = "ANTHROPIC_BASE_URL"
URL_RE = re.compile(r"^\s*([a-z][a-z0-9+.-]*://[^\s]+)", re.I)
# Unanchored twin for the prose-first shape — `^` in a .search() still anchors
# to the string start, so the fallback needs its own pattern.
URL_ANY_RE = re.compile(r"([a-z][a-z0-9+.-]*://[^\s]+)", re.I)
# The curl form of a base URL: no scheme, but a host and a numeric port.
HOSTPORT_RE = re.compile(r"^\s*([A-Za-z0-9.-]+:\d+(?:/[^\s]*)?)$")
# `//user:pass@` — Basic-auth userinfo rides real fleet URLs (SEARXNG_URL);
# a BASE_URL carrying it must not leak it into a dashboard or the #291 matrix.
# R0 (#369 review): the class deliberately allows `@` and admits ZERO chars —
# `//@host` (empty userinfo) and `//@secret@host` (a second `@` inside the
# userinfo) masked too. The earlier `//[^/@\s]+@` demanded one non-@ char
# first and let `//@secret@host` through whole; `[^/\s]` stops at the path, so
# an `@` in the path alone still never triggers a mask.
USERINFO_RE = re.compile(r"//[^/\s]*@")

NO_URL = "no-url"


def mask_url(u):
    """Userinfo never reaches an output (dashboards, matrices) — mask, keep the host."""
    if not isinstance(u, str):
        return u
    return USERINFO_RE.sub("//***@", u)


def normalize_url(u):
    """Compare the curl form and the schemed form as one path."""
    if u and "://" not in u:
        u = "http://" + u
    return u.rstrip("/") if u else u


def declared_url(diff_value):
    """The leading URL of a `_intentional_diffs` entry, or None.

    The fleet writes these as `<url> = <prose>` — and at least one entry in
    the wild carries the prose FIRST with the URL after the `=`. Both shapes
    are read; the prose fallback takes the LAST URL in the string (an
    annotation that names an old path then its replacement declares the
    replacement, not the old path). A value with no URL at all is None,
    never invented.
    """
    if not isinstance(diff_value, str):
        return None
    m = URL_RE.search(diff_value.split("=", 1)[0])
    if m:
        return m.group(1).rstrip("/")
    urls = URL_ANY_RE.findall(diff_value)
    return urls[-1].rstrip("/") if urls else None


def live_url(env_value):
    """The live base URL, None when absent/blank, NO_URL when it has no URL shape.

    A blank is not a path. A non-URL token (a credential pasted into the wrong
    slot) is `no-url` — reported, never echoed whole. A schemeless host:port
    is a path (the curl form) and is kept as-is for display.
    """
    if not isinstance(env_value, str):
        return None
    v = env_value.strip()
    if not v:
        return None
    m = URL_RE.match(v)
    if m:
        return m.group(1).rstrip("/")
    m = HOSTPORT_RE.match(v)
    if m:
        return m.group(1).rstrip("/")
    return NO_URL


def classify(env_value, diff_value):
    """(verdict, live, declared) — the whole decision, pure and testable."""
    live = live_url(env_value)
    declared = declared_url(diff_value)
    if live and declared:
        same = normalize_url(live) == normalize_url(declared)
        return ("match" if same else "CONTRADICTION"), live, declared
    if live and not declared:
        return "live-only", live, None
    if declared and not live:
        return "intent-only", None, declared
    return "absent", None, None


#: verdict → exit-bit. Only CONTRADICTION fails the run: a missing declaration
#: is a state to report, not a defect to alarm on.
FAILING = {"CONTRADICTION"}


def check_file(path):
    """[(key, verdict, live, declared)] for one settings file.

    A root that is not a JSON object, or an `env` that is not an object, is a
    ValueError — main turns it into exit 2 (unreadable), not a traceback and
    not exit 1 (a cron caller must not read "file is garbage" as
    "contradiction found").
    """
    with open(path, encoding="utf-8-sig") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError("settings root is a JSON %s, not an object" % type(data).__name__)
    env = data.get("env") or {}
    if not isinstance(env, dict):
        raise ValueError("`env` is a JSON %s, not an object" % type(env).__name__)
    diffs = data.get("_intentional_diffs") or {}
    diffs = diffs if isinstance(diffs, dict) else {}
    verdict, live, declared = classify(env.get(KEY), diffs.get(KEY))
    return [(KEY, verdict, live, declared)]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Declared vs live client path (claudish #291)")
    ap.add_argument("--settings", default=os.path.join(os.path.expanduser("~"), ".claude", "settings.json"),
                    help="settings.json to inspect (default: ~/.claude/settings.json)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)

    try:
        rows = check_file(args.settings)
    except FileNotFoundError:
        sys.stderr.write("ERROR: no settings file at %s\n" % args.settings)
        return 2
    except (ValueError, OSError) as e:
        sys.stderr.write("ERROR: %s: %s\n" % (args.settings, e))
        return 2

    if args.json:
        print(json.dumps([{"key": k, "verdict": v, "live": mask_url(l), "declared": mask_url(d)}
                          for k, v, l, d in rows], ensure_ascii=False))
    else:
        print("== %s" % args.settings)
        for k, verdict, live, declared in rows:
            print("   %-14s %s" % (verdict, k))
            print("      live     : %s" % (mask_url(live) or "(absent)"))
            print("      declared : %s" % (mask_url(declared) or "(no declared diff)"))
        if any(v in FAILING for _, v, _, _ in rows):
            print("   -> the declared intent and the live value disagree: fix the setting "
                  "or the annotation before trusting either")

    return 1 if any(v in FAILING for _, v, _, _ in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
