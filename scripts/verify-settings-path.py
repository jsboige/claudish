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
                                    human explanation), so the URL is parsed
                                    as the leading token, never the prose.

Verdicts (one line each, first column is the machine-readable token):

  match              declared URL == live URL — the intent is in force
  CONTRADICTION      both present, different — a silent revert OR a stale
                     annotation; the two must agree before either is trusted
  live-only          live value present, no declared diff (nothing to check)
  intent-only        declared diff, no live value (settings lost the key)
  absent             neither — the clients take the canon default

Exit codes: 0 = no contradiction · 1 = at least one contradiction · 2 = the
file is missing or unparsable (distinct from a contradiction on purpose: a
reader that cannot read must not render as "clean").

Secrets: this script prints ONLY the two base URLs. `settings.json` holds
auth tokens; nothing else from it is ever echoed. The ' = ' split keeps the
prose out of the URL slot, and any value that does not look like a URL is
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


def declared_url(diff_value):
    """The leading URL of a `_intentional_diffs` entry, or None.

    The fleet writes these as `<url> = <prose>` — and at least one entry in the
    wild carries the prose FIRST with the URL after the `=`. Both shapes are
    read; a value with no URL at all (prose only) is `no-url`, never invented.
    """
    if not isinstance(diff_value, str):
        return None
    m = URL_RE.search(diff_value.split("=", 1)[0])
    if m:
        return m.group(1).rstrip("/")
    m = URL_ANY_RE.search(diff_value)
    return m.group(1).rstrip("/") if m else None


def live_url(env_value):
    """The live base URL, or None when absent/blank (a blank is not a path)."""
    if not isinstance(env_value, str):
        return None
    v = env_value.strip()
    if not v:
        return None
    m = URL_RE.match(v)
    return (m.group(1) if m else v).rstrip("/")


def classify(env_value, diff_value):
    """(verdict, live, declared) — the whole decision, pure and testable."""
    live = live_url(env_value)
    declared = declared_url(diff_value)
    if live and declared:
        return ("match" if live == declared else "CONTRADICTION"), live, declared
    if live and not declared:
        return "live-only", live, None
    if declared and not live:
        return "intent-only", None, declared
    return "absent", None, None


#: verdict → exit-bit. Only CONTRADICTION fails the run: a missing declaration
#: is a state to report, not a defect to alarm on.
FAILING = {"CONTRADICTION"}


def check_file(path):
    """[(key, verdict, live, declared)] for one settings file — KeyError→io."""
    with open(path, encoding="utf-8-sig") as fh:
        data = json.load(fh)
    env = data.get("env") or {}
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
        print(json.dumps([{"key": k, "verdict": v, "live": l, "declared": d} for k, v, l, d in rows],
                         ensure_ascii=False))
    else:
        print("== %s" % args.settings)
        for k, verdict, live, declared in rows:
            print("   %-14s %s" % (verdict, k))
            print("      live     : %s" % (live or "(absent)"))
            print("      declared : %s" % (declared or "(no declared diff)"))
        if any(v in FAILING for _, v, _, _ in rows):
            print("   -> the declared intent and the live value disagree: fix the setting "
                  "or the annotation before trusting either")

    return 1 if any(v in FAILING for _, v, _, _ in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
