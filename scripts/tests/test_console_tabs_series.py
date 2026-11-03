#!/usr/bin/env python3
r"""The console ledger must be a series you can trust, not a pile of last instants.

Three defects met on 2026-11-03, all in the same subject and all silent:

1. `provider-consoles-reader.py` OVERWROTE `readings/tab-*.txt` every 30 s, so a
   three-week question ("what did the OpenAI credits say before the resets?") had
   no answer anywhere — only the last instant survived. The reader now appends a
   consolidated row per console to this ledger, and keeps a byte copy per snapshot.
2. `log` stamped `ts` with `datetime.now()`. A backfilled reading therefore carried
   TODAY'S clock: a figure observed three weeks ago would enter the series dated
   today, which is the one failure a measurement log must never have. `--observed-at`
   now separates the instant of observation from the instant of the call.
3. The module docstring promised "every entry carries a provenance" while `log` had
   no way to write one — the claim was prose, not a property.

The tests below pin each of the three, and pin the property that matters most:
`extract()` leaves a field ABSENT rather than inventing it, and `series` NAMES the
consoles it could not read instead of printing a clean table that hides them.

Run standalone:   python scripts/tests/test_console_tabs_series.py
Or under pytest:  pytest scripts/tests/test_console_tabs_series.py
"""

import argparse
import contextlib
import importlib.util
import io
import json
import os
import tempfile
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, os.pardir, "console-tabs.py")

_spec = importlib.util.spec_from_file_location("console_tabs", _MOD_PATH)
tabs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tabs)


def _with_ledger(rows):
    """Point the module at a throwaway ledger holding `rows`, return its path."""
    fh = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
    for r in rows:
        fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    fh.close()
    tabs.READINGS = Path(fh.name)
    return fh.name


def _run(fn, **kwargs):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = fn(argparse.Namespace(**kwargs))
    return rc, buf.getvalue()


# --- extract(): declared patterns only, absence preserved -------------------

CHATGPT_LINES = [
    "Limite hebdomadaire",
    "Réinitialisation dans 1 j et 19 h",
    "4 % restants",
    "54 279 crédits restants",
    "Solde actuel",
]


def test_extract_reads_the_four_declared_fields():
    got = tabs.extract(CHATGPT_LINES)
    assert got["pct"] == "4", got
    assert got["reset"] == "1 j et 19 h", got
    assert got["credits"] == "54 279", got


def test_extract_reads_usd_from_a_payg_page():
    got = tabs.extract(["Total Spend", "$12.37", "$7.81 / $200.00"])
    assert got["usd"] == "12.37", got


def test_extract_invents_nothing_when_nothing_matches():
    # A page that loaded but says nothing we can read must yield NOTHING — the
    # alternative (a default, a zero, a carried-over value) is a fabricated figure.
    got = tabs.extract(["Paramètres", "Compte", "Déconnexion"])
    assert got == {}, got


def test_extract_ignores_a_bare_percent_and_reads_the_leftover_form():
    # The usage page prints both the remaining figure and a decorative 12 %; only the
    # "restants" form is trusted (review #834, CR (iii)). A bare `N %` is a usage
    # figure as often as a remaining one — interpreting it would silently change what
    # the `pct` column means mid-series, so it must stay ABSENT.
    got = tabs.extract(["Utilisation récente du forfait", "12 %", "4 % restants"])
    assert got["pct"] == "4", got


def test_extract_leaves_pct_absent_when_only_a_bare_percent_prints():
    # Positive control for the removal: a page whose ONLY percentage is bare falls to
    # NON INTERPRÉTÉ downstream — the honest default, not a mislabelled figure.
    got = tabs.extract(["Utilisation récente du forfait", "12 %"])
    assert "pct" not in got, got


# --- log(): ts is the instant of OBSERVATION --------------------------------


def test_log_honours_observed_at_instead_of_now():
    path = _with_ledger([])
    rc, _ = _run(tabs.cmd_log, provider="chatgpt-pro", field=["pct=4"],
                 observed_at="2026-10-11T11:18:49Z", provenance="tab-01", note=None)
    assert rc == 0
    row = json.loads(Path(path).read_text(encoding="utf-8").splitlines()[-1])
    assert row["ts"] == "2026-10-11T11:18:49Z", row
    assert row["provenance"] == "tab-01", row
    assert row["values"] == {"pct": "4"}, row


def test_log_without_observed_at_still_stamps_now():
    # Positive control for the test above: the separation only means something if
    # the default path still behaves as a live reading.
    path = _with_ledger([])
    _run(tabs.cmd_log, provider="kimi", field=["7d=100%"],
         observed_at=None, provenance=None, note=None)
    row = json.loads(Path(path).read_text(encoding="utf-8").splitlines()[-1])
    assert row["ts"].endswith("Z") and row["ts"][:4] == "2026", row
    assert "provenance" not in row, row


# --- series(): the consolidation, and what it refuses to hide ---------------


def test_series_consolidates_verbatim_rows_into_fields():
    path = _with_ledger([
        {"ts": "2026-10-31T00:44:00Z", "provider": "chatgpt-pro-codex", "status": "ok",
         "lines": CHATGPT_LINES,
         "provenance": "verbatim tab-01, 2026-10-31T00:44:00Z"},
        {"ts": "2026-11-02T22:47:02Z", "provider": "chatgpt-pro-codex", "status": "ok",
         "lines": ["4 % restants", "54 279 crédits restants"],
         "provenance": "verbatim tab-01, 2026-11-02T22:47:02Z"},
    ])
    rc, out = _run(tabs.cmd_series, provider=None, days=None, json=False)
    assert rc == 0
    assert "chatgpt-pro-codex" in out
    assert "54 279" in out
    # Two observations, both rendered, oldest first.
    lines = [l for l in out.splitlines() if l.startswith("2026-")]
    assert len(lines) == 2, out
    assert lines[0].startswith("2026-10-31"), out


def test_series_names_a_console_it_could_not_interpret():
    # A silent table would read as "that console is fine, it just has no numbers".
    _with_ledger([
        {"ts": "2026-11-02T22:47:02Z", "provider": "zai-glm-coding", "status": "ok",
         "lines": ["Gestion du plan", "Clé API"], "provenance": "verbatim tab-02"},
    ])
    rc, out = _run(tabs.cmd_series, provider=None, days=None, json=False)
    assert rc == 0
    assert "NON INTERPRÉTÉ" in out, out
    assert "zai-glm-coding" in out, out


def test_series_renders_rows_written_by_log_too():
    # Both writers feed one file; a series that only understood the reader's shape
    # would drop every human-entered reading.
    _with_ledger([
        {"ts": "2026-10-11T11:18:49Z", "provider": "chatgpt-pro",
         "values": {"weekly_left": "76%", "credits": "54279"}, "provenance": "memoire"},
    ])
    rc, out = _run(tabs.cmd_series, provider=None, days=None, json=False)
    assert rc == 0
    assert "54279" in out, out


def test_series_days_filter_drops_older_rows():
    _with_ledger([
        {"ts": "2026-01-01T00:00:00Z", "provider": "kimi", "status": "ok",
         "lines": ["10 % restants"], "provenance": "vieux"},
        {"ts": "2026-11-02T22:47:02Z", "provider": "kimi", "status": "ok",
         "lines": ["90 % restants"], "provenance": "recent"},
    ])
    rc, out = _run(tabs.cmd_series, provider=None, days=7, json=False)
    assert rc == 0
    assert "90" in out and "2026-01-01" not in out, out


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL {name}: {e}")
    print(f"\n{failures} failure(s)")
    raise SystemExit(1 if failures else 0)
