#!/usr/bin/env python
"""How long ONE day's archive read takes — the measurer behind the figures of
`docs/reference/traffic-analysis.md`, section "A finished day is read from its
archive -- once (#1161 stage 2)".

It times the EXACT call `traffic-consumption.py --from-archive` makes on a day
archive — `lib/partial_parts.read_members` (py7zr, `extract(targets=...)`),
filtered by the reader's own `day_member_filter` — on archives built here from
synthetic data, on a local disk, deleted at the end.

  A  per-file overhead  — many small members (8 KiB, stored: FILTER_COPY)
  B  bulk decompress    — one compressible member (LZMA2, default settings)

  python scripts/archive-read-measure.py                        # 30 000 members, 1 GiB
  python scripts/archive-read-measure.py --small 3000 --big-mb 128 --json

Peak disk under --work-dir (default `<repo>/.tmp`): the 1 GiB source plus its
extraction, ~2.2 GiB — refused under 3 GiB free. No `python -I`: py7zr lives
in the user site on the seats.

Exit 0 measured · 1 the extraction did not return what the header declared
(the figures fall, not the tool) · 2 refused before any write.
"""

import argparse
import importlib.util
import json
import os
import platform
import shutil
import sys
import tempfile
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
DAY = "2026-11-02"
OTHER = "2026-11-03"
GIB = 1 << 30


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_HERE, relpath))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def small_name(i):
    """The real shape of a response capture (response-capture.ts)."""
    pid = i % 40
    return (f"resp-{pid}-r{i // 40 + 1:04d}-{DAY}T10-{(i // 60) % 60:02d}-{i % 60:02d}"
            f"-123Z-openai-sse-glm-5.3.sse")


def default_work_dir():
    repo = os.path.join(_HERE, "..", ".tmp")
    return repo if os.path.isdir(repo) else tempfile.gettempdir()


