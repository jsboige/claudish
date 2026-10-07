#!/usr/bin/env python3
r"""Pins for swarm-signal.py (#317 option 3 — alert-only swarm detector).

Fixture provenance: SYNTHETIC but shape-faithful to the real 27/09 captures
measured in issue #317 c.6025976638 — key order included (`body` first,
`body.system` serialized AFTER `body.messages`, `metadata` last in body,
envelope fields after `body`), billing header as a text block inside
`system[]`, `metadata.user_id` a doubly-escaped JSON string. The first
version of the sibling script live-consumption.py had fixtures that
fabricated the shape its parser assumed (#334 B1) — these are built by
json.dump of an ordered dict so the serialization trap is exercised, not
assumed away.

Each case carries a POSITIVE CONTROL (same doctrine as test_live_consumption):
the failure mode of a detector is a silent empty verdict, so every
"no WARN" assertion is paired with a scanned/marked count that must be
non-zero — otherwise the case would pass for the wrong reason.

The ECHO trap is pinned in BOTH directions: a quoted cc_is_subagent in
conversation prose must never override the real system block, whichever
value each side carries.

Run standalone:  python scripts/tests/test_swarm_signal.py
Or under pytest: pytest scripts/tests/test_swarm_signal.py
"""

import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "swarm_signal", os.path.join(_HERE, "..", "swarm-signal.py"))
ss = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(ss)

FAILS = []


def check(name, cond, detail=""):
    """RAISES on failure (#378 CR): a check that only appends to FAILS makes
    the suite green under pytest whatever the code does — pytest collects
    test_* functions and never runs main(), so FAILS is never read there.
    Same fix as #333/#364."""
    if cond:
        print(f"  ok   {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name}  {detail}")
        raise AssertionError(f"{name}  {detail}")


def envelope(session="sess-swarm-0001", machine="myia-ai-01",
             billing="cc_version=2.1.282.772; cc_entrypoint=claude-vscode; "
                     "cc_workload=interactive; cc_is_subagent=true;",
             echo=None, model="claude-haiku-4-5-20251001",
             with_user_id=True):
    """Real-shape capture: `system` block AFTER `messages` (dict order is
    serialization order), metadata last, envelope fields after body."""
    messages = [{"role": "user", "content": "do the thing"}]
    if echo is not None:
        messages.insert(0, {"role": "assistant", "content":
                            f"earlier quote: x-anthropic-billing-header: {echo}"})
    body = {
        "messages": messages,
        "system": [{"type": "text", "text":
                    f"x-anthropic-billing-header: {billing}"}],
        "metadata": {"user_id": json.dumps({
            "device_id": "b5909fd92642d80efedc0ffee",
            "account_uuid": "c26051cc-3f20-43f7-8d03-fb20d3d00a9b",
            "session_id": session,
        })} if with_user_id else {},
        "model": model,
    }
    return {"body": body, "machine": machine, "model": model,
            "pid": 1, "ts": "2026-09-27T13:00:00Z", "workload": "other"}


def write_req(tmpdir, n, offset_sec, env):
    """offset_sec from 13:00:00, any magnitude — hours roll over (a fixture
    25 min apart must still produce VALID capture names: the collector skips
    names whose time part does not parse, so an offset spilling past the hour
    would silently drop files and turn the case green for the wrong reason)."""
    hour, rem = divmod(offset_sec, 3600)
    minute, second = divmod(rem, 60)
    ts = f"2026-09-27T{13 + hour:02d}-{minute:02d}-{second:02d}"
    name = f"req-1-{n:04d}-{ts}-000Z-direct.json"
    with open(os.path.join(tmpdir, name), "w", encoding="utf-8") as f:
        json.dump(env, f)
    return name


def collect(tmpdir, **kw):
    return ss.collect_swarm_rows(tmpdir, **kw)


def test_rate_warn():
    print("case: sustained rate trips the WARN, with proof fields")
    with tempfile.TemporaryDirectory() as d:
        # 12 marked reqs, 45 s apart -> all 12 inside one 10-min window
        for i in range(12):
            write_req(d, i + 1, i * 45, envelope())
        rows, stats = collect(d)
        v = ss.verdicts(rows, stats, rate=1.0, window_min=10, window_total=5000)
        check("marked scanned (positive control)", stats["marked"] == 12,
              f"marked={stats['marked']}")
        check("one verdict", len(v) == 1, str(len(v)))
        if v:
            check("peak rate 1.2/min (12 in 10 min)", abs(v[0]["peak_rate_per_min"] - 1.2) < 0.05,
                  str(v[0]["peak_rate_per_min"]))
            check("rule=rate", v[0]["warn"] == "rate", v[0]["warn"])
            check("top model named", "haiku" in str(v[0]["top_models"]),
                  str(v[0]["top_models"]))


def test_below_threshold():
    print("case: same volume spread thin -> no verdict (and scanner DID see them)")
    with tempfile.TemporaryDirectory() as d:
        # 12 marked reqs, 25 MIN apart: any 10-min window holds at most 1
        for i in range(12):
            write_req(d, i + 1, i * 1500, envelope())
        rows, stats = collect(d)
        v = ss.verdicts(rows, stats, rate=1.0, window_min=10, window_total=5000)
        check("marked scanned (positive control)", stats["marked"] == 12,
              f"marked={stats['marked']}")
        check("no verdict", not v, str(v))


