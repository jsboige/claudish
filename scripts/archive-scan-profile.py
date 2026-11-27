#!/usr/bin/env python
"""Where the time of the archive-mode SCAN goes — a bounded profile.

The `--from-archive` read of 2026-11-22 (24/11) took 6 025 s, of which the
scan of the extracted day 5 795 s for 129 035 members (63 915 responses): 96 %
of the read, 91 ms a response. This instrument profiles THAT scan on a
sample, never on a whole day:

  python scripts/archive-scan-profile.py --archive <captures-DAY.7z> --day DAY --hours 3
  python scripts/archive-scan-profile.py --synthetic 400 --json     # reads no capture

Sample: the day's members whose NAME carries one of --hours (UTC), first
--max-members of each kind (req / resp) in archive order. Extracted LOCALLY
by the reader's own `lib/partial_parts.read_members` into a directory the run
ALLOCATES (`tempfile.mkdtemp` under the extraction root, removed on every
path, failed extraction included — nothing that was there before is touched),
then three phases:

  first open   every extracted file is opened for the FIRST time — the even
               ranks serially (what the scan pays today), the odd ranks by a
               pool of --pool threads. Measured 24/11 on this seat, synthetic
               files: the scan spends 23 ms a member with 4 % of its own CPU
               in it (it waits), and 400 first opens took 3.77 s serially
               against 0.44 s by a pool of 8
  plain        the reader's own `collect`, wall + CPU clocks (no second copy
               of the reading rules)
  cProfile     `collect` again -> WHERE its own time goes: top 5 functions by
               cumulative time, with share

`process_time` is this process's own CPU; wall minus CPU is waiting.

The scan rates are the SAMPLE's, and the document says so in a field a program
can read: `extrapolation.day_estimable` is False and names the sizes it was
measured on, and each `scan_plain` / `scan_profiled` block carries its
`measured_on`. Scaled to a day they price it ~62x low (#1215: 1.2 ms a response
here on 26/11, 124.3 ms a response on the day itself) — a few thousand files
stay in the operating system's cache where 135 054 do not. A day's scan is READ
(`archive.seconds.scan`), never derived from this document.

The series file is never touched (nothing is written to the persistent
series). No `python -I`: py7zr lives in the user site on the seats.

Exit 0 measured · 1 the extraction did not return what the selection declared
· 2 refused before any extraction (the figures fall, not the tool).
"""

import argparse
import cProfile
import importlib.util
import json
import os
import platform
import pstats
import re
import shutil
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
SYNTHETIC_DAY = "2026-11-02"
GIB = 1 << 30
NAME_RX = r"^(?:req|resp)-.*?(\d{4}-\d{2}-\d{2})T(\d{2})-\d{2}-\d{2}"
DAY_RX = re.compile(NAME_RX)


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_HERE, relpath))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def default_work_dir():
    repo = os.path.join(_HERE, "..", ".tmp")
    return os.path.abspath(repo) if os.path.isdir(repo) else tempfile.gettempdir()


