#!/usr/bin/env python3
"""Pins for the day-parts declaration and reading (#1152 c, decision c.7076270061).

With the rolling loose window armed, a day's captures leave the loose corpus
every 3 h into `captures-<day>-p<HHMM>[-<tag>].7z` parts. Three contracts are
pinned:

  AC 2 — no silent undercount: a loose reader whose window overlaps a packed
         day DECLARES the unread span (PARTIAL line, lib/partial_parts.py),
         one integration pin per first-wave reader (native-consumption,
         traffic-consumption, billed-attrib).
  AC 4 — the leak-policy verdict is EXACT: the same corpus run loose then
         packed into a part gives the SAME counts and exit code
         (native-consumption --leak-policy merges part members).
  AC 3 — archive readers accept a day made of parts: capture-workspace-
         attribution reads the SAME names/bodies whether the day sits in one
         archive or in parts (real py7zr archives); turn-composition tags
         per_archive rows with the part info (fake 7z harness).

Run: python scripts/tests/test_partial_parts.py
"""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(_HERE, "..", relpath))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pp = _load("partial_parts", os.path.join("lib", "partial_parts.py"))

W_START = datetime(2026, 11, 9, 0, 0, tzinfo=timezone.utc)
W_END = datetime(2026, 11, 10, 0, 0, tzinfo=timezone.utc)


