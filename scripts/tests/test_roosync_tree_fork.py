#!/usr/bin/env python3
r"""A seat whose two env layers name DIFFERENT RooSync trees must be visible.

Measured twice on myia-po-2024 (2026-11-22/23, #1136): `ROOSYNC_SHARED_PATH`
reads as the 2025 chain in the running MCP host process and as the 2026 chain
at the User scope, and both trees exist with disjoint content at the same
write instants. The repoint happened at the User scope; the process predates
it and keeps publishing into the old tree.

Nothing else on the fleet can see this: `settings-matrix.py` reads whichever
path it is handed (`scripts/settings-matrix.py:532`) and reports it as *the*
tree. So the pins below hold one property above all others:

    `SAME` means COMPARED AND SAME. It never means "could not compare".

Four ways to be unable to compare — the User scope unreadable on this host,
neither layer set, agreeing names that do not exist, an absent newest-write —
must all come back `UNMEASURABLE` (exit 2), never a clean bill. A probe that
returns 0 because it measured nothing is the exact defect this grain exists
to make impossible.

The masking pin is the second load-bearing one: the report is meant to be
quotable in a dashboard post, so no component above the tree name may survive
(no drive letter, no user directory). Q85.

The cascade pins hold a second property: a store-bound reader's "absent" is a
binding, not a fact. The canon store of `roosync_claudish_cascade` lives under
ONE tree on a forked seat, so a tree that was never probed must come back
`not-probed` — never "absent", and never a silently missing line.

Fixtures are 100 % synthetic: fabricated layer values, fake tree roots under a
temp directory. No real seat path appears in this file.

Run standalone:   python scripts/tests/test_roosync_tree_fork.py
Or under pytest:  pytest scripts/tests/test_roosync_tree_fork.py
"""

import importlib.util
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, os.pardir, "roosync-tree-fork.py")

_spec = importlib.util.spec_from_file_location("roosync_tree_fork", _MOD_PATH)
fork = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fork)


NOW = datetime(2026, 11, 23, 6, 0, 0, tzinfo=timezone.utc)

# Two trees that differ exactly the way the measured fork differs: a sibling
# directory whose name carries a Google Drive "(1)" duplicate suffix.
TREE_OLD = r"\\gdrive\Drive\Shared\Synchronisation\RooSync\.shared-state"
TREE_NEW = r"\\gdrive\Drive\Shared\Synchronisation (1)\RooSync\.shared-state"


def _snapshots(mapping):
    """A snapshot_fn returning a canned entry per raw path (tests only)."""
    def fn(shared_path, machine):
        return dict(mapping[shared_path])
    return fn


def _absent(shared_path, machine):
    return {"exists": False, "tree_exists": False, "newest": None, "age_h": None, "files": 0}


def _probe(proc, user, user_error=None, snapshot_fn=None, case_insensitive=True, cascade_fn=None):
    return fork.probe(
        process_value=proc,
        user_value=user,
        user_error=user_error,
        machine="test-seat",
        now=NOW,
        snapshot_fn=snapshot_fn or _absent,
        case_insensitive=case_insensitive,
        cascade_fn=cascade_fn,
    )


# --- the fork itself -------------------------------------------------------


def test_two_layers_naming_different_trees_are_a_fork():
    report, code = _probe(TREE_OLD, TREE_NEW)
    assert report["verdict"] == "FORK", report
    assert code == 3, report
    trees = {l["layer"]: l["tree"] for l in report["layers"]}
    assert len(set(trees.values())) == 2, trees


def test_the_two_trees_are_named_so_a_human_can_tell_them_apart():
    # "Synchronisation" vs "Synchronisation (1)" is the whole finding; a report
    # that printed the leaf only ("RooSync") would say the two are identical.
    report, _ = _probe(TREE_OLD, TREE_NEW)
    labels = [l["tree"] for l in report["layers"]]
    assert len(set(labels)) == 2, labels
    assert any("(1)" in l for l in labels), labels


