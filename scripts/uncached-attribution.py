#!/usr/bin/env python3
"""Attribute the hub-reported INPUT volume by machine and by lane/model.

#445(a) — "which seat carries the uncached volume". The pilot (#445) measured
the volume but not its owner: the 7-day series said how many tokens were read
without a cache hit, not WHO read them.

WHAT THIS COUNTS
----------------
Three usage counters ride the terminal `message_delta` on the Anthropic wire,
and they are DISJOINT parts of one prompt:

    input_tokens                  the cold part — read, not cached, not written
    cache_creation_input_tokens   written to the cache on this turn
    cache_read_input_tokens       served from the cache on this turn

`input_tokens` ALONE is therefore not the uncached volume: it silently drops
every cache WRITE. This instrument reports the three counters separately and
defines its denominator explicitly:

    uncached = input_tokens + cache_creation_input_tokens
    prompt   = input_tokens + cache_creation_input_tokens + cache_read_input_tokens

Shares are computed on `uncached`. On the OpenAI wire from vLLM (swift) the
engine emits NO cache_read and NO cache_creation counter, so its whole
`input_tokens` counts as uncached — an UPPER bound, not engine misses. The
engine-side prefix hits are measured separately (ai-01's prefix counters),
never here; reading this number as "engine misses" is the error corrected in
#445 (c.6493899962).

PAIRING
-------
Restart-aware, the same rule turn-autopsy.py uses: captures are keyed by
request counter, which RESTARTS with every container life, so a resp is
attributed to the LATEST req of its counter whose timestamp precedes it,
within a 20-minute window. A cascade writes one response per upstream attempt
and the LAST one serves the client, so only that one is credited.

COVERAGE — nothing is silently dropped
--------------------------------------
Every capture file lands in exactly one bucket, and the buckets reconcile with
the corpus (the renderer prints the identities, it does not assert them):

    req  files = paired + usage_unusable + unpaired
    resp files = claimed + orphan_resp

    unpaired         a request no response capture claims (refused turns)
    orphan_resp      a response no request claims
    usage_unusable   claimed, but the response carries no usable usage block
    unreadable_req   the request envelope could not be opened at all; still
                     paired and counted, under "(unreadable request)"
    blank_machine    readable, but no `machine` header — external callers

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

The extractor is resolved per run: `$SEVENZIP`, then `7z`/`7zr` on PATH, then
one seat's portable install. An absent or failing extractor raises — it never
presents as an empty corpus (measured 2026-10-29: the hardcoded path is
po-2028's, po-2024 has only `7zr` from winget).

Exit codes: 0 = measured, 1 = no corpus found, 2 = archive unreadable,
3 = extraction refused by the pre-flight (nothing was written).

EXTRACTION PRE-FLIGHT (the 29/10 disk incident)
------------------------------------------------
`--archive` extracts the corpus to disk, and a capture corpus expands ~84x
(0,36 Go compressed -> 31 Go extracted on captures-2026-10-28.7z). An
extraction launched without that knowledge drained D: at ~150 Go/h until the
fleet wall (Maintenance, [URGENT][DISK] 29/10 20:32Z). The tool therefore
reads the archive INDEX first (`7z l -slt`, no extraction) and refuses when
the target volume would fall below its floor — 12 % of the volume and at
least 20 Go, whichever is bigger. The remedy is in the message: another
`--workdir`, or `--force-extract` to override deliberately.
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

UNREADABLE = "(unreadable request)"
NO_MACHINE = "(no machine header)"

#: Last-resort path: the portable install one seat happens to carry. It is a
#: FALLBACK, never the answer — measured 2026-10-29 on po-2024, this path does
#: not exist there while `7zr.exe` does (winget). A hardcoded seat path is how
#: "archive unreadable" used to look like "empty corpus".
DEFAULT_SEVENZIP = r"D:\PortableApps\PortableApps\7-ZipPortable\App\7-Zip\7z.exe"
DEFAULT_WORKDIR = os.environ.get("CLAUDISH_UNCACHED_WORKDIR", r"D:\claudish-uncached")
# Volume floor for an extraction (the 29/10 disk incident: an extraction with
# no size knowledge drained D: at ~150 Go/h until Maintenance's wall).
DEFAULT_MIN_FREE_PCT = 12.0
DEFAULT_MIN_FREE_BYTES = 20 * 1024 ** 3


def find_extractor() -> str | None:
    """Resolve a 7-Zip CLI: $SEVENZIP, then PATH (`7z`, `7zr`), then the fallback.

    Read per call, never cached at import: the operator may export SEVENZIP
    between two runs of the same process' ancestor, and the test pins the
    no-extractor branch by patching this function.
    """
    for cand in (
        os.environ.get("SEVENZIP"),
        shutil.which("7z"),
        shutil.which("7zr"),
        DEFAULT_SEVENZIP,
    ):
        if cand and os.path.exists(cand):
            return cand
    return None


class ArchiveError(RuntimeError):
    """The archive could not be read — never allowed to look like an empty corpus."""


class PreflightError(RuntimeError):
    """The extraction was refused before it started (volume floor)."""


def ts_ms(ts: str) -> int:
    """Filename timestamp -> epoch ms (real calendar arithmetic)."""
    return int(
        datetime.strptime(ts, "%Y-%m-%dT%H-%M-%S-%fZ")
        .replace(tzinfo=timezone.utc)
        .timestamp()
        * 1000
    )


def req_meta(path: str) -> tuple[str, str, bool]:
    """(machine, model, readable) from the capture HEAD only."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(HEAD_BYTES)
    except OSError:
        return "", "", False
    m = MACHINE_RE.search(head)
    mm = MODEL_RE.search(head)
    return (
        m.group(1).decode("utf-8", "replace") if m else "",
        mm.group(1).decode("utf-8", "replace") if mm else "?",
        True,
    )


