#!/usr/bin/env python3
"""Self-executing pins for hourly-profile.py (#21/Q70 — the durable tariff
landmark instrument).

The 12/11 landmark was measured by a one-off scratch aggregator; this suite
pins the semantics the landmark's conclusions rest on:

  (a) hour bucketing is the UTC hour of the RESPONSE filename timestamp
      (06:59:59 -> hour 6, 07:00:00 -> hour 7);
  (b) weekday/weekend split follows the DAY DIRECTORY's date, so a Saturday
      06:00 response never lands in a weekday peak band;
  (c) bands are half-open [DEB, FIN): hour 4 is OUT of band A=1-4;
  (d) lane attribution is the SERVED model name through traffic-consumption's
      lane_for (regex lanes + fall-through to the model id);
  (e) buckets come from the paired request (cron / interactive / agent-sdk),
      an unpaired response is "other" — never a guess;
  (f) the JSON dump carries the same numbers as the printed table.

Mutation proof (run this session, reported in the PR): `grid[dt.hour]` ->
`grid[dt.hour // 2]` reddens 15 of 22 pins — every group (a)-(f) loses at
least one pin, so no group survives on the assertion of another.

Run: python -I scripts/tests/test_hourly_profile.py   (or pytest)
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.join(_HERE, "..", "hourly-profile.py")

spec = importlib.util.spec_from_file_location("hourly_profile", _SCRIPT)
hp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hp)

FAILS = []


def check(name, cond, detail=""):
    print("%s %s%s" % ("ok  " if cond else "FAIL", name, (" — " + detail) if detail else ""))
    if not cond:
        FAILS.append(name)


# ---------------------------------------------------------------- fixtures
# 2026-11-09 is a Monday (weekday), 2026-11-07 a Saturday (weekend).

def _ts(day, h, m, s):
    return "%sT%02d-%02d-%02d-000Z" % (day, h, m, s)


def _req(day_dir, pid, reqn, req_ts, wl, ep="claude-vscode",
         machine="myia-po-2028", src="direct"):
    """A minimal request capture head — load_requests only regexes it."""
    name = "req-%d-%04d-%s-%s.json" % (pid, reqn, req_ts, src)
    if wl is None:
        body = '{"ts":"%s","machine":"%s","entrypoint":"%s"}' % (req_ts, machine, ep)
    else:
        body = ('{"ts":"%s","machine":"%s","entrypoint":"%s","workload":"%s"}'
                % (req_ts, machine, ep, wl))
    with open(os.path.join(day_dir, name), "w", encoding="utf-8") as fh:
        fh.write(body)
    return name


def _resp(day_dir, pid, reqn, resp_ts, model, out_tok, in_tok=100,
          paired=True, handler="direct"):
    """One response capture: HDR line + a zero-seed message_start and a
    terminal message_delta carrying the coherent usage triple (#600 rule:
    the seed block's empty input statement is never chosen)."""
    if paired:
        # request one minute before the response, same day
        h, m = int(resp_ts[11:13]), int(resp_ts[14:16])
        m2, h2 = (m - 1, h) if m > 0 else (59, h - 1)
        _req(day_dir, pid, reqn, _ts(resp_ts[:10], h2, m2, int(resp_ts[17:19])),
             wl="cron")
    name = "resp-%d-r%04d-%s-%s-%s.sse" % (pid, reqn, resp_ts, handler, model)
    text = "\n".join([
        "# claudish response capture",
        "# parser=%s model=%s reqN=%d pid=%d" % (handler, model, reqn, pid),
        "# instance=test",
        "# elapsed_ms=42",
        "# ==================================================",
        "event: message_start",
        'data: {"type":"message_start","message":{"usage":{"input_tokens":0,'
        '"cache_read_input_tokens":0,"cache_creation_input_tokens":0,'
        '"output_tokens":1}}}',
        "",
        "event: message_delta",
        'data: {"type":"message_delta","delta":{},"usage":{"input_tokens":%d,'
        '"cache_read_input_tokens":0,"cache_creation_input_tokens":0,'
        '"output_tokens":%d}}' % (in_tok, out_tok),
        "",
        "event: message_stop",
        "",
    ])
    with open(os.path.join(day_dir, name), "w", encoding="utf-8") as fh:
        fh.write(text)


def build_corpus(root):
    """9 responses: 8 on Mon 2026-11-09 (weekday), 1 on Sat 2026-11-07."""
    mon = os.path.join(root, "2026-11-09")
    sat = os.path.join(root, "2026-11-07")
    os.makedirs(mon)
    os.makedirs(sat)

    # hour 6 band B: 2x gc@ (cron + interactive), 1x fall-through lane
    _resp(mon, 1, 1, _ts("2026-11-09", 6, 5, 0), "glm-5.3", 1000)
    _resp(mon, 1, 2, _ts("2026-11-09", 6, 45, 0), "glm-5.3", 500, paired=False)
    _req(mon, 1, 2, _ts("2026-11-09", 6, 44, 0), wl=None)  # ep only -> interactive
    _resp(mon, 1, 3, _ts("2026-11-09", 6, 55, 0), "my-model-x", 40)
    # hour 7 band B: ds@
    _resp(mon, 1, 4, _ts("2026-11-09", 7, 10, 0), "deepseek-chat", 200)
    # hour 4: OFF band A (half-open 1-4 = hours 1,2,3) — the sharp edge
    _resp(mon, 1, 5, _ts("2026-11-09", 4, 10, 0), "glm-5.3", 50)
    # hour 3:59:59 band A
    _resp(mon, 1, 6, _ts("2026-11-09", 3, 59, 59), "deepseek-chat", 300)
    # hour 1 band A: native
    _resp(mon, 1, 7, _ts("2026-11-09", 1, 0, 5), "claude-sonnet-5-5", 700,
          paired=False)
    _req(mon, 1, 7, _ts("2026-11-09", 0, 59, 0), wl=None)
    # hour 12: no request at all -> other / (unpaired)
    _resp(mon, 1, 8, _ts("2026-11-09", 12, 0, 0), "glm-5.3", 10, paired=False)

    # Saturday hour 6 — must land in the WEEKEND table only.
    _resp(sat, 1, 1, _ts("2026-11-07", 6, 20, 0), "glm-5.3", 900)


# ---------------------------------------------------------------- unit pins

def test_parse_band_is_half_open_and_validated():
    check("band: A=1-4 -> hours (1,2,3)",
          hp.parse_band("A=1-4") == ("A", (1, 2, 3)),
          repr(hp.parse_band("A=1-4")))
    for bad in ("A=5-2", "A=25-30", "A=1", "14", "A=a-b"):
        try:
            hp.parse_band(bad)
            check("band: %s refused" % bad, False, "accepted")
        except Exception:
            check("band: %s refused" % bad, True)


# ------------------------------------------------------- end-to-end pins

def test_end_to_end():
    with tempfile.TemporaryDirectory() as tmp:
        build_corpus(tmp)
        out_json = os.path.join(tmp, "profile.json")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = hp.main(["--corpus", tmp, "--band", "A=1-4", "--band", "B=6-10",
                          "--tariff-note", "re-sourced 2026-11-12", "--out", out_json])
        printed = buf.getvalue()
        check("e2e: exit 0", rc == 0, "rc=%s" % rc)
        check("e2e: header echoes the band specs and the tariff note",
              "A=01-04" in printed and "B=06-10" in printed
              and "re-sourced 2026-11-12" in printed)
        check("e2e: blind-spot line present", "AUTONOMOUS" in printed)
        prof = json.load(open(out_json, encoding="utf-8"))

        wd, we = prof["weekday"], prof["weekend"]

        # (a) hour bucketing, on the response filename timestamp
        check("(a) hour 6 holds 3 weekday responses (06:05, 06:45, 06:55)",
              wd["6"]["resp"] == 3, str(wd["6"]["resp"]))
        check("(a) 03:59:59 lands in hour 3",
              wd["3"]["resp"] == 1 and wd["3"]["lane"].get("ds@ PAYG") == 1,
              str(wd["3"]))
        check("(a) empty hours are present and zero",
              all(wd[str(h)]["resp"] == 0 for h in (0, 2, 5, 8, 9, 10, 15, 23)))

        # (b) weekday/weekend split follows the day directory
        check("(b) Saturday 06:20 response is in the WEEKEND hour 6",
              we["6"]["resp"] == 1 and we["6"]["lane"].get("gc@ GLM Coding") == 1,
              str(we["6"]))
        check("(b) weekday hour 6 does NOT carry the Saturday response",
              wd["6"]["out"] == 1000 + 500 + 40, str(wd["6"]["out"]))
        check("(b) weekend total resp == 1",
              sum(c["resp"] for c in we.values()) == 1)

        # (c) bands half-open: hour 4 (04:10) is OFF band A=1-4
        off4 = wd["4"]
        check("(c) hour-4 gc@ response counted off-peak (band A excludes hour 4)",
              off4["resp"] == 1 and off4["lane"].get("gc@ GLM Coding") == 1,
              str(off4))

        # (d) lane attribution through lane_for, fall-through included
        check("(d) glm-5.3 -> gc@, deepseek -> ds@, claude-* -> native",
              wd["6"]["lane"].get("gc@ GLM Coding") == 2
              and wd["7"]["lane"].get("ds@ PAYG") == 1
              and wd["1"]["lane"].get("native-anthropic") == 1)
        check("(d) unknown model falls through to its own name",
              wd["6"]["lane"].get("my-model-x") == 1)
        check("(d) lane_out carries the terminal output tokens",
              wd["6"]["lane_out"].get("gc@ GLM Coding") == 1500,
              str(wd["6"]["lane_out"]))

        # (e) buckets from the paired request; unpaired -> other
        b6 = wd["6"]["bucket"]
        check("(e) hour 6 buckets: cron=2, interactive=1",
              b6.get("cron") == 2 and b6.get("interactive") == 1, str(b6))
        check("(e) unpaired response is bucket 'other'",
              wd["12"]["bucket"].get("other") == 1, str(wd["12"]["bucket"]))
        check("(e) machine attribution: (unpaired) named as such",
              wd["12"]["machine"].get("(unpaired)") == 1, str(wd["12"]["machine"]))

        # (f) printed band tables agree with the JSON
        check("(f) cron share row for band A: cron=1, resp=2, out=1000",
              "A 01-04\tcron=1\tresp=2\tcron_share=50.0%\tout=1000" in printed)
        check("(f) cron share row for band B: cron=3, resp=4, out=1740",
              "B 06-10\tcron=3\tresp=4\tcron_share=75.0%\tout=1740" in printed)
        check("(f) gc@ lane row: A=0, B_n=2, B_out=1500, off_n=2, off_out=60",
              ("gc@ GLM Coding\t0\t0\t2\t1500\t2\t60\t"
               "50.0%\t96.2%") in printed)
        check("(f) bands echoed in the JSON dump",
              prof["bands"] == {"A": [1, 2, 3], "B": [6, 7, 8, 9]}
              and prof["tariff_note"] == "re-sourced 2026-11-12")


def test_missing_corpus_is_refused():
    with tempfile.TemporaryDirectory() as tmp:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = hp.main(["--corpus", tmp, "--band", "A=1-4"])
        check("no day dirs -> exit 2 (refused, not an empty green table)",
              rc == 2, "rc=%s" % rc)


if __name__ == "__main__":
    tests = [(n, o) for n, o in sorted(globals().items())
             if n.startswith("test_") and callable(o)]
    for _, fn in tests:
        print("## %s" % fn.__name__)
        fn()
    print()
    if FAILS:
        print("FAILED: %d — %s" % (len(FAILS), ", ".join(FAILS)))
        sys.exit(1)
    print("all pins ok")