def measure(args):
    try:
        import py7zr
    except ImportError as exc:
        print(f"REFUSED: py7zr is not importable here ({exc}) — archive mode needs it; "
              f"do not run this under python -I", file=sys.stderr)
        return 2

    pp = _load("pp", os.path.join("lib", "partial_parts.py"))
    tc = _load("tc", "traffic-consumption.py")
    keep = tc.day_member_filter(DAY)

    decoys = max(1, args.small // 100)
    need = args.big_mb * (1 << 20) + (args.small + decoys) * 8192
    work_root = os.path.abspath(args.work_dir)
    try:
        os.makedirs(work_root, exist_ok=True)
    except OSError as exc:
        print(f"REFUSED: work dir {work_root} — {exc}", file=sys.stderr)
        return 2
    free = shutil.disk_usage(work_root).free
    if free < need + 3 * GIB:
        print(f"REFUSED: {free} B free under {work_root}, needs {need + 3 * GIB} B "
              f"(lower --small / --big-mb or pass --work-dir)", file=sys.stderr)
        return 2

    res = {"py7zr": getattr(py7zr, "__version__", "?"), "python": platform.python_version(),
           "disk": work_root}
    work = tempfile.mkdtemp(prefix="archive-read-measure-", dir=work_root)
    try:
        # --- A: many small members, plus decoys of another day -----------------
        src = os.path.join(work, "a-src")
        os.makedirs(src)
        body = (b'data: {"type":"content_block_delta","delta":{"type":"text_delta",'
                b'"text":"lorem ipsum dolor sit amet 0123456789"}}\n' * 80)[:8192]
        for i in range(args.small):
            with open(os.path.join(src, small_name(i)), "wb") as fh:
                fh.write(body)
        for i in range(decoys):
            name = f"resp-{i}-r0001-{OTHER}T00-00-{i % 60:02d}-123Z-openai-sse-glm-5.3.sse"
            with open(os.path.join(src, name), "wb") as fh:
                fh.write(body)
        arch = os.path.join(work, "a.7z")
        t0 = time.perf_counter()
        with py7zr.SevenZipFile(arch, "w", filters=[{"id": py7zr.FILTER_COPY}]) as z:
            z.writeall(src)
        shutil.rmtree(src, ignore_errors=True)
        res["a"] = {"members": args.small + decoys, "kept": args.small,
                    "archive_bytes": os.path.getsize(arch),
                    "pack_s": round(time.perf_counter() - t0, 1)}

        t0 = time.perf_counter()
        declared = 0
        with py7zr.SevenZipFile(arch) as z:
            for info in z.list():
                if not info.is_directory:
                    declared += 1
        res["a"]["listing_s"] = round(time.perf_counter() - t0, 2)
        res["a"]["listing_per_s"] = int(declared / max(res["a"]["listing_s"], 1e-9))

        dest = os.path.join(work, "a-dest")
        os.makedirs(dest)
        t0 = time.perf_counter()
        out = pp.read_members([arch], dest, keep=keep)
        dt = time.perf_counter() - t0
        res["a"]["extracted"] = len(out)
        res["a"]["extract_s"] = round(dt, 1)
        res["a"]["files_per_s"] = int(len(out) / dt) if dt > 0 else None
        del out
        shutil.rmtree(dest, ignore_errors=True)
        ok = res["a"]["extracted"] == res["a"]["kept"]

        # --- B: one big compressible member ------------------------------------
        big = os.path.join(work, "b-src", f"resp-7-r0001-{DAY}T11-00-00-456Z-openai-sse-glm-5.3.sse")
        os.makedirs(os.path.dirname(big))
        chunk = (b'data: {"type":"content_block_delta","delta":{"type":"text_delta",'
                 b'"text":"lorem ipsum dolor sit amet consectetur 0123456789"}}\n' * 32)
        size = args.big_mb * (1 << 20)
        with open(big, "wb") as fh:
            written = 0
            while written < size:
                fh.write(chunk)
                written += len(chunk)
        arch = os.path.join(work, "b.7z")
        t0 = time.perf_counter()
        with py7zr.SevenZipFile(arch, "w") as z:
            z.write(big, arcname=os.path.basename(big))
        os.remove(big)
        res["b"] = {"member_bytes": written, "archive_bytes": os.path.getsize(arch),
                    "pack_s": round(time.perf_counter() - t0, 1)}

        dest = os.path.join(work, "b-dest")
        os.makedirs(dest)
        t0 = time.perf_counter()
        out = pp.read_members([arch], dest, keep=keep)
        dt = time.perf_counter() - t0
        got = sum(os.path.getsize(p) for p in out)
        res["b"]["extracted"] = len(out)
        res["b"]["extract_s"] = round(dt, 2)
        res["b"]["mb_per_s"] = int(got / dt / 1e6) if dt > 0 else None
        del out
        shutil.rmtree(dest, ignore_errors=True)
        ok = ok and res["b"]["extracted"] == 1 and got == res["b"]["member_bytes"]
    finally:
        shutil.rmtree(work, ignore_errors=True)
        res["cleaned"] = not os.path.exists(work)
    res["not_measured"] = [
        "the SMB transfer of the archive itself (~0.75 GiB a day on the hub corpus)",
        "the header listing of an archive read over SMB",
        "the scan of the extracted files (traffic-consumption collect)",
        "a real day's mix of members (here: one size for A, one member for B)",
    ]
    return (0 if ok else 1), res


def main():
    ap = argparse.ArgumentParser(description="Throughput of the --from-archive read "
                                             "(read_members -> py7zr extract(targets=...)).")
    ap.add_argument("--small", type=int, default=30000, help="members of A (default 30000)")
    ap.add_argument("--big-mb", type=int, default=1024, help="size of the B member, MiB (default 1024)")
    ap.add_argument("--work-dir", default=None, help="where to build (default <repo>/.tmp)")
    ap.add_argument("--json", action="store_true", help="print the figures as one JSON document")
    args = ap.parse_args()
    if args.work_dir is None:
        args.work_dir = default_work_dir()
    outcome = measure(args)
    if isinstance(outcome, int):
        return outcome
    rc, res = outcome
    if args.json:
        print(json.dumps(res, indent=2))
        return rc
    a, b = res["a"], res["b"]
    print(f"archive-read-measure — py7zr {res['py7zr']}, python {res['python']}, "
          f"local disk {res['disk']}")
    print(f"A corpus: {a['members']} members declared ({a['kept']} of the day + "
          f"{a['members'] - a['kept']} decoys), 8 KiB each, packed stored in {a['pack_s']} s "
          f"-> {a['archive_bytes']:,} B")
    print(f"A header listing: {a['listing_s']} s for {a['members']} members "
          f"-> {a['listing_per_s']:,} members/s")
    print(f"A read_members: {a['extracted']} of {a['members']} members extracted in "
          f"{a['extract_s']} s -> {a['files_per_s']:,} files/s ({a['files_per_s'] * 60:,}/min)")
    print(f"B corpus: 1 member, {b['member_bytes']:,} B of SSE-like text, packed LZMA2 default "
          f"in {b['pack_s']} s -> {b['archive_bytes']:,} B "
          f"(x{b['member_bytes'] / max(b['archive_bytes'], 1):.1f})")
    print(f"B read_members: {b['extracted']} member, {b['member_bytes']:,} B in {b['extract_s']} s "
          f"-> {b['mb_per_s']} MB/s of output")
    for item in res["not_measured"]:
        print(f"NOT MEASURED: {item}")
    print(f"cleaned: {res['cleaned']}")
    if rc:
        print("FAILED: the extraction did not return what the header declared — "
              "the figures above do not stand", file=sys.stderr)
    return rc


if __name__ == "__main__":
    sys.exit(main())