def _merge_usage(acc: dict, u: dict) -> None:
    """Merge one usage block into the accumulator, ignoring explicit nulls.

    A terminal `message_delta` usually carries ONLY `output_tokens`; assigning
    the block wholesale would erase the input counters a previous event
    reported. Every key present with a non-null value wins (later events win
    for the counters they carry). `cache_creation` arriving as the nested
    {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens} form is summed into
    the flat counter when the flat one is absent.
    """
    for k, v in u.items():
        if v is None or k == "cache_creation":
            continue
        acc[k] = v
    nested = u.get("cache_creation")
    if isinstance(nested, dict) and acc.get("cache_creation_input_tokens") is None:
        total = sum(v for v in nested.values() if isinstance(v, int))
        if total:
            acc["cache_creation_input_tokens"] = total


def resp_usage(path: str) -> tuple[dict | None, str]:
    """Terminal usage of a response capture -> (usage|None, status).

    status: "ok" | "no-usage" (no usage block in the window) | "unreadable".
    """
    usage: dict = {}
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - TAIL_BYTES))
            for raw in fh:
                if b"usage" not in raw:
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
                if not isinstance(ev, dict):
                    continue
                # Terminal delta on the Anthropic wire; message_start carries
                # the same counters inside `message.usage` on some dialects.
                if ev.get("type") == "message_delta":
                    u = ev.get("usage") or {}
                elif ev.get("type") == "message_start":
                    u = (ev.get("message") or {}).get("usage") or {}
                else:
                    continue
                if isinstance(u, dict):
                    _merge_usage(usage, u)
    except OSError:
        return None, "unreadable"
    if not usage or usage.get("input_tokens") is None:
        return None, "no-usage"
    return usage, "ok"


def index_corpus(directory: str):
    """-> (reqs, meta, resps, files) with reqs/resps keyed by request counter."""
    reqs: dict[int, list[tuple[int, str]]] = defaultdict(list)
    resps: dict[int, list[tuple[int, str, str, str]]] = defaultdict(list)
    meta: dict[str, tuple[str, str, bool]] = {}
    files = {"req": 0, "resp": 0, "unreadable_req": 0}
    for name in os.listdir(directory):
        m = REQ_RE.match(name)
        if m:
            info = req_meta(os.path.join(directory, name))
            meta[name] = info
            files["req"] += 1
            if not info[2]:
                files["unreadable_req"] += 1
            # An unreadable envelope still names a request: keep it in the
            # corpus so its volume is reported, not silently dropped.
            reqs[int(m.group(1))].append((ts_ms(m.group(2)), name))
            continue
        m = RESP_RE.match(name)
        if m:
            handler, _, model = m.group(3).partition("-")
            resps[int(m.group(1))].append(
                (ts_ms(m.group(2)), name, handler, model)
            )
            files["resp"] += 1
    return reqs, meta, resps, files