def test_the_same_tree_under_separator_trailing_slash_and_case_differences_is_not_a_fork():
    # The tree is planted here on purpose: SAME is reserved for a tree that
    # exists on the seat (see the unmeasurable pin below), so a same-name case
    # that injects no tree would be testing the wrong verdict.
    present = {"exists": True, "newest": "2026-11-23T04:00:00Z", "age_h": 2.0, "files": 3}
    report, code = _probe(r"\\gdrive\Drive\Shared\Tree\RooSync",
                          "//gdrive/drive/shared/tree/RooSync/",
                          snapshot_fn=_snapshots({r"\\gdrive\Drive\Shared\Tree\RooSync": present}))
    assert report["verdict"] == "SAME", report
    assert code == 0, report


def test_a_doubled_separator_is_not_a_fork():
    # T4, and the mutation ai-01's sweep found alive (M6, CR c.7093302681):
    # drop the `//` collapse and two spellings of ONE tree compare unequal.
    # A doubled separator is a spelling, not a second directory. The existing
    # separator pin cannot see this — its two spellings both start `//` after
    # the backslash swap, so they agree even with the collapse removed.
    present = {"exists": True, "newest": "2026-11-23T04:00:00Z", "age_h": 2.0, "files": 3}
    report, code = _probe(r"\\gdrive\Drive\Shared\Tree\RooSync",
                          "//gdrive//Drive///Shared/Tree/RooSync",
                          snapshot_fn=_snapshots({r"\\gdrive\Drive\Shared\Tree\RooSync": present}))
    assert report["verdict"] == "SAME", report
    assert code == 0, report


def test_normalize_path_collapses_doubled_separators():
    # Same property at the smallest site, so a future refactor of probe() cannot
    # lose it silently.
    assert fork.normalize_path("a//b///c\\d", case_insensitive=False) == "a/b/c/d"


def test_case_differences_are_a_fork_when_the_host_is_case_sensitive():
    # Positive control for the normalisation above: on a case-sensitive host
    # those two paths are two different directories, so the answer must differ.
    report, code = _probe(r"\\gdrive\Drive\Tree", "//gdrive/drive/tree",
                          case_insensitive=False)
    assert report["verdict"] == "FORK", report


def test_one_layer_set_while_the_other_is_unset_is_a_fork():
    # Asymmetry is the defect, not a tie: the process falls back to a default
    # while the User scope points somewhere explicit.
    report, code = _probe(TREE_OLD, None)
    assert report["verdict"] == "FORK", report
    assert code == 3, report
    layers = {l["layer"]: l for l in report["layers"]}
    assert layers["process"]["set"] is True, layers
    assert layers["user"]["set"] is False, layers


# --- the property that matters most: 0 means measured --------------------


def test_an_unreadable_user_layer_is_never_reported_as_clean():
    report, code = _probe(TREE_OLD, None, user_error="user-scope env not readable here")
    assert report["verdict"] == "UNMEASURABLE", report
    assert code == 2, report
    assert report["reason"], report


def test_a_user_layer_read_but_unset_is_a_fork_not_an_unmeasurable():
    # Distinguishing "read it, it is empty" from "could not read it" is the
    # whole point: the first is a finding, the second is a hole.
    report, code = _probe(TREE_OLD, None, user_error=None)
    assert report["verdict"] == "FORK" and code == 3, report

    report2, code2 = _probe(TREE_OLD, None, user_error="denied")
    assert report2["verdict"] == "UNMEASURABLE" and code2 == 2, report2


def test_both_layers_unset_is_unmeasurable():
    report, code = _probe(None, None)
    assert report["verdict"] == "UNMEASURABLE", report
    assert code == 2, report


def test_agreeing_names_that_exist_nowhere_are_unmeasurable():
    # Same name on both layers, but the tree is not on this seat: the seat
    # cannot say which tree holds its snapshots, so it must not say "fine".
    report, code = _probe(TREE_OLD, TREE_OLD)
    assert report["verdict"] != "SAME", report
    assert code == 2, report


