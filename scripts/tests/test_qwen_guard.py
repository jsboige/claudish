#!/usr/bin/env python3
r"""The Qwen monthly guard must not freeze a FAILED archive read as a real zero (claudish #260).

`refresh_days` counts each UTC day once and never recomputes a day cached from
an archive. That rule is exactly what makes a WRONG zero permanent. The path is
not exotic: the GDrive mount is a recurrent fleet SPOF (5th episode of the class
on 2026-09-24, ~50 min), and `n == 0 loose + archive present` is the NORMAL
state of any past day post-purge. So one mount hiccup during one tick would zero
a real day for good — the burn is under-counted and the guard prints OK where it
owes EXCEEDED. A budget guard whose failure mode points the wrong way is worse
than no guard.

The fix splits two states that were conflated: "extracted, zero files"
(cacheable) versus "extraction failed" (`scan_archive_for_day` returns None,
and the caller leaves the day unwritten so the next tick retries).

Every assertion carries a positive control — a guard that simply stopped
writing days would pass "no zero was cached" while silently ceasing to count,
so the retry case must produce the real numbers, and an extracted-zero archive
must still be cached.

Run standalone:   python scripts/tests/test_qwen_guard.py
Or under pytest:  pytest scripts/tests/test_qwen_guard.py
"""

import argparse
import importlib.util
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, os.pardir, "qwen_monthly_guard.py")

_spec = importlib.util.spec_from_file_location("qwen_monthly_guard", _MOD_PATH)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)

DAY = "2026-09-20"
OTHER = "2026-09-21"


def _args(archive_dir, captures_dir, seven_zip="7z"):
    return argparse.Namespace(
        captures_dir=captures_dir, archive_dir=archive_dir, seven_zip=seven_zip
    )


def _fresh_state():
    return {"baseline_day": DAY, "days": {}}


def _patch_scanners(loose, archive):
    """Replace the two scan seams; return a restore closure."""
    old_loose, old_arch, old_today = (
        guard.scan_dir_for_day,
        guard.scan_archive_for_day,
        guard.utc_today,
    )
    guard.scan_dir_for_day = loose
    guard.scan_archive_for_day = archive
    guard.utc_today = lambda: DAY

    def restore():
        guard.scan_dir_for_day = old_loose
        guard.scan_archive_for_day = old_arch
        guard.utc_today = old_today

    return restore


EMPTY = (0, 0, 0, 0, 0)
SOME = (7, 100, 200, 300, 400)


def test_archive_vanishing_mid_tick_is_not_a_zero():
    """The race the arity bug hid: `refresh_days` checks `os.path.exists`, then
    reads. On a Drive mount the archive can be gone by the read. That is the
    same unmeasurable case, and it must not become a permanent zero either."""
    with tempfile.TemporaryDirectory() as td:
        real = guard.archive_path(td, DAY)
        with open(real, "wb") as f:
            f.write(b"x")
        calls = {"n": 0}
        orig_path = guard.archive_path

        def flaky(archives_dir, day):
            calls["n"] += 1
            return real if calls["n"] == 1 else os.path.join(archives_dir, "gone.7z")

        guard.archive_path = flaky
        restore = _patch_scanners(lambda d, day: EMPTY, guard.scan_archive_for_day)
        try:
            state = _fresh_state()
            guard.refresh_days(state, _args(td, td))
        finally:
            guard.archive_path = orig_path
            restore()
    assert DAY not in state["days"], (
        f"an archive that vanished mid-tick was cached as a zero: {state['days']!r}"
    )


def test_failed_extraction_returns_none_not_zero():
    """The real code path: a 7z that cannot be launched is a FAILED read, not a
    zero-file read. Positive control: the same call with a working scanner shape
    is covered in the retry test below."""
    with tempfile.TemporaryDirectory() as td:
        arc = guard.archive_path(td, DAY)
        with open(arc, "wb") as f:
            f.write(b"not really a 7z")
        got = guard.scan_archive_for_day(
            os.path.join(td, "definitely-absent-7z-binary.exe"), td, DAY
        )
    assert got is None, f"a failed extraction must be None, got {got!r}"


def test_unreadable_archive_is_not_a_zero():
    """An archive that is not there is unmeasurable, not zero. The caller only
    asks when it believes an archive exists, so a miss means the mount moved
    under it — and a zero cached there is permanent.

    This case also pins the ARITY that shipped broken: both zero-returning
    branches returned 4-tuples while the caller unpacks 5, so a vanished
    archive raised ValueError at the call site. A short tuple is not a zero,
    and neither is a crash."""
    with tempfile.TemporaryDirectory() as td:
        got = guard.scan_archive_for_day("7z", td, DAY)
    assert got is None, f"an absent archive is unmeasurable, not a zero; got {got!r}"