def _touch(path, body=b"7z synthetic"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(body)


def _req(d, pid, n, stamp, machine, model="claude-opus-5-5", device=None, body=None):
    env = {"ts": stamp, "src": "direct", "machine": machine, "model": model}
    if device:
        env["device_id8"] = device
    env["body"] = body or {"model": model, "messages": [{"role": "user", "content": "hi"}]}
    name = f"req-{pid}-{n}-{stamp}-direct.json"
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        json.dump(env, f)


def _resp(d, pid, rank, stamp, model, reqN, hdr_pid=None):
    name = f"resp-{pid}-r{rank}-{stamp}-native-{model}.sse"
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        f.write(f"# parser=anthropic-sse model={model} reqN={reqN} pid={hdr_pid or pid}\n")
        f.write('event: message_start\ndata: {"type":"message_start"}\n\n')


def _pack(paths, archive):
    """Real py7zr archive with the given files as members (flat names)."""
    import py7zr

    os.makedirs(os.path.dirname(archive), exist_ok=True)
    with py7zr.SevenZipFile(archive, "w") as z:
        for p in paths:
            z.write(p, arcname=os.path.basename(p))


# ---------------------------------------------------------------------------
# lib pins
# ---------------------------------------------------------------------------

def test_part_naming_and_day_union():
    with tempfile.TemporaryDirectory() as td:
        arch = os.path.join(td, "archive")
        _touch(os.path.join(arch, "captures-2026-11-09.7z"))
        _touch(os.path.join(arch, "captures-2026-11-09-p0300.7z"))
        _touch(os.path.join(arch, "captures-2026-11-09-p0600-myia-po-2025.7z"))
        _touch(os.path.join(arch, "captures-2026-11-08.7z"))
        parts = pp.list_parts(td)
        assert [p["slot"] for p in parts] == ["0300", "0600"], parts
        assert parts[1]["tag"] == "myia-po-2025", parts
        # a part is NOT the day archive — DAY_ARCHIVE_FN would eat it whole
        assert pp.DAY_ARCHIVE_FN.match("captures-2026-11-09-p0300.7z")
        got = pp.day_archives_for(td, "2026-11-09")
        assert [os.path.basename(p) for p in got] == [
            "captures-2026-11-09.7z",          # the day archive FIRST
            "captures-2026-11-09-p0300.7z",    # parts in slot order after
            "captures-2026-11-09-p0600-myia-po-2025.7z"], got
        assert pp.day_archives_for(td, "2026-11-08") == [
            os.path.join(arch, "captures-2026-11-08.7z")]
        assert pp.day_archives_for(td, "2026-11-07") == []


def test_parts_in_window_and_dedup():
    with tempfile.TemporaryDirectory() as td:
        arch = os.path.join(td, "archive")
        _touch(os.path.join(arch, "captures-2026-11-08-p0100.7z"))
        _touch(os.path.join(arch, "captures-2026-11-09-p0100.7z"))
        # same part in a second dir (Drive copy): counts ONCE
        other = os.path.join(td, "drive")
        _touch(os.path.join(other, "captures-2026-11-09-p0100.7z"))
        in_w = pp.parts_in_window(td, W_START, W_END)
        assert len(in_w) == 1 and in_w[0]["day"] == "2026-11-09", in_w
        # day-overlap granularity: a part of a day the window touches counts
        w2s = datetime(2026, 11, 9, 23, 0, tzinfo=timezone.utc)
        w2e = datetime(2026, 11, 10, 1, 0, tzinfo=timezone.utc)
        assert len(pp.parts_in_window(td, w2s, w2e)) == 1


def test_render_partial_wording_and_merge_exclusion():
    with tempfile.TemporaryDirectory() as td:
        arch = os.path.join(td, "archive")
        _touch(os.path.join(arch, "captures-2026-11-09-p0300.7z"))
        lines = pp.section(td, W_START, W_END)
        assert lines, "a packed day in the window must not be silence"
        joined = "\n".join(lines)
        assert "PARTIAL" in joined, joined
        assert "2026-11-09" in joined, "the unread span must be NAMED"
        assert "undercount" in joined, joined
        # no parts -> nothing to say (a loose-only corpus stays quiet)
        with tempfile.TemporaryDirectory() as td2:
            assert pp.section(td2, W_START, W_END) == []
        # every part merged -> quiet (exact reader, no undercount left)
        res = pp.assess(td, W_START, W_END,
                        merged_paths=[os.path.join(arch, "captures-2026-11-09-p0300.7z")])
        assert res["partial"] is False, res


# ---------------------------------------------------------------------------
# AC 2 — one integration pin per first-wave reader
# ---------------------------------------------------------------------------

def test_native_consumption_declares_partial():
    nc = _load("nc_partial", "native-consumption.py")
    with tempfile.TemporaryDirectory() as td:
        _req(td, 1, 7, "2026-11-09T06-00-00-000Z", "myia-po-2024")
        _resp(td, 1, 90, "2026-11-09T06-00-05-000Z", "claude-opus-5-5", 7)
        # the day packed into a part — normal mode lists, it does not open
        _touch(os.path.join(td, "archive", "captures-2026-11-09-p0300.7z"))
        argv_backup = sys.argv
        sys.argv = ["native-consumption.py", "--captures-dir", td,
                    "--since", "2026-11-09T00"]
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                nc.main()
        finally:
            sys.argv = argv_backup
        assert "PARTIAL" in out.getvalue(), out.getvalue()[-600:]


def test_traffic_consumption_declares_partial():
    tc = _load("tc_partial", "traffic-consumption.py")
    with tempfile.TemporaryDirectory() as td:
        with open(os.path.join(
                td, "resp-1-r1-2026-11-09T10-00-00-000Z-gc-glm-5.3.sse"),
                "w", encoding="utf-8") as fh:
            fh.write("# parser=openai model=glm-5.3 reqN=1 pid=1\n")
        _touch(os.path.join(td, "archive", "captures-2026-11-09-p0300.7z"))
        argv_backup = sys.argv
        sys.argv = ["traffic-consumption.py", "--hours", "500", "--dir", td]
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                tc.main()
        finally:
            sys.argv = argv_backup
        assert "PARTIAL" in out.getvalue(), out.getvalue()[-600:]


def test_billed_attrib_declares_partial():
    with tempfile.TemporaryDirectory() as td:
        os.environ["CLAUDISH_CAPTURES_ROOT"] = td
        ba = _load("ba_partial", "billed-attrib.py")
        with open(os.path.join(
                td, "resp-1-r1-2026-11-09T10-00-00-000Z-native-claude.sse"),
                "w", encoding="utf-8") as fh:
            fh.write('{"input_tokens":10,"cache_creation_input_tokens":0,'
                     '"cache_read_input_tokens":0} {"output_tokens":5}')
        _touch(os.path.join(td, "archive", "captures-2026-11-09-p0300.7z"))
        argv_backup = sys.argv
        sys.argv = ["billed-attrib.py", "2026-11-09"]
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                ba.main()
        finally:
            sys.argv = argv_backup
        assert "PARTIAL" in out.getvalue(), out.getvalue()[-600:]


# ---------------------------------------------------------------------------
# AC 4 — the leak-policy verdict is exact across the packing boundary
# ---------------------------------------------------------------------------

def _row(out, machine):
    table = out.split("Leak-policy (#445)", 1)[-1]
    for line in table.splitlines():
        if line.strip().startswith(machine + " "):
            return line
    return ""


def test_leak_policy_identical_before_after_packing():
    """The SAME corpus, loose then packed into a part: same rows, same exit.

    Without the merge, the packed run would print « Aucune capture native »
    and exit 1 — an undercount swallowing the whole verdict (the failure AC 4
    exists to prevent). Real py7zr archives, real subprocess runs.
    """
    def build(td):
        _req(td, 9, 1, "2026-11-09T01-00-00-000Z", "myia-ai-01")
        _req(td, 1, 7, "2026-11-09T06-00-00-000Z", "myia-ai-01")
        _resp(td, 1, 90, "2026-11-09T06-00-05-000Z", "claude-opus-5-5", 7)
        _req(td, 1, 3, "2026-11-09T07-01-00-000Z", "myia-po-2024",
             device="0b9b0d8c",
             body={"system": [{"type": "text",
                               "text": "x-anthropic-billing-header: cc_is_subagent=true"}],
                   "messages": []})
        _resp(td, 1, 13, "2026-11-09T07-01-03-000Z", "claude-opus-5-5", 3)

    def run(td):
        empty = tempfile.mkdtemp(prefix="pp-rdir-")
        # #1175: pin the child's byte contract (see test_native_leak_policy):
        # without PYTHONIOENCODING the report's '—'/'·' come out cp1252 on a
        # Windows seat and a strict utf-8 decode kills the run before the
        # assertion; errors="replace" + (or "") always returns text.
        p = subprocess.run(
            [sys.executable, os.path.join(_HERE, "..", "native-consumption.py"),
             "--leak-policy", "--captures-dir", td,
             "--reconcile-dir", empty, "--since", "2026-11-09T00"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        return p.returncode, (p.stdout or "") + (p.stderr or "")

    with tempfile.TemporaryDirectory() as td:
        build(td)
        code_loose, out_loose = run(td)
        assert code_loose == 0, out_loose
        assert "verdict valide" in out_loose, out_loose

        # pack the whole day into a part, remove the loose originals
        members = [os.path.join(td, n) for n in sorted(os.listdir(td))
                   if n.startswith(("req-", "resp-"))]
        part = os.path.join(td, "archive", "captures-2026-11-09-p0300.7z")
        _pack(members, part)
        for m in members:
            os.remove(m)

        code_packed, out_packed = run(td)
        assert code_packed == code_loose, \
            f"exit moved across packing: {code_loose} -> {code_packed}\n{out_packed}"
        assert "verdict valide" in out_packed, out_packed
        assert "PARTIAL" not in out_packed, \
            f"a fully merged part must not declare an undercount:\n{out_packed}"
        for machine in ("myia-ai-01", "myia-po-2024"):
            assert _row(out_packed, machine) == _row(out_loose, machine), \
                f"row moved for {machine}:\nloose:   {_row(out_loose, machine)}\n" \
                f"packed:  {_row(out_packed, machine)}\n{out_packed}"
        assert "sub=1/1" in _row(out_packed, "myia-po-2024"), _row(out_packed, "myia-po-2024")


def test_leak_policy_partial_when_part_unreadable():
    """A corrupt part in the window: the verdict says PARTIAL, it never
    pretends the packed day was empty-but-fine."""
    with tempfile.TemporaryDirectory() as td:
        _req(td, 9, 1, "2026-11-09T01-00-00-000Z", "myia-ai-01")
        # a part that is NOT a 7z at all — py7zr will refuse it
        _touch(os.path.join(td, "archive", "captures-2026-11-09-p0300.7z"),
               body=b"garbage not a 7z")
        empty = tempfile.mkdtemp(prefix="pp-rdir-")
        p = subprocess.run(
            [sys.executable, os.path.join(_HERE, "..", "native-consumption.py"),
             "--leak-policy", "--captures-dir", td,
             "--reconcile-dir", empty, "--since", "2026-11-09T00"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        out = (p.stdout or "") + (p.stderr or "")
        assert "PARTIAL" in out, out
        assert "unreadable" in out, out


# ---------------------------------------------------------------------------
# AC 3 — archive readers accept a day made of parts
# ---------------------------------------------------------------------------

def test_cwa_same_names_and_bodies_one_archive_vs_parts():
    """capture-workspace-attribution: the day packed as ONE archive vs as
    PARTS gives the same member names and the same bodies."""
    cwa = _load("cwa_parts", "capture-workspace-attribution.py")
    day = "2026-11-09"
    stamps = ["06-00-00", "06-30-00", "07-00-00", "07-30-00", "08-00-00"]

    def build(td):
        paths = []
        for i, s in enumerate(stamps, start=1):
            n = f"req-1-{i:04d}-{day}T{s}-000Z-direct.json"
            p = os.path.join(td, n)
            with open(p, "w", encoding="utf-8") as fh:
                json.dump({"ts": f"{day}T{s}", "src": "direct",
                           "machine": "seat-a",
                           "body": {"messages": [{"role": "user",
                                                  "content": f"msg {i}"}]}}, fh)
            paths.append((n, p))
        return paths

    with tempfile.TemporaryDirectory() as one, tempfile.TemporaryDirectory() as many:
        files1 = build(one)
        files2 = build(many)
        _pack([p for _, p in files1],
              os.path.join(one, "archive", f"captures-{day}.7z"))
        # the same day as two parts (slot order): first 3, then last 2
        _pack([p for _, p in files2[:3]],
              os.path.join(many, "archive", f"captures-{day}-p0300.7z"))
        _pack([p for _, p in files2[3:]],
              os.path.join(many, "archive", f"captures-{day}-p0600.7z"))

        for root in (one, many):
            dirs = (os.path.join(root, "archive"),)
            by_day, missing, totals = cwa.sample_period([day], dirs, 100)
            assert missing == [], missing
            assert totals[day] == len(stamps), (root, totals)
        # read_bodies returns the same bodies in the same member order
        names = [n for n, _ in files1]
        for root in (one, many):
            with tempfile.TemporaryDirectory(prefix="pp-scratch-") as scratch:
                bodies = cwa.read_bodies(day, names,
                                         (os.path.join(root, "archive"),),
                                         scratch)
            assert len(bodies) == len(stamps), (root, len(bodies))
            for i, raw in enumerate(bodies, start=1):
                assert f"msg {i}".encode() in raw, (root, i, raw[:80])


def test_turn_composition_tags_part_rows():
    """turn-composition cmd_archive: per_archive rows CARRY the part info
    (slot/tag) and day archives carry None. Fake 7z harness — the machine
    running this test has no 7z binary (pinned candidates absent)."""
    tc = _load("tc_parts", "turn-composition.py")
    day = "2026-11-09"
    with tempfile.TemporaryDirectory() as td:
        # two members: the concatenated stream `7z e -so` would emit. Compact
        # separators — the strict member marker is `{"ts":"…","src":"` with
        # NO spaces (default json.dumps spacing would not split members).
        body = "".join(
            json.dumps({"ts": f"{day}T06-0{i}-00-000Z", "src": "direct",
                        "machine": "seat-a", "model": "claude-opus-5-5"},
                       separators=(",", ":"))
            for i in range(2)).encode()
        part = os.path.join(td, f"captures-{day}-p0300-seat-a.7z")
        with open(part, "wb") as fh:
            fh.write(b"synthetic")
        daya = os.path.join(td, f"captures-{day}.7z")
        with open(daya, "wb") as fh:
            fh.write(b"synthetic")

        # the `e -so` branch must emit the member bodies — the fake cannot
        # easily carry them inline, so it types them from a side file
        with open(os.path.join(td, "stream.bin"), "wb") as fh:
            fh.write(body)
        # portable fake: a .cmd on Windows, a #!/bin/sh twin on POSIX (CI's
        # scripts-tests job runs ubuntu — a .cmd there is a PermissionError)
        if os.name == "nt":
            fake = os.path.join(td, "fake7z.cmd")
            with open(fake, "w", encoding="ascii", newline="\r\n") as fh:
                fh.write("@echo off\r\n"
                         "if /i \"%~1\"==\"l\" (\r\n"
                         f"  echo Path = req-1-0001-{day}T06-00-00-000Z-direct.json\r\n"
                         f"  echo Path = req-1-0002-{day}T06-01-00-000Z-direct.json\r\n"
                         "  exit /b 0\r\n"
                         ")\r\n"
                         "if /i \"%~1\"==\"e\" (\r\n"
                         f"  type \"{os.path.join(td, 'stream.bin')}\"\r\n"
                         "  exit /b 0\r\n"
                         ")\r\n"
                         "exit /b 1\r\n")
        else:
            fake = os.path.join(td, "fake7z.sh")
            stream = os.path.join(td, "stream.bin")
            with open(fake, "w", encoding="ascii", newline="\n") as fh:
                fh.write("#!/bin/sh\n"
                         "if [ \"$1\" = \"l\" ]; then\n"
                         f"  echo 'Path = req-1-0001-{day}T06-00-00-000Z-direct.json'\n"
                         f"  echo 'Path = req-1-0002-{day}T06-01-00-000Z-direct.json'\n"
                         "  exit 0\n"
                         "fi\n"
                         "if [ \"$1\" = \"e\" ]; then\n"
                         f"  cat '{stream}'\n"
                         "  exit 0\n"
                         "fi\n"
                         "exit 1\n")
            os.chmod(fake, 0o755)

        out_path = os.path.join(td, "out.json")
        argv_backup = sys.argv
        sys.argv = ["turn-composition.py", "archive",
                    "--archives", os.path.join(td, f"captures-{day}*.7z"),
                    "--label", "parts-pin", "--sevenzip", fake,
                    "--out", out_path]
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                tc.main()
        finally:
            sys.argv = argv_backup
        with open(out_path, encoding="utf-8") as fh:
            res = json.load(fh)
        by_name = {os.path.basename(r["archive"]): r for r in res["per_archive"]}
        part_row = by_name[f"captures-{day}-p0300-seat-a.7z"]
        assert part_row["part"] == {"day": day, "slot": "0300",
                                    "tag": "seat-a"}, part_row
        assert by_name[f"captures-{day}.7z"]["part"] is None, by_name


# ---------------------------------------------------------------------------
# #1195 — warm_first_open : une ouverture par fichier, hors du fil appelant
# ---------------------------------------------------------------------------

def test_warm_read_bytes_is_the_measured_access():
    """Le chiffre du 25/11 est lie a l'ACCES, pas seulement au pool : changer
    les octets lus invalide la mesure, et le dire vaut mieux que le taire."""
    assert pp.WARM_READ_BYTES == 300_000, (
        "le 8,41 ms/fichier du 25/11 a ete mesure avec open + read(300_000) — "
        "les octets que traffic-consumption garde d'une reponse (HEAD_BYTES "
        "200 000 + TAIL_BYTES 100 000) ; changer cette valeur invalide ce "
        "chiffre : re-mesurer")
    assert pp.WARM_POOL == 8, pp.WARM_POOL


def test_warm_first_open_opens_each_file_once_off_caller():
    """Chaque fichier ouvert UNE fois, et jamais sur le fil de l'appelant
    quand le pool est arme — marque STRUCTURELLE (ident du fil qui a ouvert),
    jamais un temps."""
    import builtins
    import threading

    with tempfile.TemporaryDirectory() as td:
        paths = []
        for i in range(8):
            p = os.path.join(td, "member-%d.sse" % i)
            with open(p, "wb") as fh:
                fh.write(b"#" + b"x" * 4096)
            paths.append(os.path.abspath(p))
        wanted = set(paths)
        seen = []
        lock = threading.Lock()
        real_open = builtins.open

        def spy(path, *a, **k):
            with lock:
                seen.append((os.path.abspath(str(path)), threading.get_ident()))
            return real_open(path, *a, **k)

        builtins.open = spy
        try:
            n = pp.warm_first_open(paths, 4)
        finally:
            builtins.open = real_open
        opened = [p for p, _t in seen if p in wanted]
        threads = {t for p, t in seen if p in wanted}
        assert n == len(paths), (n, len(paths))
        assert sorted(opened) == sorted(paths), opened
        assert threads, "aucune ouverture enregistree"
        assert threading.get_ident() not in threads, (
            "pool arme : aucune ouverture ne doit rester sur le fil appelant")


def test_warm_first_open_serial_stays_on_caller_thread():
    """workers <= 1 = le chiffre en serie, sur le fil de l'appelant (c'est
    aussi l'interrupteur)."""
    import builtins
    import threading

    with tempfile.TemporaryDirectory() as td:
        paths = []
        for i in range(3):
            p = os.path.join(td, "ser-%d.sse" % i)
            with open(p, "wb") as fh:
                fh.write(b"x" * 64)
            paths.append(os.path.abspath(p))
        seen = []
        real_open = builtins.open

        def spy(path, *a, **k):
            seen.append((os.path.abspath(str(path)), threading.get_ident()))
            return real_open(path, *a, **k)

        builtins.open = spy
        try:
            n = pp.warm_first_open(paths, 1)
        finally:
            builtins.open = real_open
        assert n == 3, n
        assert {t for _p, t in seen} == {threading.get_ident()}, seen


def test_warm_first_open_skips_unopenable_and_counts_the_rest():
    """Une erreur d'ouverture ne leve pas : le fichier est saute et n'est pas
    compte — le lecteur le retrouvera et appliquera SA politique."""
    with tempfile.TemporaryDirectory() as td:
        good = os.path.join(td, "good.sse")
        with open(good, "wb") as fh:
            fh.write(b"y" * 128)
        missing = os.path.join(td, "absent.sse")
        assert pp.warm_first_open([good, missing], 4) == 1
        assert pp.warm_first_open([good, missing], 1) == 1
        assert pp.warm_first_open([], 4) == 0


def test_warm_pool_bound_is_explicit_and_applied_by_the_executor():
    """La borne du pool est une VALEUR APPLIQUEE, pas une intention (review
    ai-01 25/11, reserve 7161871992 : « le CLI accepte tout entier et
    l'executeur l'utilise tel quel ») : l'executeur ne recoit jamais plus de
    WARM_POOL_MAX fils. Marque STRUCTURELLE — le max_workers vu par
    ThreadPoolExecutor — jamais un temps, ni un nombre de fils reels (l'OS
    en cree moins qu'il ne peut)."""
    import concurrent.futures

    assert pp.WARM_POOL <= pp.WARM_POOL_MAX, (pp.WARM_POOL, pp.WARM_POOL_MAX)
    assert pp.bound_workers(pp.WARM_POOL) == pp.WARM_POOL
    assert pp.bound_workers(pp.WARM_POOL_MAX) == pp.WARM_POOL_MAX
    assert pp.bound_workers(pp.WARM_POOL_MAX + 1) == pp.WARM_POOL_MAX
    assert pp.bound_workers(10 ** 6) == pp.WARM_POOL_MAX
    assert pp.bound_workers(0) == 1
    assert pp.bound_workers(-5) == 1
    assert pp.bound_workers(None) == 1
    assert pp.bound_workers("pas-un-nombre") == 1

    seen = []
    real_ex = concurrent.futures.ThreadPoolExecutor

    class SpyExecutor(real_ex):
        def __init__(self, max_workers=None, *a, **k):
            seen.append(max_workers)
            super().__init__(max_workers, *a, **k)

    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, "borne.sse")
        with open(p, "wb") as fh:
            fh.write(b"b" * 16)
        concurrent.futures.ThreadPoolExecutor = SpyExecutor
        try:
            n = pp.warm_first_open([p], 10 ** 6)
        finally:
            concurrent.futures.ThreadPoolExecutor = real_ex
    assert n == 1, n
    assert seen == [pp.WARM_POOL_MAX], seen


def test_warm_candidates_is_the_preparation_flat_sorted_and_raising():
    """La PREPARATION : fichiers DIRECTS, tries ; un sous-dossier n'est pas un
    membre ; une racine illisible LEVE — c'est ce qui rend la garde de
    l'appelant necessaire (pin A15d du lecteur d'archives)."""
    with tempfile.TemporaryDirectory() as td:
        for fn in ("b.sse", "a.sse", "c.json"):
            with open(os.path.join(td, fn), "wb") as fh:
                fh.write(b"m" * 8)
        sub = os.path.join(td, "sub")
        os.makedirs(sub)
        with open(os.path.join(sub, "d.sse"), "wb") as fh:
            fh.write(b"m" * 8)
        got = pp.warm_candidates(td)
        assert [os.path.basename(p) for p in got] == ["a.sse", "b.sse", "c.json"], got
        assert all(os.path.dirname(p) == td for p in got), got
        assert pp.warm_candidates(sub) == [os.path.join(sub, "d.sse")]
        try:
            pp.warm_candidates(os.path.join(td, "absente"))
        except OSError:
            pass
        else:
            raise AssertionError("une racine absente doit lever : la garde de "
                                 "l'appelant est chargee de cet echec")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} passed")