def test_a_tree_without_this_machines_configs_names_the_right_absence():
    # Nit c.7093302681: the SAME escalation used to say "no such tree exists"
    # even when the tree is there and only `configs/<machine>` is missing.
    no_configs = {"exists": False, "tree_exists": True, "newest": None, "age_h": None, "files": 0}
    report, code = _probe(TREE_OLD, TREE_OLD,
                          snapshot_fn=_snapshots({TREE_OLD: no_configs}))
    assert report["verdict"] == "UNMEASURABLE" and code == 2, report
    assert "configs/test-seat" in report["reason"], report["reason"]
    assert "no such tree exists" not in report["reason"], report["reason"]


def test_the_output_declares_which_process_the_process_layer_reads():
    # CR 2: the process layer is the env THIS PROBE inherited, never the MCP
    # host's own — a report that stays silent reads as if it had read the host.
    report, _ = _probe(TREE_OLD, TREE_NEW)
    assert "proxy for the MCP host" in report["process_source"], report["process_source"]
    out = fork.render(report)
    assert "proxy for the MCP host" in out, out
    assert "never read" in out, out


def test_an_empty_string_counts_as_unset_with_its_own_wording():
    # A truthiness guard treats "" exactly like absent; the report must not
    # pretend a value was named.
    report, _ = _probe("", TREE_NEW)
    layers = {l["layer"]: l for l in report["layers"]}
    assert layers["process"]["set"] is False, layers


# --- masking: nothing above the tree name may be printed ------------------


def test_the_report_never_prints_a_component_above_the_tree_name():
    secret_component = "distinctive-user-name-42"
    proc = "C:\\Users\\%s\\DriveFS\\Synchronisation\\RooSync\\.shared-state" % secret_component
    user = "C:\\Users\\%s\\DriveFS\\Synchronisation (1)\\RooSync\\.shared-state" % secret_component
    report, _ = _probe(proc, user)
    rendered = fork.render(report)
    for text in (rendered, repr(report)):
        assert secret_component not in text, text
        assert "C:\\" not in text and "C:/" not in text, text
        assert "Users" not in text, text


def test_tree_label_masks_the_prefix_and_keeps_the_last_two_components():
    assert fork.tree_label(r"\\gdrive\Drive\Deep\A\Synchronisation (1)\RooSync\.shared-state") \
        == "<gdrive>/…/Synchronisation (1)/RooSync"


def test_tree_label_does_not_invent_a_prefix_for_a_short_path():
    # Positive control: a path with nothing above the tree name must not gain
    # a `<gdrive>/…/` it does not have.
    assert fork.tree_label("RooSync") == "RooSync"


def test_tree_label_masks_a_lone_drive_letter():
    assert fork.tree_label(r"D:\RooSync\.shared-state") == "<drive>/RooSync"


# --- which tree holds the newest snapshot --------------------------------


def test_the_freshest_snapshot_names_the_tree_that_holds_it():
    mapping = {
        TREE_OLD: {"exists": True, "newest": "2026-11-14T00:51:29Z", "age_h": 221.1, "files": 9},
        TREE_NEW: {"exists": True, "newest": "2026-11-23T04:00:00Z", "age_h": 2.0, "files": 4},
    }
    report, code = _probe(TREE_OLD, TREE_NEW, snapshot_fn=_snapshots(mapping))
    assert code == 3, report
    assert report["freshest"]["layer"] == "user", report["freshest"]
    out = fork.render(report)
    assert "2.0" in out or "2.0h" in out or "2.00" in out, out


def test_the_freshest_snapshot_says_so_when_the_process_tree_wins():
    mapping = {
        TREE_OLD: {"exists": True, "newest": "2026-11-23T05:00:00Z", "age_h": 1.0, "files": 9},
        TREE_NEW: {"exists": True, "newest": "2026-11-20T00:00:00Z", "age_h": 78.0, "files": 4},
    }
    report, _ = _probe(TREE_OLD, TREE_NEW, snapshot_fn=_snapshots(mapping))
    assert report["freshest"]["layer"] == "process", report["freshest"]