def attribute(reqs, meta, resps, directory: str):
    """-> (by_machine, by_lane, counters).

    Row layout: [turns, cold_input, cache_creation, cache_read, output].
    Counters reconcile with the corpus: req = paired + usage_unusable +
    unpaired, resp = claimed + orphan_resp.
    """
    by_machine: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0, 0])
    by_lane: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0, 0, 0, 0])
    counters = {
        "req": sum(len(v) for v in reqs.values()),
        "resp": sum(len(v) for v in resps.values()),
        "unreadable_req": 0,
        "paired": 0,
        "unpaired": 0,
        "usage_unusable": 0,
        "orphan_resp": 0,
        "claimed_resp": 0,
        "blank_machine": 0,
        "total_cold": 0,
        "total_cache_creation": 0,
        "total_cache_read": 0,
        "total_output": 0,
    }
    for counter, rlist in reqs.items():
        rlist.sort()
        slist = sorted(resps.get(counter) or [])
        claims: dict[int, list] = defaultdict(list)
        claimed_here = 0
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
                claimed_here += 1
        counters["claimed_resp"] += claimed_here
        counters["orphan_resp"] += len(slist) - claimed_here

        for ri, rq in enumerate(rlist):
            machine, _model, readable = meta.get(rq[1], ("", "?", False))
            if not readable:
                counters["unreadable_req"] += 1
            got = claims.get(ri)
            if not got:
                counters["unpaired"] += 1
                continue
            sp = got[-1]  # the serving attempt is the LAST claim
            u, status = resp_usage(os.path.join(directory, sp[1]))
            if status != "ok" or not u:
                counters["usage_unusable"] += 1
                continue
            cold = int(u.get("input_tokens") or 0)
            creation = int(u.get("cache_creation_input_tokens") or 0)
            cread = int(u.get("cache_read_input_tokens") or 0)
            outp = int(u.get("output_tokens") or 0)
            counters["paired"] += 1
            if not readable:
                seat = UNREADABLE
            elif not machine:
                counters["blank_machine"] += 1
                seat = NO_MACHINE
            else:
                seat = machine
            a = by_machine[seat]
            a[0] += 1
            a[1] += cold
            a[2] += creation
            a[3] += cread
            a[4] += outp
            la = by_lane[(sp[2], sp[3])]
            la[0] += 1
            la[1] += cold
            la[2] += creation
            la[3] += cread
            la[4] += outp
            counters["total_cold"] += cold
            counters["total_cache_creation"] += creation
            counters["total_cache_read"] += cread
            counters["total_output"] += outp
    # A response whose counter has no request at all is never visited by the
    # loop above: it is still corpus, so it lands in its own bucket rather
    # than vanishing between the two file counts.
    for counter, slist in resps.items():
        if counter not in reqs:
            counters["orphan_resp"] += len(slist)
    return by_machine, by_lane, counters


def archive_uncompressed_size(extractor: str, archive: str) -> int:
    """Total UNCOMPRESSED size of an archive, from its index (`7z l -slt`).

    The compressed size is a lie for a capture corpus: `captures-2026-10-28.7z`
    is 0,36 Go compressed and 31 Go extracted (ratio ~84:1), because a resp
    capture is a full SSE stream. Reading the index is cheap (no extraction)
    and is the only way to know what an extraction will cost BEFORE it costs.
    """
    try:
        proc = subprocess.run(
            [extractor, "l", "-slt", archive], capture_output=True
        )
    except OSError as exc:
        raise ArchiveError(f"indexing failed to start: {exc}") from exc
    if proc.returncode != 0:
        tail = (
            (proc.stderr or proc.stdout or b"")
            .decode("utf-8", "replace")
            .strip()
            .splitlines()[-5:]
        )
        raise ArchiveError(
            "extractor exit "
            f"{proc.returncode} while indexing the archive: "
            f"{' | '.join(tail) or '(no output)'}"
        )
    total = 0
    for line in (proc.stdout or b"").decode("utf-8", "replace").splitlines():
        line = line.strip()
        if line.startswith("Size = "):
            try:
                total += int(line.split("=", 1)[1].strip())
            except ValueError:
                continue
    return total


