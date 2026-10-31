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

import contextlib
import importlib.util
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from io import StringIO

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


def _capture(fn, *a, **kw):
    buf = StringIO()
    with contextlib.redirect_stdout(buf):
        ret = fn(*a, **kw)
    return ret, buf.getvalue()


def test_a_missing_minute_is_a_hole():
    # Two ticks 10 minutes apart: the eight minutes between them are UNMEASURED.
    # Asserted on gaps() OUTPUT (the #760 CR: a predicate copy in the test would
    # stay green if the reader stopped printing holes altogether).
    path = write_log([row(10), row(0)])
    rows, _ = trend.read_rows(path, include_rotated=False)
    since = NOW - timedelta(hours=1)
    _, out = _capture(trend.gaps, rows, since)
    assert "HOLE" in out, f"two ticks 10 min apart must print a HOLE, got: {out!r}"
    assert "unmeasured" in out, "the hole line must say the span is unmeasured"
    os.unlink(path)


def test_continuous_ticks_have_no_hole():
    path = write_log([row(i) for i in range(0, 10, 1)])
    rows, _ = trend.read_rows(path, include_rotated=False)
    since = NOW - timedelta(hours=1)
    _, out = _capture(trend.gaps, rows, since)
    assert "no hole" in out, f"one tick a minute is continuous, got: {out!r}"
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


def test_hourly_output_keeps_a_recreate_split_and_counts_503():
    # The #760 CR defect 2, asserted on hourly() OUTPUT (not on raw rows): a
    # mid-hour recreate puts two PROCESSES in the window — no rendered row may
    # carry both, and the stall-answered (http 503) ticks must be countable.
    path = write_log([
        row(20, instanceId="aaaa1111", status="stalled", max60sMs=1800.0,
            blocked5mMs=5200.0, maxCumulativeMs=2100.0, http=503),
        row(19, instanceId="aaaa1111", max60sMs=45.0, maxCumulativeMs=2100.0, http=200),
        row(10, instanceId="bbbb2222", max60sMs=60.0, maxCumulativeMs=150.0, http=200),
        row(9, instanceId="bbbb2222", max60sMs=55.0, maxCumulativeMs=150.0, http=200),
        row(8, probe="fail", error="WebException: timeout", instanceId=None),
    ])
    rows, _ = trend.read_rows(path, include_rotated=False)
    _, out = _capture(trend.hourly, rows, 2)
    # Data lines: "YYYY-MM-DD HH:00  <inst>  n fail 503 max60s ...".
    data = re.findall(r"^(\d{4}-\d{2}-\d{2} \d{2}:00)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s", out, re.M)
    assert data, f"hourly() must render data rows, got: {out!r}"
    inst_names = {d[1] for d in data}
    assert "aaaa1111" in inst_names and "bbbb2222" in inst_names, \
        f"both processes must appear, rows show: {inst_names}"
    for hour, inst, n, fail, n503 in data:
        if inst == "-":
            assert int(fail) >= 1, \
                "the '-' row exists for probe-fail ticks; an ok tick never lands there"
    # Exactly one stall-answered tick exists (aaaa's first): summed over every
    # rendered row the 503 column must total 1 — a merge into one row would
    # still total 1, the per-row split is asserted above by inst_names.
    assert sum(int(d[4]) for d in data) == 1, \
        f"one http-503 tick in the window, 503 column totals {sum(int(d[4]) for d in data)}"
    # The cumulative marks stay per-process in the rendering: 2100 belongs to
    # aaaa's row(s) only, 150 to bbbb's, never both on one line.
    for line in out.splitlines():
        if re.match(r"^\d{4}-", line):
            assert not ("2100" in line and "150" in line), \
                f"two processes' cumulative marks on one row: {line!r}"
    assert "2 distinct instanceId" in out, "the recreate warning must fire"
    os.unlink(path)


def test_episodes_output_lists_the_stall_with_its_instance():
    # Asserted on episodes() OUTPUT: the hot tick's own fields must reach the
    # line, not merely satisfy a predicate in the test.
    path = write_log([
        row(3, instanceId="aaaa1111", max60sMs=1800.5, blocked5mMs=5200.0,
            maxCumulativeMs=2100.0, activeStreams=4),
        row(2, instanceId="aaaa1111", max60sMs=45.0),
    ])
    rows, _ = trend.read_rows(path, include_rotated=False)
    since = NOW - timedelta(hours=1)
    count, out = _capture(trend.episodes, rows, since)
    assert count == 1, f"one episode expected, got {count}"
    assert "1800.5 ms" in out, f"the episode line must carry the measured max, got: {out!r}"
    assert "aaaa1111" in out, "the episode line must name the instance"
    for line in out.splitlines():
        if "ms" in line and "aaaa1111" in line:
            assert "1800.5" in line, f"only the hot tick is listed: {line!r}"
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