def test_a_tree_without_a_snapshot_is_reported_absent_never_blank():
    mapping = {
        TREE_OLD: {"exists": False, "newest": None, "age_h": None, "files": 0},
        TREE_NEW: {"exists": True, "newest": "2026-11-23T04:00:00Z", "age_h": 2.0, "files": 4},
    }
    report, _ = _probe(TREE_OLD, TREE_NEW, snapshot_fn=_snapshots(mapping))
    entries = {e["tree"]: e for e in report["snapshots"]}
    assert len(entries) == 2, report["snapshots"]
    assert any(e["exists"] is False for e in entries.values()), entries
    assert report["freshest"]["layer"] == "user", report["freshest"]


# --- the real filesystem half: newest write, bounded --------------------


def test_latest_write_reads_the_newest_mtime_recursively():
    root = Path(tempfile.mkdtemp(prefix="fork-"))
    deep = root / "v1.2.0" / "nested"
    deep.mkdir(parents=True)
    old = root / "old.json"
    old.write_text("{}", encoding="utf-8")
    newer = deep / "snap.json"
    newer.write_text("{}", encoding="utf-8")
    os.utime(old, (NOW.timestamp() - 7200, NOW.timestamp() - 7200))
    os.utime(newer, (NOW.timestamp() - 60, NOW.timestamp() - 60))

    newest, files, truncated = fork.latest_write(root)
    assert files == 2 and truncated is False, (files, truncated)
    assert newest is not None
    age = (NOW - newest).total_seconds()
    assert 30 < age < 120, age


def test_latest_write_of_a_missing_directory_returns_nothing():
    # Absence must stay an absence — never a zero mtime read as "fresh".
    newest, files, truncated = fork.latest_write(Path(tempfile.mkdtemp(prefix="fork-")) / "absent")
    assert newest is None and files == 0, (newest, files)


def test_latest_write_declares_truncation_instead_of_answering_from_half_a_tree():
    root = Path(tempfile.mkdtemp(prefix="fork-"))
    for i in range(12):
        (root / f"f{i}.json").write_text("{}", encoding="utf-8")
    newest, files, truncated = fork.latest_write(root, limit=5)
    assert truncated is True, (files, truncated)
    assert files <= 5, files


def test_exit_codes_are_the_three_declared_ones():
    assert fork.EXIT_CODES == {"SAME": 0, "UNMEASURABLE": 2, "FORK": 3}, fork.EXIT_CODES


# --- the cascade canon store under each tree (T10) ------------------------

ABSENT_STORE = {"status": "absent", "versions": None, "latest": None, "published_at": None,
                "age_h": None, "pointer": None, "truncated": False, "error": None}
PRESENT_STORE = {"status": "present", "versions": 4, "latest": "2026-11-05-test-label",
                 "published_at": "2026-11-05T22:36:02Z", "age_h": 415.4, "pointer": "ok",
                 "truncated": False, "error": None}

POINTER = ('{"version": "2026-11-05-kimi31-return", "publishedAt": "2026-11-05T22:36:02.345Z", '
           '"dirName": "v2026-11-05-kimi31-return-2026-11-05T22-36-02-345Z", '
           '"payloadPath": "versions/v2026-11-05-kimi31-return-2026-11-05T22-36-02-345Z/payload.json", '
           '"schemaVersion": 1, "canonicalHash": "deadbeef"}')


def _cascades(mapping):
    """A cascade_fn returning a canned store entry per raw path (tests only)."""
    def fn(shared_path):
        return dict(mapping[shared_path])
    return fn


def _tree_with_store(manifests=("v2026-11-05-a-2026-11-05T22-36-02-345Z",), pointer=None, store=True):
    """A synthetic shared tree, optionally carrying a canon store."""
    root = (Path(tempfile.mkdtemp(prefix="fork-"))
            / "Synchronisation" / "RooSync" / ".shared-state")
    root.mkdir(parents=True)
    if not store:
        return root
    base = root / "claudish-cascade"
    (base / "versions").mkdir(parents=True)
    for name in manifests:
        (base / "versions" / name).mkdir()
        (base / "versions" / name / "manifest.json").write_text('{"version": "synthetic"}', encoding="utf-8")
    if pointer is not None:
        (base / "latest.json").write_text(pointer, encoding="utf-8")
    return root