def check_space(target_dir: str, total_bytes: int, min_free_pct: float,
                min_free_bytes: int) -> tuple[int, int]:
    """Refuse an extraction that would take the target volume below its floor.

    The incident of 2026-10-29 (po-2024, Maintenance [URGENT][DISK]): an
    extraction of the 28/10 corpus was launched with no size knowledge and
    drained D: at ~150 Go/h until the wall. The floor is a VOLUME floor, not
    an absolute one: 12 % of the volume (the fleet alert floor) and at least
    `min_free_bytes` (20 GiB) whichever is bigger.

    Returns (free_before, floor) when the extraction fits.
    """
    os.makedirs(target_dir, exist_ok=True)
    usage = shutil.disk_usage(target_dir)
    floor = max(int(usage.total * min_free_pct / 100.0), min_free_bytes)
    if usage.free - total_bytes < floor:
        raise PreflightError(
            f"extraction would break the floor on the target volume: "
            f"{total_bytes / (1024 ** 3):.1f} Go to extract, "
            f"{usage.free / (1024 ** 3):.1f} Go free of "
            f"{usage.total / (1024 ** 3):.1f} Go, floor "
            f"{floor / (1024 ** 3):.1f} Go "
            f"({min_free_pct:g} % / {min_free_bytes / (1024 ** 3):.0f} Go). "
            f"Use --workdir on another volume, or --force-extract to override."
        )
    return usage.free, floor


def extract_archive(archive: str, workdir: str, force: bool = False,
                    min_free_pct: float = DEFAULT_MIN_FREE_PCT,
                    min_free_bytes: int = DEFAULT_MIN_FREE_BYTES) -> str:
    """Extract an archive into workdir (7-Zip). Returns the target dir.

    Raises ArchiveError when the extractor is absent or exits non-zero: an
    unreadable archive must never be reported as an empty or partial corpus.
    Raises PreflightError when the extraction would take the target volume
    below its floor (the 29/10 disk incident); `force` overrides it.
    """
    extractor = find_extractor()
    if not extractor:
        raise ArchiveError(
            "extractor not found: set SEVENZIP to a 7-Zip CLI"
            " (tried $SEVENZIP, 7z/7zr on PATH, and " + DEFAULT_SEVENZIP + ")"
        )
    target = os.path.join(workdir, os.path.splitext(os.path.basename(archive))[0])
    os.makedirs(workdir, exist_ok=True)
    if not force:
        # The volume is measured on the WORKDIR, before the corpus directory
        # exists: a refused extraction must leave nothing behind.
        total = archive_uncompressed_size(extractor, archive)
        check_space(workdir, total, min_free_pct, min_free_bytes)
    os.makedirs(target, exist_ok=True)
    try:
        proc = subprocess.run(
            [extractor, "x", "-y", f"-o{target}", archive],
            capture_output=True,
        )
    except OSError as exc:  # not executable, permission denied, ...
        raise ArchiveError(f"extractor failed to start: {exc}") from exc
    if proc.returncode != 0:
        tail = (
            (proc.stderr or proc.stdout or b"")
            .decode("utf-8", "replace")
            .strip()
            .splitlines()[-5:]
        )
        raise ArchiveError(
            f"extractor exit {proc.returncode}: {' | '.join(tail) or '(no output)'}"
        )
    return target


def _totals(counters) -> dict:
    """Derived volumes — the denominator is defined here, once."""
    cold = counters["total_cold"]
    creation = counters["total_cache_creation"]
    read = counters["total_cache_read"]
    return {
        "uncached": cold + creation,
        "prompt": cold + creation + read,
    }


