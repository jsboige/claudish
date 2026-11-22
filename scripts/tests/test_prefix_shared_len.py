"""Pins for prefix-shared-len.py (#640 repli / #1152 option (b) recon).

Each test names the guard it defends — removing the guarded line in the
instrument must make at least one of these red.
"""
import importlib.util
import os
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "prefix_shared_len", os.path.join(_HERE, "..", "prefix-shared-len.py"))
psi = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(psi)


ENV = ('{"ts": "2026-11-22T01:00:00Z", "src": "direct", "machine": "myia-po-2023", '
       '"model": "claude-sonnet-5-5", "pid": 1, "workspace": "claudish", "lane": "", '
       '"body": {"metadata": {"user_id": "{\\"device_id\\":\\"d1\\",\\"session_id\\":\\"S1\\"}"}')
TS2 = ENV.replace("2026-11-22T01:00:00Z", "2026-11-22T01:05:00Z")
CONV_A = ENV + ', "messages": [{"role": "user", "content": "turn one"}]}'
CONV_B = TS2 + ', "messages": [{"role": "user", "content": "turn one"}, '
CONV_B += '{"role": "assistant", "content": "answer"}, {"role": "user", "content": "turn two"}]}'


def test_session_of_reads_metadata_user_id():
    # Guard: the session key is body metadata.user_id — not the filename, not
    # the model. Two requests of one session group together (measure below).
    # the captured key is the JSON-escaped form (backslashes kept — it is a
    # JSON string inside the body), stable across both files
    assert "device_id" in psi.session_of(CONV_A)
    assert psi.session_of(CONV_A) == psi.session_of(CONV_B)


def test_session_of_absent_key_is_noid_never_dropped():
    # Guard: a capture without user_id falls in "(noid)" — dropping it would
    # silently shrink the sample (the docstring trap).
    no_meta = '{"ts": "t", "machine": "m", "body": {"messages": []}}'
    assert psi.session_of(no_meta) == "(noid)"


def test_lcp_bytes_exact():
    # Guard: the binary-search LCP — exact on a shared head, 0 on an instant
    # divergence, and bounded by the shorter input.
    assert psi.lcp_bytes(b"abcdef", b"abcXYZ") == 3
    assert psi.lcp_bytes(b"abc", b"xyz") == 0
    assert psi.lcp_bytes(b"abc", b"abcdef") == 3
    assert psi.lcp_bytes(b"", b"abc") == 0


def test_measure_pairs_only_within_a_session():
    # Guard: cross-session isolation. Two sessions, three requests -> exactly
    # the one same-session pair; the other session's singleton is counted as
    # nopair, never fabricated into a cross-session pair.
    other_session = CONV_A.replace("S1", "S2").encode("utf-8")
    with tempfile.TemporaryDirectory() as td:
        for i, raw in enumerate([CONV_A.encode("utf-8"),
                                 CONV_B.encode("utf-8"),
                                 other_session]):
            with open(os.path.join(td, f"req-1-{i}-2026-11-22T01-0{i}-00-000Z-direct.json"),
                      "wb") as fh:
                fh.write(raw)
        paths = [os.path.join(td, fn) for fn in sorted(os.listdir(td))]
        pairs, n_sessions, nopair = psi.measure(paths)
    assert n_sessions == 2
    assert nopair == 1          # the S2 singleton
    assert len(pairs) == 1      # only the S1 consecutive pair
    p = pairs[0]
    # The files open with {"ts": "...T01:0" and diverge at the MINUTE digit
    # (00 vs 05) — the LCP is byte-level and stops exactly there: it must NOT
    # reach the identical conversation region that follows the differing ts.
    shared_expected = psi.lcp_bytes(CONV_A.encode("utf-8"), CONV_B.encode("utf-8"))
    assert shared_expected < 30
    assert p["shared_bytes"] == shared_expected
    assert p["newer_bytes"] > p["older_bytes"]


def test_measure_orders_by_ts_then_name():
    # Guard: pair order is (ts, path) — a name-only sort would pair the
    # newest with the oldest when ts inverts the name order.
    a = CONV_A.encode("utf-8")              # ts 01:00
    b = CONV_B.encode("utf-8")              # ts 01:05 (turn two added)
    with tempfile.TemporaryDirectory() as td:
        # name order INVERTED vs ts order: the later-ts file sorts first
        with open(os.path.join(td, "req-1-9-2026-11-22T01-05-00-000Z-direct.json"), "wb") as fh:
            fh.write(b)
        with open(os.path.join(td, "req-1-1-2026-11-22T01-00-00-000Z-direct.json"), "wb") as fh:
            fh.write(a)
        paths = [os.path.join(td, fn) for fn in sorted(os.listdir(td))]
        pairs, _s, _n = psi.measure(paths)
    assert len(pairs) == 1
    assert "01-00" in pairs[0]["older"] and "01-05" in pairs[0]["newer"]


def test_sample_machine_filter():
    # Guard: --machine filters on the ENVELOPE head (1024 B), never a full
    # parse — and an empty match keeps the file OUT, not IN.
    with tempfile.TemporaryDirectory() as td:
        with open(os.path.join(td, "req-1-1-2026-11-22T01-00-00-000Z-direct.json"), "wb") as fh:
            fh.write(CONV_A.encode("utf-8"))
        assert len(psi.sample(td, 10, "myia-po-2023")) == 1
        assert len(psi.sample(td, 10, "some-other-machine")) == 0