def test_a_store_in_one_tree_only_is_named_as_a_seat_reading_never_a_fleet_fact():
    # Measured 2026-11-25: `roosync_claudish_cascade list` on the seat answered
    # `store_present: false` while four versions sat in the other tree.
    report, code = _probe(TREE_OLD, TREE_NEW,
                          cascade_fn=_cascades({TREE_OLD: ABSENT_STORE, TREE_NEW: PRESENT_STORE}))
    assert code == 3, report
    assert report["cascade"]["divergent"] is True, report["cascade"]
    assert report["cascade"]["with_store"] == ["user"], report["cascade"]
    assert report["cascade"]["without_store"] == ["process"], report["cascade"]
    note = " ".join(report["notes"])
    assert "store_present: false" in note and "never a fleet fact" in note, report["notes"]
    out = fork.render(report)
    assert "2026-11-05-test-label" in out, out
    assert "no canon store under this tree" in out, out


def test_without_a_cascade_reader_the_report_says_not_probed_never_absent():
    # An unasked question is not a "no": a missing line would read as an absence.
    report, _ = _probe(TREE_OLD, TREE_NEW)
    assert report["cascade"]["probed"] is False, report["cascade"]
    assert report["cascade"]["divergent"] is None, report["cascade"]
    assert all(s["cascade"]["status"] == "not-probed" for s in report["snapshots"]), report["snapshots"]
    assert "cascade" not in fork.render(report), fork.render(report)


def test_an_unanswerable_tree_leaves_the_divergence_unmeasured():
    # One tree could not answer: the seat must not claim the store is elsewhere.
    error_store = dict(ABSENT_STORE, status="error", error="PermissionError: denied")
    report, _ = _probe(TREE_OLD, TREE_NEW,
                       cascade_fn=_cascades({TREE_OLD: PRESENT_STORE, TREE_NEW: error_store}))
    assert report["cascade"]["divergent"] is None, report["cascade"]
    assert report["cascade"]["unmeasured"] == ["user"], report["cascade"]
    assert "never a fleet fact" not in " ".join(report["notes"]), report["notes"]


def test_a_tree_that_was_never_probed_does_not_join_the_store_divergence():
    # M15, the pin the coordinator asked for on 27/11 (#1136, #1204): classify
    # `tree-missing` as "without_store" and a tree that was NEVER READ becomes
    # half of a finding -- the report prints "the canon store is under ONE tree
    # only" about an absence nobody measured. Concrete shape: the process tree
    # carries the store, the User scope points at a path on an unmounted drive.
    with tempfile.TemporaryDirectory() as root:
        missing = fork.cascade_store_report(Path(root) / "unmounted-drive", NOW)
    assert missing["status"] == "tree-missing", missing
    report, _ = _probe(TREE_OLD, TREE_NEW,
                       cascade_fn=_cascades({TREE_OLD: PRESENT_STORE, TREE_NEW: missing}))
    assert report["cascade"]["with_store"] == ["process"], report["cascade"]
    assert report["cascade"]["without_store"] == [], report["cascade"]
    assert report["cascade"]["unmeasured"] == ["user"], report["cascade"]
    assert report["cascade"]["divergent"] is None, report["cascade"]
    assert "never a fleet fact" not in " ".join(report["notes"]), report["notes"]


def test_a_store_present_or_absent_under_both_trees_is_not_divergent():
    both, _ = _probe(TREE_OLD, TREE_NEW,
                     cascade_fn=_cascades({TREE_OLD: PRESENT_STORE, TREE_NEW: PRESENT_STORE}))
    assert both["cascade"]["divergent"] is False, both["cascade"]
    neither, _ = _probe(TREE_OLD, TREE_NEW,
                        cascade_fn=_cascades({TREE_OLD: ABSENT_STORE, TREE_NEW: ABSENT_STORE}))
    assert neither["cascade"]["divergent"] is False, neither["cascade"]


def test_cascade_store_report_reads_a_planted_store_like_the_tool_does():
    report = fork.cascade_store_report(_tree_with_store(pointer=POINTER), NOW)
    assert report["status"] == "present", report
    assert report["versions"] == 1, report
    assert report["pointer"] == "ok", report
    assert report["latest"] == "2026-11-05-kimi31-return", report
    assert report["published_at"] == "2026-11-05T22:36:02Z", report
    # The age is measured against the publication, never reset to "fresh".
    assert 400 < report["age_h"] < 430, report


