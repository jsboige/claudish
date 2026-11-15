#!/usr/bin/env python3
r"""Every workflow job must declare `timeout-minutes` (#1032).

GitHub's default job timeout is SIX HOURS. A stuck job does not fail fast: it
holds a runner (shared across the fleet, #1032's own context) for hours, and a
hung publish step looks exactly like a slow one until the wall. The fix is one
line per job; this pin is what keeps the eleventh job from arriving without it.

The scanner is deliberately minimal (no PyYAML: the CI job installs pytest and
py7zr only), so it is pinned against vacuity: a scanner that finds no job must
fail here, not pass silently.

Run: python scripts/tests/test_workflow_timeouts.py
"""

import os
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
_WORKFLOW_DIR = os.path.join(_ROOT, ".github", "workflows")


def workflow_jobs(text):
    """[(job_id, timeout_string_or_None)] for one workflow's text.

    Jobs live under the top-level `jobs:` mapping at two-space indent; the
    attributes this pin watches sit at four. Anything outside that block (the
    `on:` triggers, `permissions:`, step lists) is ignored.
    """
    jobs, in_jobs, current = [], False, None
    for raw in text.splitlines():
        body = raw.rstrip("\r\n")
        if body == "jobs:":
            in_jobs = True
            continue
        if in_jobs and body and not body[0].isspace():
            in_jobs = False
        if not in_jobs:
            continue
        stripped = body[2:]
        if body.startswith("  ") and not body.startswith("    ") and stripped.endswith(":"):
            current = stripped[:-1].strip()
            jobs.append([current, None])
            continue
        if current and body.startswith("    ") and not body.startswith("      "):
            name, _, value = body.strip().partition(":")
            if name == "timeout-minutes":
                jobs[-1][1] = value.strip()
    return [(job, timeout) for job, timeout in jobs]


def scan(paths):
    """(jobs, missing) -- `missing` names every job without a timeout."""
    jobs, missing = [], []
    for path in paths:
        with open(path, encoding="utf-8") as f:
            for job, timeout in workflow_jobs(f.read()):
                jobs.append((os.path.basename(path), job, timeout))
                if timeout is None:
                    missing.append("%s: %s" % (os.path.basename(path), job))
    return jobs, missing


def _workflow_paths():
    return sorted(
        os.path.join(_WORKFLOW_DIR, name)
        for name in os.listdir(_WORKFLOW_DIR)
        if name.endswith((".yml", ".yaml"))
    )


# --------------------------------------------------------------------------
# The instrument itself: a missing timeout is named, precisely
# --------------------------------------------------------------------------

FIXTURE_WITH_GAP = """\
name: Fixture
on:
  pull_request:
jobs:
  covered:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo ok
  uncovered:
    runs-on: ubuntu-latest
    steps:
      - run: echo slow
"""


def _scan_text(text):
    """scan() on an in-memory workflow, via a real temp file (no .tmp dependency:
    the CI runner has no gitignored scratch directory)."""
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "fixture.yml")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return scan([path])


def test_a_missing_timeout_is_named_by_its_job():
    jobs, missing = _scan_text(FIXTURE_WITH_GAP)
    assert [j for _, j, _ in jobs] == ["covered", "uncovered"], jobs
    assert missing == ["fixture.yml: uncovered"], missing
    assert jobs[0][2] == "5", jobs


def test_adding_a_job_without_a_timeout_changes_the_result():
    """The regression this pin exists for: the list of jobs grows, the list of
    timeouts does not -- the diff must materialize as a named offender."""
    _, missing = _scan_text(FIXTURE_WITH_GAP + """
  eleventh:
    runs-on: ubuntu-latest
    steps:
      - run: echo new
""")
    assert "eleventh" in " ".join(missing), missing


# --------------------------------------------------------------------------
# The repository's own workflows
# --------------------------------------------------------------------------

def test_the_scanner_sees_the_jobs_it_must():
    """Anti-vacuity: a scanner returning nothing would make the next pin pass
    on an empty set. Pin the known shape and the fleet minimum."""
    jobs, _missing = scan(_workflow_paths())
    ids = {(f, j) for f, j, _ in jobs}
    assert ("test.yml", "test") in ids, sorted(ids)
    assert ("test.yml", "typecheck") in ids, sorted(ids)
    assert ("test.yml", "scripts-tests") in ids, sorted(ids)
    assert len(jobs) >= 10, jobs


def test_every_workflow_job_declares_a_timeout():
    """The acceptance of #1032. The failure message names every job missing its
    line -- a single offender must read as that job, not as a red blob."""
    jobs, missing = scan(_workflow_paths())
    assert jobs, "no workflow job found -- the scanner is broken, not the repo"
    assert missing == [], "jobs without timeout-minutes: " + ", ".join(missing)


def test_timeouts_are_positive_integers():
    jobs, _ = scan(_workflow_paths())
    offenders = [
        "%s: %s = %r" % (f, j, t) for f, j, t in jobs
        if t is None or not t.isdigit() or int(t) <= 0
    ]
    assert offenders == [], offenders


if __name__ == "__main__":
    import sys

    _passed = failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                _passed += 1
                print("PASS %s" % name)
            except AssertionError as e:
                failures += 1
                print("FAIL %s: %s" % (name, e))
            except Exception as e:
                failures += 1
                print("ERROR %s: %r" % (name, e))
    print("--- %d passed, %d failed" % (_passed, failures))
    sys.exit(1 if failures else 0)