def test_three_states():
    print("case: main (header, no flag) and unknown (no header) never count as marked")
    with tempfile.TemporaryDirectory() as d:
        write_req(d, 1, 0, envelope(
            billing="cc_version=9; cc_workload=interactive;"))          # main
        write_req(d, 2, 10, envelope(
            billing="cc_version=9; cc_is_subagent=true;"))              # marked
        env_unknown = envelope()
        env_unknown["body"]["system"] = [{"type": "text", "text": "plain system"}]
        write_req(d, 3, 20, env_unknown)                                # unknown
        rows, stats = collect(d)
        v = ss.verdicts(rows, stats, rate=100.0, window_min=10, window_total=1)
        check("states counted", (stats["marked"], stats["main"],
                                 stats["unknown"]) == (1, 1, 1),
              str(stats))
        check("window-total verdict on the single marked", len(v) == 1 and
              v[0]["warn"] == "window-total" and v[0]["marked_total"] == 1, str(v))


def test_echo_trap():
    print("case: quoted billing header in prose never overrides the real one (both directions)")
    with tempfile.TemporaryDirectory() as d:
        # A: prose says true, real header has NO flag -> main, not marked
        write_req(d, 1, 0, envelope(session="sess-aaaa-long",
                                    billing="cc_version=9; cc_workload=interactive;",
                                    echo="cc_version=1; cc_is_subagent=true;"))
        # B: prose says false, real header says true -> marked
        write_req(d, 2, 5, envelope(session="sess-bbbb-long",
                                    billing="cc_version=9; cc_is_subagent=true;",
                                    echo="cc_version=1; cc_is_subagent=false;"))
        rows, stats = collect(d)
        check("echo true / real main -> main", stats["marked"] == 1,
              f"marked={stats['marked']} main={stats['main']}")
        marked_sessions = {r[2] for r in rows if r[3] is True}
        check("the marked one is B (last header wins)",
              marked_sessions == {"sess-bbbb-lo"}, str(marked_sessions))


def test_unattributed():
    print("case: no user_id -> unattributed, scanned but never a verdict key")
    import io
    import contextlib
    with tempfile.TemporaryDirectory() as d:
        for i in range(5):
            write_req(d, i + 1, i * 60, envelope(with_user_id=False))
        rows, stats = collect(d)
        v = ss.verdicts(rows, stats, rate=0.01, window_min=10, window_total=1)
        check("unattributed counted", stats["unattributed"] == 5, str(stats))
        check("marked unattributed visible", stats.get("unattributed_marked") == 5,
              str(stats))
        check("no verdict on unattributed", not v, str(v))
        # CR pin: the no-verdict line must SAY the marked traffic is
        # unattributed — an SDK-shaped swarm with no user_id must not read
        # as "all quiet" next to a large marked count.
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            ss.main(["--capture-dir", d])
        out = buf.getvalue()
        check("no-verdict line names unattributed_marked",
              "no session over threshold" in out
              and "unattributed_marked 5" in out, out)


def test_sample_factor():
    print("case: --sample-factor scales rates/totals and they say so")
    with tempfile.TemporaryDirectory() as d:
        for i in range(12):
            write_req(d, i + 1, i * 45, envelope())
        rows, stats = collect(d)
        v = ss.verdicts(rows, stats, rate=100.0, window_min=10, window_total=5000,
                        sample_factor=150.0)
        check("scaled rate trips 100/min", len(v) == 1 and
              abs(v[0]["peak_rate_per_min"] - 180.0) < 0.5, str(v))
        check("scaled total 12*150", v and v[0]["marked_total"] == 1800,
              str(v and v[0]["marked_total"]))


def test_peak_window_unit():
    print("case: peak_window_rate anchors on events")
    t0 = datetime(2026, 9, 27, 13, 0, 0, tzinfo=timezone.utc)
    ts = [t0 + timedelta(minutes=m) for m in (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 70)]
    n, start = ss.peak_window_rate(ts, 10)
    check("10 inside the burst", n == 10, str(n))
    check("window starts at first event", start == t0, str(start))


def test_since_until():
    print("case: window bounds exclude files before counting")
    with tempfile.TemporaryDirectory() as d:
        for i in range(4):
            write_req(d, i + 1, i * 60, envelope())
        rows, stats = collect(
            d, since=datetime(2026, 9, 27, 13, 2, 0, tzinfo=timezone.utc))
        check("outside counted", stats["outside_window"] == 2, str(stats))
        check("inside scanned", stats["files"] == 2, str(stats))


def test_json_output():
    print("case: --json emits a parsable verdict block")
    import io
    import contextlib
    with tempfile.TemporaryDirectory() as d:
        for i in range(12):
            write_req(d, i + 1, i * 45, envelope())
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = ss.main(["--capture-dir", d, "--rate", "1", "--json"])
        payload = json.loads(buf.getvalue())
        check("exit 0", rc == 0, str(rc))
        check("verdict block present", payload["verdicts"] and
              payload["verdicts"][0]["peak_rate_per_min"] >= 1.0,
              buf.getvalue()[:200])
        check("params echoed", payload["params"]["rate"] == 1.0,
              str(payload["params"]))


def main():
    test_rate_warn()
    test_below_threshold()
    test_three_states()
    test_echo_trap()
    test_unattributed()
    test_sample_factor()
    test_peak_window_unit()
    test_since_until()
    test_json_output()
    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} -> {FAILS}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
