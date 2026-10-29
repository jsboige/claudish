#!/usr/bin/env python3
"""Attribute the hub-reported INPUT volume by machine and by lane/model.

#445(a) — "which seat carries the uncached volume". The pilot (#445) measured
the volume but not its owner: the 7-day series said how many tokens were read
without a cache hit, not WHO read them.

WHAT THIS COUNTS
----------------
`input_tokens` as the PROVIDER reported it. On the Anthropic wire that counter
is the uncached part (cache_read_input_tokens is separate). On the OpenAI wire
from vLLM (swift) the engine emits NO cache_read counter, so its input_tokens
are an UPPER bound of the uncached volume — the engine-side prefix hits are
measured separately (ai-01's prefix-cache counters), never here. Reading this
number as "engine misses" is the error corrected in #445 (c.6493899962).

PAIRING
-------
Restart-aware, the same rule turn-autopsy.py uses: captures are keyed by
request counter, which RESTARTS with every container life, so a resp is
attributed to the LATEST req of its counter whose timestamp precedes it,
within a 20-minute window. A request with no matching response is counted as
unpaired and excluded from the totals (it is reported, never silently
dropped).

READS
-----
The envelope is read HEAD-only (machine + model live in the first bytes — the
leak-policy window) and the response is read TAIL-only (usage rides the
terminal message_delta). A full-day corpus is 33 GB; this instrument reads
about 4 KB per request capture and 256 KB per response capture.

Usage
-----
    python -I scripts/uncached-attribution.py --dir D:\\claudish-captures
    python -I scripts/uncached-attribution.py --archive captures-2026-10-28.7z
    python -I scripts/uncached-attribution.py --dir <d> --json out.json

Exit codes: 0 = measured, 1 = no corpus found, 2 = docker/archive unreadable.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone

TS = r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z"
REQ_RE = re.compile(rf"^req-\d+-(\d+)-({TS})-(.+)\.json$")
RESP_RE = re.compile(rf"^resp-\d+-r(\d+)-({TS})-(.+)\.sse$")
MACHINE_RE = re.compile(rb'"machine":\s*"([^"]*)"')
MODEL_RE = re.compile(rb'"model":\s*"([^"]*)"')

PAIR_WINDOW_MS = 20 * 60 * 1000
TAIL_BYTES = 262_144
HEAD_BYTES = 4_096

SEVENZIP = os.environ.get(
    "SEVENZIP", r"D:\PortableApps\PortableApps\7-ZipPortable\App\7-Zip\7z.exe"
)
DEFAULT_WORKDIR = os.environ.get("CLAUDISH_UNCACHED_WORKDIR", r"D:\claudish-uncached")


def ts_ms(ts: str) -> int:
    """Filename timestamp -> epoch ms (real calendar arithmetic)."""
    return int(
        datetime.strptime(ts, "%Y-%m-%dT%H-%M-%S-%fZ")
        .replace(tzinfo=timezone.utc)
        .timestamp()
        * 1000
    )


def req_meta(path: str) -> tuple[str, str]:
    """(machine, model) from the capture HEAD only."""
    with open(path, "rb") as fh:
        head = fh.read(HEAD_BYTES)
    m = MACHINE_RE.search(head)
    mm = MODEL_RE.search(head)
    return (
        m.group(1).decode("utf-8", "replace") if m else "?",
        mm.group(1).decode("utf-8", "replace") if mm else "?",
    )


def resp_usage(path: str):
    """Terminal message_delta usage of a response capture, or None."""
    usage = {}
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - TAIL_BYTES))
            for raw in fh:
                if b"message_delta" not in raw:
                    continue
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload == "[DONE]":
                    continue
                try:
                    ev = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "message_delta":
                    u = ev.get("usage") or {}
                    if u:
                        usage = u
    except OSError:
        return None
    if not usage:
        return None
    return (
        usage.get("input_tokens"),
        usage.get("cache_read_input_tokens") or 0,
        usage.get("output_tokens") or 0,
    )


def index_corpus(directory: str):
    """-> (reqs, meta, resps) with reqs/resps keyed by request counter."""
    reqs: dict[int, list[tuple[int, str]]] = defaultdict(list)
    resps: dict[int, list[tuple[int, str, str, str]]] = defaultdict(list)
    meta: dict[str, tuple[str, str]] = {}
    for name in os.listdir(directory):
        m = REQ_RE.match(name)
        if m:
            try:
                meta[name] = req_meta(os.path.join(directory, name))
            except OSError:
                continue
            reqs[int(m.group(1))].append((ts_ms(m.group(2)), name))
            continue
        m = RESP_RE.match(name)
        if m:
            handler, _, model = m.group(3).partition("-")
            resps[int(m.group(1))].append(
                (ts_ms(m.group(2)), name, handler, model)
            )
    return reqs, meta, resps


def attribute(reqs, meta, resps, directory: str):
    """-> (by_machine, by_lane, counters) with counters = {req, resp, unpaired,
    paired, blank_machine, total_input, total_cache_read}."""
    by_machine: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    by_lane: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    counters = {
        "req": sum(len(v) for v in reqs.values()),
        "resp": sum(len(v) for v in resps.values()),
        "unpaired": 0,
        "paired": 0,
        "blank_machine": 0,
        "total_input": 0,
        "total_cache_read": 0,
    }
    for counter, rlist in reqs.items():
        rlist.sort()
        slist = sorted(resps.get(counter) or [])
        claims: dict[int, list] = defaultdict(list)
        for sp in slist:
            t1 = sp[0]
            owner = -1
            for ri, rq in enumerate(rlist):
                if rq[0] > t1:
                    break
                if t1 - rq[0] <= PAIR_WINDOW_MS:
                    owner = ri
            if owner >= 0:
                claims[owner].append(sp)
        for ri, rq in enumerate(rlist):
            machine, _model = meta.get(rq[1], ("?", "?"))
            got = claims.get(ri)
            if not got:
                counters["unpaired"] += 1
                continue
            sp = got[-1]  # the serving attempt is the LAST claim
            u = resp_usage(os.path.join(directory, sp[1]))
            if not u or u[0] is None:
                counters["unpaired"] += 1
                continue
            inp, cread, outp = u
            counters["paired"] += 1
            if not machine:
                counters["blank_machine"] += 1
            a = by_machine[machine or "(no machine header)"]
            a[0] += 1
            a[1] += inp
            a[2] += cread
            a[3] += outp
            la = by_lane[(sp[2], sp[3])]
            la[0] += 1
            la[1] += inp
            la[2] += cread
            la[3] += outp
            counters["total_input"] += inp
            counters["total_cache_read"] += cread
    return by_machine, by_lane, counters


def extract_archive(archive: str, workdir: str) -> str:
    """Extract an archive into workdir (7-Zip). Returns the target dir."""
    target = os.path.join(workdir, os.path.splitext(os.path.basename(archive))[0])
    os.makedirs(target, exist_ok=True)
    subprocess.run(
        [SEVENZIP, "x", "-y", f"-o{target}", archive],
        check=False,
        capture_output=True,
    )
    return target


def render(by_machine, by_lane, counters, top: int = 12) -> str:
    out = []
    total = counters["total_input"] or 1
    out.append(
        f"req-files={counters['req']} resp-files={counters['resp']} "
        f"paired={counters['paired']} unpaired={counters['unpaired']} "
        f"blank-machine={counters['blank_machine']}"
    )
    out.append(
        f"total reported input_tokens = {counters['total_input']:,}  "
        f"cache_read = {counters['total_cache_read']:,}"
    )
    out.append("")
    out.append("== by machine (turns / input_tokens / cache_read / output) ==")
    for k in sorted(by_machine, key=lambda k: -by_machine[k][1]):
        a = by_machine[k]
        out.append(
            f"{k:<24} {a[0]:>8,}  {a[1]:>15,}  {a[2]:>15,}  {a[3]:>13,}  "
            f"in-share={100.0 * a[1] / total:5.1f}%"
        )
    out.append("")
    out.append(f"== by lane/model (top {top} by input_tokens) ==")
    for k in sorted(by_lane, key=lambda k: -by_lane[k][1])[:top]:
        a = by_lane[k]
        out.append(
            f"{k[0]}/{k[1]:<40} {a[0]:>8,}  {a[1]:>15,}  {a[2]:>15,}  "
            f"in-share={100.0 * a[1] / total:5.1f}%"
        )
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", help="directory of extracted captures")
    ap.add_argument("--archive", help="a captures-*.7z to extract first")
    ap.add_argument("--workdir", default=DEFAULT_WORKDIR)
    ap.add_argument("--json", help="also write the raw aggregates here")
    ap.add_argument("--top", type=int, default=12)
    args = ap.parse_args(argv)

    directory = args.dir
    if not directory and args.archive:
        if not os.path.exists(args.archive):
            print(f"archive not found: {args.archive}", file=sys.stderr)
            return 2
        directory = extract_archive(args.archive, args.workdir)
    if not directory or not os.path.isdir(directory):
        print("need --dir <capture dir> or --archive <7z>", file=sys.stderr)
        return 1

    reqs, meta, resps = index_corpus(directory)
    if not reqs:
        print(f"no req-* captures in {directory}", file=sys.stderr)
        return 1
    by_machine, by_lane, counters = attribute(reqs, meta, resps, directory)
    print(render(by_machine, by_lane, counters, args.top))
    if args.json:
        payload = {
            "counters": counters,
            "by_machine": {k: v for k, v in by_machine.items()},
            "by_lane": {f"{k[0]}/{k[1]}": v for k, v in by_lane.items()},
        }
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