def test_a_missing_tree_is_not_a_missing_store():
    report = fork.cascade_store_report(Path(tempfile.mkdtemp(prefix="fork-")) / "absent-tree", NOW)
    assert report["status"] == "tree-missing", report


def test_a_tree_without_the_subdirectory_is_absent():
    report = fork.cascade_store_report(_tree_with_store(store=False), NOW)
    assert report["status"] == "absent", report


def test_a_store_without_a_pointer_is_present_with_no_latest():
    report = fork.cascade_store_report(_tree_with_store(manifests=(), pointer=None), NOW)
    assert report["status"] == "present" and report["pointer"] == "absent", report
    assert report["versions"] == 0 and report["latest"] is None, report


def test_a_malformed_pointer_is_reported_unreadable_never_absent():
    report = fork.cascade_store_report(_tree_with_store(pointer="{not json"), NOW)
    assert report["status"] == "present", report
    assert report["pointer"] == "unreadable", report
    assert report["error"], report


def test_a_pointer_without_the_fields_the_tool_requires_is_unreadable():
    # `readLatestCascadePointer` needs dirName and payloadPath strings.
    report = fork.cascade_store_report(_tree_with_store(pointer='{"version": "looks-fine"}'), NOW)
    assert report["pointer"] == "unreadable", report
    assert report["latest"] is None, report


def test_a_label_that_is_not_a_version_label_is_not_printed():
    # The tool prints whatever string it finds; a dashboard post must not inherit
    # a corrupted label (it could carry a newline or a path).
    bad = ('{"version": "..\\\\a path\\nand a line break", '
           '"publishedAt": "2026-11-05T22:36:02Z", '
           '"dirName": "vx", "payloadPath": "versions/vx/payload.json"}')
    report = fork.cascade_store_report(_tree_with_store(pointer=bad), NOW)
    assert report["pointer"] == "ok" and report["latest"] is None, report
    out = fork.render(_probe(TREE_OLD, TREE_OLD, cascade_fn=lambda path: report)[0])
    assert "a path" not in out and "\nand a line break" not in out, out


def test_a_version_directory_without_a_readable_manifest_is_not_counted():
    # The tool lists only `versions/v*` holding a parseable manifest.json.
    root = _tree_with_store()
    base = root / "claudish-cascade"
    (base / "versions" / "vbroken-x").mkdir()
    (base / "versions" / "vbroken-x" / "manifest.json").write_text("{", encoding="utf-8")
    (base / "versions" / "not-a-version").mkdir()
    (base / "versions" / "not-a-version" / "manifest.json").write_text("{}", encoding="utf-8")
    (base / "versions" / "stray.json").write_text("{}", encoding="utf-8")
    report = fork.cascade_store_report(root, NOW)
    assert report["versions"] == 1, report


def test_the_cascade_line_carries_no_path_even_when_the_store_is_broken():
    secret = "distinctive-user-name-44"
    root = (Path(tempfile.mkdtemp(prefix="fork-")) / secret
            / "Synchronisation" / "RooSync" / ".shared-state")
    (root / "claudish-cascade").mkdir(parents=True)
    (root / "claudish-cascade" / "versions").write_text("not a directory", encoding="utf-8")
    (root / "claudish-cascade" / "latest.json").write_text("{broken", encoding="utf-8")
    store = fork.cascade_store_report(root, NOW)
    report, _ = _probe(str(root), str(root), cascade_fn=lambda path: store)
    rendered = fork.render(report)
    for text in (rendered, repr(store), repr(report)):
        assert secret not in text, text
        assert "AppData" not in text, text
        assert "C:\\" not in text and "C:/" not in text, text


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
            except Exception as e:  # noqa: BLE001 - report, do not mask
                failures += 1
                print(f"ERROR {name}: {type(e).__name__}: {e}")
    print(f"\n{failures} failure(s)")
    raise SystemExit(1 if failures else 0)