def build_synthetic(work, n, day):
    """n synthetic request/response pairs of hour 03, packed as a day archive
    of one solid LZMA2 block — the SHAPE the reader meets: a request body
    larger than the head it reads, responses of two sizes (7 in 10 above the
    head+tail the reader keeps, 3 in 10 short). -> the archive path."""
    import py7zr

    src = os.path.join(work, "src")
    os.makedirs(src)
    text = ('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta",'
            '"text":"lorem ipsum dolor sit amet 0123456789"}}\n\n')
    tool = ('data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta",'
            '"partial_json":"lorem ipsum dolor sit amet 0123456789"}}\n\n')
    start = ('data: {"type":"message_start","message":{"usage":{"input_tokens":10,'
             '"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0}}}\n\n')
    end = ('data: {"type":"message_delta","usage":{"input_tokens":67,"cache_read_input_tokens":'
           '244800,"cache_creation_input_tokens":100,"output_tokens":123}}\n\n'
           'data: {"type":"message_stop"}\n\n')
    for i in range(n):
        pid, reqn = 1 + i % 8, i + 1
        # The response is stamped 7 s AFTER its request: the reader pairs on
        # « request <= response » over strings that carry different suffixes.
        stamp = f"{day}T03-{i // 60 % 60:02d}-00-{i % 1000:03d}Z"
        close = f"{day}T03-{i // 60 % 60:02d}-07-{i % 1000:03d}Z"
        payload = {"ts": stamp, "src": "direct", "machine": f"myia-po-202{3 + i % 3}",
                   "model": "glm-5.3", "workspace": "w", "lane": "claude-code", "pid": pid,
                   "instanceId": "synthetic", "entrypoint": "cli", "workload": "cron", "hops": [],
                   "body": {"model": "glm-5.3",
                            "messages": [{"role": "user", "content": "x" * 280_000}]}}
        with open(os.path.join(src, f"req-{pid}-{reqn:04d}-{stamp}-direct.json"), "w") as fh:
            fh.write(json.dumps(payload))
        frames = 2_600 if i % 10 < 7 else 180
        sse = start + (text + tool) * (frames // 2) + end
        head = (f"# claudish response capture\n# parser=openai-sse model=glm-5.3 reqN={reqn} pid={pid}\n"
                f"# instance=synthetic\n# elapsed_ms=1000 events~={frames}\n# notes=+1000ms message_stop\n"
                f"# {'=' * 60}\n\n")
        name = f"resp-{pid}-r{reqn:04d}-{close}-openai-sse-glm-5.3.sse"
        with open(os.path.join(src, name), "w") as fh:
            fh.write(head + sse)
    arch = os.path.join(work, "archive", f"captures-{day}.7z")
    os.makedirs(os.path.dirname(arch))
    # FLAT members, one by one: `writeall(src)` would keep the source folder as
    # an internal prefix, and a day archive has none (compress-captures.ps1).
    with py7zr.SevenZipFile(arch, "w", filters=[{"id": py7zr.FILTER_LZMA2, "preset": 0}]) as z:
        for fn in sorted(os.listdir(src)):
            z.write(os.path.join(src, fn), arcname=fn)
    shutil.rmtree(src, ignore_errors=True)
    return arch


def select(paths, day, hours, per_kind):
    """HEADER LISTING only: the first `per_kind` kept names of each kind, in
    archive order. -> (keep, members, declared bytes, {req, resp})."""
    import py7zr

    rx = DAY_RX
    picked = {"req": set(), "resp": set()}
    total = 0
    for path in paths:
        with py7zr.SevenZipFile(path) as z:
            for info in z.list():
                base = os.path.basename(info.filename)
                m = rx.match(base)
                if info.is_directory or not m or m.group(1) != day or m.group(2) not in hours:
                    continue
                kind = "req" if base.startswith("req-") else "resp"
                if len(picked[kind]) >= per_kind:
                    continue
                picked[kind].add(base)
                total += info.uncompressed
    sel = picked["req"] | picked["resp"]
    return (lambda base: base in sel), len(sel), total, {k: len(v) for k, v in picked.items()}


def first_open(files, workers):
    """Open every file for the FIRST time (the bytes the reader keeps): even
    ranks serially, odd ranks by `workers` threads. -> {serial, pooled}.

    `off_caller` is the structural mark of a half: True when at least one of
    its reads ran on a thread other than the caller's. A pool that was never
    entered reads False here, whatever the timings say."""
    caller = threading.get_ident()
    seen = set()

    def touch(path):
        seen.add(threading.get_ident())
        with open(path, "rb") as fh:
            return len(fh.read(300_000))

    out = {}
    for label, paths in (("serial", files[0::2]), ("pooled", files[1::2])):
        w0, c0 = time.perf_counter(), time.process_time()
        seen.clear()
        if label == "serial" or workers <= 1:
            sum(touch(p) for p in paths)
        else:
            with ThreadPoolExecutor(workers) as ex:
                sum(ex.map(touch, paths))
        wall = time.perf_counter() - w0
        out[label] = {"files": len(paths), "wall_s": round(wall, 2),
                      "cpu_s": round(time.process_time() - c0, 2),
                      "ms_per_file": round(1000.0 * wall / len(paths), 2) if paths else None,
                      "off_caller": any(t != caller for t in seen)}
    a, b = out["serial"]["ms_per_file"], out["pooled"]["ms_per_file"]
    out["speedup"] = round(a / b, 1) if a and b and workers > 1 else None
    return out


def clocked(fn, *a, **k):
    w0, c0 = time.perf_counter(), time.process_time()
    out = fn(*a, **k)
    return out, time.perf_counter() - w0, time.process_time() - c0


def top(stats, index, n=5):
    """index 3 = cumulative time, 2 = own time (pstats: (cc, nc, tt, ct))."""
    total = stats.total_tt
    rows = sorted(((v[index], v[1], k) for k, v in stats.stats.items()), reverse=True)[:n]
    return [{"function": f"{os.path.basename(k[0])}:{k[1]}({k[2]})",
             "calls": nc, "seconds": round(t, 2),
             "share": round(100.0 * t / total, 1) if total else None}
            for t, nc, k in rows]


def profile(args):
    try:
        import py7zr
    except ImportError as exc:
        print(f"REFUSED: py7zr is not importable here ({exc}) - do not run this "
              f"under python -I", file=sys.stderr)
        return 2
    pp = _load("pp", os.path.join("lib", "partial_parts.py"))
    tc = _load("tc", "traffic-consumption.py")
    if args.synthetic is not None and args.synthetic < 1:
        print("REFUSED: --synthetic needs at least 1 pair", file=sys.stderr)
        return 2
    if args.synthetic is None and not (args.archive and args.day):
        print("REFUSED: --archive <day.7z> and --day are required (or --synthetic N)",
              file=sys.stderr)
        return 2
    args.day = args.day or SYNTHETIC_DAY
    built = None
    if args.synthetic is not None:
        built = tempfile.mkdtemp(prefix="archive-scan-profile-src-", dir=args.work_dir)
    try:
        # The synthetic corpus never outlives the run, whatever the outcome.
        return _measure(args, tc, pp, py7zr, built)
    finally:
        if built is not None:
            shutil.rmtree(built, ignore_errors=True)


def _measure(args, tc, pp, py7zr, built):
    if built is not None:
        args.archive = [build_synthetic(built, args.synthetic, args.day)]
    hours = {h.strip().zfill(2) for h in args.hours.split(",") if h.strip()}
    try:
        keep, n_sel, need, kinds = select(args.archive, args.day, hours, args.max_members)
    except Exception as exc:  # noqa: BLE001 — the archive is NAMED, never re-raised
        print(f"REFUSED: archive unreadable ({', '.join(os.path.basename(p) for p in args.archive)}): "
              f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    if not n_sel or not kinds["resp"]:
        print(f"REFUSED: no member of {args.day} hours {','.join(sorted(hours))} under the cap - "
              f"nothing to profile", file=sys.stderr)
        return 2

    root = args.extract_root or tc.default_extract_root()
    try:
        os.makedirs(root, exist_ok=True)
        free = shutil.disk_usage(root).free
    except OSError as exc:
        print(f"REFUSED: extract root {root} - {exc}", file=sys.stderr)
        return 2
    if free < need + GIB:
        print(f"REFUSED: {free} B free under {root}, needs {need + GIB} B (lower --max-members "
              f"or pass --extract-root)", file=sys.stderr)
        return 2

    # ALLOCATED, never derived (review ai-01, 25/11): a name built from the day
    # and the PID is a name an interrupted run may have left behind (a PID is
    # recycled), and the finally below removes the directory THIS run owns —
    # nothing else. mkdtemp creates it fresh and exclusively, so a pre-existing
    # neighbour is never mistaken for ours, not even when the extraction fails.
    try:
        dest = tempfile.mkdtemp(prefix=f"scan-profile-{args.day}-", dir=root)
    except OSError as exc:
        print(f"REFUSED: no extraction directory could be created under {root} - {exc}",
              file=sys.stderr)
        return 2
    res = {"mode": "synthetic" if built else "archive", "day": args.day,
           "hours": sorted(hours), "python": platform.python_version(),
           "py7zr": getattr(py7zr, "__version__", "?"), "disk": root,
           "archives": [[os.path.basename(p), os.path.getsize(p)] for p in args.archive],
           "selected": {"members": n_sel, "declared_bytes": need, **kinds}}
    d0 = datetime.strptime(args.day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    try:
        t0 = time.perf_counter()
        out = pp.read_members(args.archive, dest, keep=keep)
        res["extract_s"] = round(time.perf_counter() - t0, 1)
        res["extracted"] = len(out)
        del out
        if res["extracted"] != n_sel:
            return 1, res

        files = sorted(os.path.join(dp, fn) for dp, _, fns in os.walk(dest) for fn in fns)
        res["first_open"] = first_open(files, args.pool)

        r1, wall1, cpu1 = clocked(tc.collect, [dest], d0, until_dt=d0 + timedelta(days=1),
                                 per_day=True)
        prof = cProfile.Profile()
        r2, wall2, cpu2 = clocked(prof.runcall, tc.collect, [dest],
                                  d0, until_dt=d0 + timedelta(days=1), per_day=True)
    except Exception as exc:  # noqa: BLE001 — a failed read, not a profile
        print(f"REFUSED: the sample could not be read ({type(exc).__name__}: {exc})",
              file=sys.stderr)
        return 2, res
    finally:
        # `cleaned` is about the EXTRACTION dir — the one mkdtemp created for
        # this run, so nothing that was there before is removed; the synthetic
        # source is the caller's (profile), removed on every path.
        shutil.rmtree(dest, ignore_errors=True)
        res["cleaned"] = not os.path.exists(dest)

    n_resp, n_req = r1["files"]["resp"], r1["requests"]["total"]
    if not n_resp:
        print("REFUSED: the sample holds no readable response - nothing to profile",
              file=sys.stderr)
        return 2, res
    members = n_resp + n_req
    for name, wall, cpu in (("scan_plain", wall1, cpu1), ("scan_profiled", wall2, cpu2)):
        res[name] = {"wall_s": round(wall, 2), "cpu_s": round(cpu, 2),
                     "cpu_share": round(100.0 * cpu / wall, 1) if wall else None,
                     "ms_per_resp": round(1000.0 * wall / n_resp, 1),
                     "ms_per_member": round(1000.0 * wall / members, 1) if members else None,
                     # The size each rate above was measured on (#1215): a rate
                     # read without its sample is a day figure waiting to happen.
                     "measured_on": {"resp": n_resp, "members": members}}
    res["sample"] = {"resp": n_resp, "req": n_req, "paired": r1["files"]["paired"],
                     "unanswered": r1["requests"]["unanswered"]}
    # #1215: every rate of this document is the SAMPLE's. A consumer scaled the
    # plain pass's 1.2 ms a response to a day and priced a read at 124 s; the
    # day's scan cost 7 752 s (124.3 ms a response). `not_measured` said so in
    # prose and was not enough, so the refusal is a field a program can read.
    # A day's scan is READ (`archive.seconds.scan` of the series), never
    # derived from here: no input of this tool makes `day_estimable` true.
    res["extrapolation"] = {
        "day_estimable": False,
        "measured_on": {"day": args.day, "hours": sorted(hours),
                        "resp": n_resp, "req": n_req, "members": members},
        "why": "a few hours of one day, each file opened once before the timed pass; "
               "the rates hold for this sample and price nothing larger",
    }
    st = pstats.Stats(prof)
    res["top_cumulative"] = top(st, 3)
    res["top_own_time"] = top(st, 2)
    res["not_measured"] = [
        "the scan of a whole day (a sample is extrapolated, a day is read)",
        "the loose residual of the day and the series write",
        "the antivirus engine's own CPU (only this process's clocks are read)",
    ]
    return 0, res


def main():
    ap = argparse.ArgumentParser(description="Bounded cProfile of the --from-archive scan.")
    ap.add_argument("--archive", action="append", help="a day archive or part (repeatable)")
    ap.add_argument("--day", help="the day, YYYY-MM-DD (default with --synthetic: " + SYNTHETIC_DAY + ")")
    ap.add_argument("--hours", default="3", help="UTC hours of the day kept, comma-separated (default 3)")
    ap.add_argument("--max-members", type=int, default=4000, help="cap per kind, req and resp (default 4000)")
    ap.add_argument("--pool", type=int, default=8, help="threads of the pooled first open (1 = serial twice)")
    ap.add_argument("--synthetic", type=int, metavar="N", help="dry-run: N synthetic pairs, no capture read")
    ap.add_argument("--extract-root", default=None, help="where to extract (default: the reader's)")
    ap.add_argument("--work-dir", default=None, help="where --synthetic builds (default <repo>/.tmp)")
    ap.add_argument("--json", action="store_true", help="print the figures as one JSON document")
    args = ap.parse_args()
    if args.work_dir is None:
        args.work_dir = default_work_dir()
    outcome = profile(args)
    if isinstance(outcome, int):
        return outcome
    rc, res = outcome
    if args.json:
        print(json.dumps(res, indent=2))
        return rc
    if rc:
        print(f"FAILED: rc={rc} - the figures do not stand "
              f"(selected {res.get('selected', {}).get('members')}, "
              f"extracted {res.get('extracted')})", file=sys.stderr)
        return rc
    s, p, q = res["selected"], res["scan_plain"], res["scan_profiled"]
    print(f"archive-scan-profile - {res['mode']}, python {res['python']}, py7zr {res['py7zr']}, "
          f"disk {res['disk']}")
    print(f"sample: day {res['day']} hours {','.join(res['hours'])} - {s['resp']} resp + {s['req']} req "
          f"selected ({s['declared_bytes']:,} B declared) from "
          f"{', '.join(n for n, _ in res['archives'])}, extracted in {res['extract_s']} s")
    print(f"read: {res['sample']['resp']} resp, {res['sample']['req']} req, "
          f"{res['sample']['unanswered']} req without a response")
    f = res["first_open"]
    print(f"first open of each extracted file: serial {f['serial']['files']} files "
          f"{f['serial']['wall_s']:.1f} s -> {f['serial']['ms_per_file']} ms a file "
          f"({f['serial']['cpu_s']} s CPU) | pool of {args.pool}: {f['pooled']['files']} files "
          f"{f['pooled']['wall_s']:.1f} s -> {f['pooled']['ms_per_file']} ms a file"
          + (f" (x{f['speedup']})" if f.get("speedup") else "")
          + f" | the pooled half read off the caller's thread: {f['pooled'].get('off_caller')}")
    print(f"scan, plain pass (files already opened once): {p['wall_s']:.1f} s wall, "
          f"{p['cpu_s']:.1f} s CPU ({p['cpu_share']} %) -> {p['ms_per_resp']} ms a response, "
          f"{p['ms_per_member']} ms a member")
    print(f"scan, cProfile pass: {q['wall_s']:.1f} s wall, {q['cpu_s']:.1f} s CPU "
          f"-> {q['ms_per_resp']} ms a response")
    x = res["extrapolation"]["measured_on"]
    print(f"extrapolation: the scan rates above were measured on {x['resp']} responses and "
          f"{x['members']} members ({','.join(res['hours'])}h of {res['day']}) - "
          f"day_estimable is False, they do not price a day; a day is read")
    print("top 5 by cumulative time (share of the profiled scan):")
    for i, row in enumerate(res["top_cumulative"], 1):
        print(f"  {i}. {row['share']} %  {row['function']}  {row['calls']:,} calls, {row['seconds']} s")
    print("top 5 by own time:")
    for i, row in enumerate(res["top_own_time"], 1):
        print(f"  {i}. {row['share']} %  {row['function']}  {row['calls']:,} calls, {row['seconds']} s")
    for item in res["not_measured"]:
        print(f"NOT MEASURED: {item}")
    print(f"cleaned: {res['cleaned']}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
