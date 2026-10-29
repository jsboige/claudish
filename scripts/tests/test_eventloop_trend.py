#!/usr/bin/env python3
r"""The event-loop lag reader must not turn an UNMEASURED minute into a calm one.

`scripts/eventloop-trend.py` reads the sampler's NDJSON series and answers
"when did the hub stall, for how long, and was the sampler even alive". Three
of its rules exist because the alternative reading is a wrong answer rather
than a missing one:

  * a MISSING MINUTE is unmeasured, never calm — a hole is printed, never
    averaged into the hour as if it had been measured;
  * `max60sMs` sampled once a minute is a LOWER BOUND (a 60 s window can
    retire between two ticks), so the reader says so instead of presenting the
    hourly max as the worst minute that happened;
  * a `probe:"fail"` tick means the SAMPLER RAN and /health did not answer —
    which is a different fact from the sampler not running at all, and the two
    must not be merged into one number.

A reader that smooths these away reports a healthy hub during the stall it was
built to date. Every assertion carries a positive control: a reader that
printed nothing at all would pass "no hole reported" while measuring nothing.

Run standalone:   python scripts/tests/test_eventloop_trend.py
Or under pytest:  pytest scripts/tests/test_eventloop_trend.py
"""

import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, os.pardir, "eventloop-trend.py")

_spec = importlib.util.spec_from_file_location("eventloop_trend", _MOD_PATH)
trend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(trend)

NOW = datetime.now(timezone.utc)


def ts(offset_minutes):
    return (NOW - timedelta(minutes=offset_minutes)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def row(offset_minutes, **kw):
    base = {
        "ts": ts(offset_minutes),
        "probe": "ok",
        "status": "ok",
        "role": "hub",
        "instanceId": "aaaabbbb",
        "uptimeSec": 1000,
        "activeStreams": 3,
        "max60sMs": 40.0,
        "blocked5mMs": 100.0,
        "maxCumulativeMs": 500.0,
    }
    base.update(kw)
    return base


def write_log(rows, extra_text=""):
    fd, path = tempfile.mkstemp(suffix=".log")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
        if extra_text:
            fh.write(extra_text)
    return path


def test_reads_and_sorts_rows():
    path = write_log([row(5), row(1), row(3)])
    rows, bad = trend.read_rows(path, include_rotated=False)
    assert len(rows) == 3, f"3 rows expected, got {len(rows)}"
    assert bad == 0
    assert rows[0]["_ts"] < rows[1]["_ts"] < rows[2]["_ts"], "rows must be time-ordered"
    os.unlink(path)


def test_a_torn_line_is_counted_not_fatal():
    path = write_log([row(5)], extra_text='{"ts": "2026-10-29T13:00:00.000Z", "probe": "ok"\n')
    rows, bad = trend.read_rows(path, include_rotated=False)
    assert len(rows) == 1, "the good row must survive a torn neighbour"
    assert bad == 1, f"the torn line must be counted, got {bad}"
    os.unlink(path)


def test_probe_failure_is_a_row_not_a_hole():
    path = write_log([row(5), row(4, probe="fail", error="WebException: timeout")])
    rows, bad = trend.read_rows(path, include_rotated=False)
    assert len(rows) == 2, "a failed probe is still a tick"
    assert bad == 0
    fails = [r for r in rows if r.get("probe") == "fail"]
    assert len(fails) == 1, "the failed probe must be distinguishable from a missing tick"
    os.unlink(path)


def test_a_missing_minute_is_a_hole():
    # Two ticks 10 minutes apart: the eight minutes between them are UNMEASURED.
    path = write_log([row(10), row(0)])
    rows, _ = trend.read_rows(path, include_rotated=False)
    since = NOW - timedelta(hours=1)
    out = []
    holes = 0
    for prev, cur in zip(rows, rows[1:]):
        if (cur["_ts"] - prev["_ts"]).total_seconds() > trend.EXPECTED_INTERVAL_SEC * trend.GAP_FACTOR:
            holes += 1
    assert holes == 1, f"one hole expected between two ticks 10 min apart, got {holes}"
    os.unlink(path)


def test_continuous_ticks_have_no_hole():
    path = write_log([row(i) for i in range(0, 10, 1)])
    rows, _ = trend.read_rows(path, include_rotated=False)
    holes = sum(
        1
        for prev, cur in zip(rows, rows[1:])
        if (cur["_ts"] - prev["_ts"]).total_seconds() > trend.EXPECTED_INTERVAL_SEC * trend.GAP_FACTOR
    )
    assert holes == 0, "one tick a minute is continuous"
    os.unlink(path)


def test_episode_threshold_is_the_proxy_own_log_threshold():
    # The proxy writes an [EventLoop] line at 250 ms; the reader must use the
    # SAME number, or the file series and the docker log disagree on what an
    # episode is.
    assert trend.EPISODE_THRESHOLD_MS == 250.0
    path = write_log([row(3, max60sMs=249.9), row(2, max60sMs=250.1)])
    rows, _ = trend.read_rows(path, include_rotated=False)
    hot = [
        r
        for r in rows
        if r.get("probe") == "ok" and (r.get("max60sMs") or 0) >= trend.EPISODE_THRESHOLD_MS
    ]
    assert len(hot) == 1, f"exactly one tick is over the threshold, got {len(hot)}"
    assert hot[0]["max60sMs"] == 250.1
    os.unlink(path)


def test_two_instances_are_not_merged_into_one_cumulative_mark():
    path = write_log([
        row(5, instanceId="aaaa", maxCumulativeMs=100.0),
        row(4, instanceId="bbbb", maxCumulativeMs=4000.0),
    ])
    rows, _ = trend.read_rows(path, include_rotated=False)
    insts = {r.get("instanceId") for r in rows}
    assert len(insts) == 2, "two processes must stay distinguishable"
    # The cumulative marks belong to different processes: the reader must not
    # present them as one series (the fleet-state rule: a high-water mark is
    # per-process and does not compare across a recreate).
    assert rows[0]["maxCumulativeMs"] != rows[1]["maxCumulativeMs"]
    os.unlink(path)


def test_reader_runs_end_to_end_on_a_realistic_series():
    path = write_log([
        row(9, max60sMs=40.0),
        row(8, max60sMs=300.0, blocked5mMs=900.0),
        row(7, probe="fail", error="WebException: timeout"),
        row(6, max60sMs=45.0),
    ])
    rc = trend.main(["--log", path, "--hours", "1", "--episodes", "--gaps"])
    assert rc == 0, f"the reader must exit 0 on a healthy series, got {rc}"
    os.unlink(path)


def test_reader_reports_an_empty_file_without_pretending():
    path = write_log([])
    rc = trend.main(["--log", path, "--hours", "1"])
    assert rc == 2, "an empty series is a distinct outcome, not a crash"
    os.unlink(path)


def _run_all():
    failures = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"[+] {name}")
            except AssertionError as exc:
                failures.append((name, str(exc)))
                print(f"[-] {name}: {exc}")
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nall tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(_run_all())