def test_failed_archive_read_is_not_cached():
    """The defect, driven through the REAL failure path (a 7z that cannot be
    launched) rather than a stubbed return — so restoring the original code
    fails here cleanly instead of crashing on an unpack."""
    with tempfile.TemporaryDirectory() as td:
        with open(guard.archive_path(td, DAY), "wb") as f:
            f.write(b"x")
        restore = _patch_scanners(lambda d, day: EMPTY, guard.scan_archive_for_day)
        try:
            state = _fresh_state()
            guard.refresh_days(
                state, _args(td, td, seven_zip=os.path.join(td, "absent-7z.exe"))
            )
        finally:
            restore()
    assert DAY not in state["days"], (
        "a FAILED archive read was cached — that zero is permanent: "
        f"days={state['days']!r}"
    )


def test_retry_recovers_the_real_numbers():
    """POSITIVE CONTROL for the case above: skipping must not mean giving up.
    The next tick, with a working read, must count the day for real."""
    with tempfile.TemporaryDirectory() as td:
        with open(guard.archive_path(td, DAY), "wb") as f:
            f.write(b"x")
        args = _args(td, td, seven_zip=os.path.join(td, "absent-7z.exe"))

        restore = _patch_scanners(lambda d, day: EMPTY, guard.scan_archive_for_day)
        try:
            state = _fresh_state()
            guard.refresh_days(state, args)
            assert DAY not in state["days"], "the failed read was cached as a zero"
        finally:
            restore()

        restore = _patch_scanners(lambda d, day: EMPTY, lambda z, a, day: SOME)
        try:
            guard.refresh_days(state, args)
        finally:
            restore()

    entry = state["days"].get(DAY)
    assert entry is not None, "the retry never counted the day"
    assert entry["source"] == "archive" and entry["files"] == 7
    assert entry["out"] == 100 and entry["cache_read"] == 300


def test_extracted_zero_is_still_cached():
    """CONTROL against over-correction: an archive that genuinely extracts zero
    meter files is a real zero and must be cached as such — otherwise the day
    would be re-scanned on every tick forever."""
    with tempfile.TemporaryDirectory() as td:
        with open(guard.archive_path(td, DAY), "wb") as f:
            f.write(b"x")
        restore = _patch_scanners(lambda d, day: EMPTY, lambda z, a, day: EMPTY)
        try:
            state = _fresh_state()
            guard.refresh_days(state, _args(td, td))
        finally:
            restore()
    entry = state["days"].get(DAY)
    assert entry is not None, "an extracted zero must be cached (else it re-scans forever)"
    assert entry["source"] == "archive" and entry["files"] == 0


def test_unlistable_loose_dir_falls_back_to_the_archive():
    """Same arity class as the archive branches, on the loose path: an
    unlistable captures dir returned a 4-tuple into a 5-way unpack, so the tick
    died with ValueError instead of falling back to the archive. The fallback
    itself is the intended behaviour and is pinned here."""
    with tempfile.TemporaryDirectory() as td:
        missing = os.path.join(td, "no-such-captures-dir")
        with open(guard.archive_path(td, DAY), "wb") as f:
            f.write(b"x")
        restore = _patch_scanners(guard.scan_dir_for_day, lambda z, a, day: SOME)
        try:
            state = _fresh_state()
            guard.refresh_days(state, _args(td, missing))
        finally:
            restore()
    entry = state["days"].get(DAY)
    assert entry is not None, "the tick died instead of falling back to the archive"
    assert entry["source"] == "archive" and entry["out"] == 100


def test_cached_archive_day_is_not_recomputed():
    """The invariant the fix protects, pinned so a later edit cannot drop it: a
    day already cached from an archive is never re-read."""
    with tempfile.TemporaryDirectory() as td:
        calls = []

        def exploding(z, a, day):
            calls.append(day)
            raise AssertionError("an archive-cached day must not be re-scanned")

        restore = _patch_scanners(lambda d, day: EMPTY, exploding)
        try:
            state = {"baseline_day": DAY, "days": {DAY: guard.day_entry("archive", 5, 1, 2, 3, 4)}}
            guard.refresh_days(state, _args(td, td))
        finally:
            restore()
    assert calls == [], f"archive-cached day was re-scanned: {calls!r}"
    assert state["days"][DAY]["files"] == 5


def main():
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = []
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as e:
            failed.append(name)
            print(f"FAIL {name}: {e}")
        except Exception as e:  # noqa: BLE001 — surface any error as a failure
            failed.append(name)
            print(f"ERROR {name}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - len(failed)}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