def render(by_machine, by_lane, counters, top: int = 12) -> str:
    out = []
    tot = _totals(counters)
    denom = tot["uncached"] or 1
    out.append(f"req-files={counters['req']} resp-files={counters['resp']}")
    out.append(
        f"coverage: req {counters['req']:,} = paired {counters['paired']:,}"
        f" + usage-unusable {counters['usage_unusable']:,}"
        f" + unpaired {counters['unpaired']:,}"
    )
    out.append(
        f"          resp {counters['resp']:,} = claimed"
        f" {counters['claimed_resp']:,} + orphan {counters['orphan_resp']:,}"
    )
    out.append(
        f"          unreadable request files {counters['unreadable_req']:,}"
        f" | blank-machine {counters['blank_machine']:,}"
    )
    out.append(
        f"volume: cold input_tokens = {counters['total_cold']:,}"
        f"  cache_creation = {counters['total_cache_creation']:,}"
        f"  cache_read = {counters['total_cache_read']:,}"
        f"  output = {counters['total_output']:,}"
    )
    out.append(
        f"        UNCACHED (cold + cache writes) = {tot['uncached']:,}"
        f"  |  prompt (cold + writes + reads) = {tot['prompt']:,}"
    )
    out.append("")
    out.append(
        "== by machine (turns / cold / cache_creation / cache_read / output"
        " / uncached-share) =="
    )
    for k in sorted(by_machine, key=lambda k: -(by_machine[k][1] + by_machine[k][2])):
        a = by_machine[k]
        out.append(
            f"{k:<24} {a[0]:>8,}  {a[1]:>15,}  {a[2]:>13,}  {a[3]:>15,}"
            f"  {a[4]:>13,}  {100.0 * (a[1] + a[2]) / denom:5.1f}%"
        )
    out.append("")
    out.append(f"== by lane/model (top {top} by uncached) ==")
    for k in sorted(by_lane, key=lambda k: -(by_lane[k][1] + by_lane[k][2]))[:top]:
        a = by_lane[k]
        out.append(
            f"{k[0]}/{k[1]:<40} {a[0]:>8,}  {a[1]:>15,}  {a[2]:>13,}"
            f"  {a[3]:>15,}  {a[4]:>13,}  {100.0 * (a[1] + a[2]) / denom:5.1f}%"
        )
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", help="directory of extracted captures")
    ap.add_argument("--archive", help="a captures-*.7z to extract first")
    ap.add_argument("--workdir", default=DEFAULT_WORKDIR)
    ap.add_argument("--json", help="also write the raw aggregates here")
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument(
        "--force-extract",
        action="store_true",
        help="extract even if the target volume would fall below its floor",
    )
    ap.add_argument(
        "--min-free-pct",
        type=float,
        default=DEFAULT_MIN_FREE_PCT,
        help="minimum free share of the target volume after extraction (%%)",
    )
    ap.add_argument(
        "--min-free-gb",
        type=float,
        default=DEFAULT_MIN_FREE_BYTES / (1024 ** 3),
        help="minimum free space on the target volume after extraction (Go)",
    )
    args = ap.parse_args(argv)

    directory = args.dir
    if not directory and args.archive:
        if not os.path.exists(args.archive):
            print(f"archive not found: {args.archive}", file=sys.stderr)
            return 2
        try:
            directory = extract_archive(
                args.archive,
                args.workdir,
                force=args.force_extract,
                min_free_pct=args.min_free_pct,
                min_free_bytes=int(args.min_free_gb * (1024 ** 3)),
            )
        except PreflightError as exc:
            print(f"extraction refused: {exc}", file=sys.stderr)
            return 3
        except ArchiveError as exc:
            print(f"archive unreadable: {exc}", file=sys.stderr)
            return 2
    if not directory or not os.path.isdir(directory):
        print("need --dir <capture dir> or --archive <7z>", file=sys.stderr)
        return 1

    reqs, meta, resps, files = index_corpus(directory)
    if not reqs:
        where = "after extraction" if args.archive else ""
        print(f"no req-* captures {' '.join(filter(None, [where]))} in {directory}", file=sys.stderr)
        return 1
    by_machine, by_lane, counters = attribute(reqs, meta, resps, directory)
    print(render(by_machine, by_lane, counters, args.top))
    if args.json:
        totals = _totals(counters)
        payload = {
            "counters": counters,
            "totals": totals,
            "by_machine": {k: v for k, v in by_machine.items()},
            "by_lane": {f"{k[0]}/{k[1]}": v for k, v in by_lane.items()},
        }
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
