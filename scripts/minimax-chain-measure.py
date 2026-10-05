#!/usr/bin/env python
"""#295 post-deploy measurement: does the MiniMax thinking CHAIN restart?

Counts, over a bounded window of hub captures, on the MiniMax lane:

  (a) the share of resp-* SSE responses carrying a thinking block
      (pre-#324 baseline: 1/30, measured 2026-10-02);
  (b) the share of tool-continuation req-* bodies whose PRECEDING assistant
      turn carries a thinking block -- hypothesis 1 of #295 ("CC does not
      echo the blocks") measured directly;
  (c) is NOT measurable here: the [ComposedHandler] Preserved lines live in
      the hub's docker logs, not in the captures -- one-liner for the hub
      owner instead: docker logs <hub> 2>&1 | grep -c "Preserved .* own thinking".

The window is bounded by the post-#324 recreate's StartedAt (verified live
2026-10-05: 09:46:24Z, uptimeSec read from /health). Run once on the last
pre-#324 day to validate the instrument against the known 1/30 baseline
(negative control), then on the window archives once they land.

Traps (each inherited from a sibling script or measured here):
  1. Solid 7z archives make per-file selective reads brutal -- extract the
     whole archive once to a scratch dir, then scan plain files.
  2. On the containerized hub pid is ALWAYS 1 and every restart resets reqN
     under the same pid: pair per FILE with a 35-minute timestamp window
     (compaction-trend.py trap #2), never by (pid, reqN) alone.
  3. The served model rides the resp FILENAME (...-anthropic-MiniMax-M3.sse)
     and the resp header line (# parser=... model=... reqN=N pid=P); req
     filenames carry no model -- lane attribution is by pairing only.
  4. A req whose resp never captured cannot be lane-attributed: excluded
     from (b)'s denominator, counted separately (never silently dropped).
  5. Bodies are JSON but must never crash the scan: a file that fails to
     parse counts as unparsed, and string-level fallbacks keep the counters
     honest for oversized or truncated captures.

Usage:
  python scripts/minimax-chain-measure.py --archive "G:\\...\\captures-2026-10-04.7z" \
      [--since 2026-10-05T09:46:24Z] [--until ...] [--model-substr MiniMax] [--json out.json]
  # or point straight at an extracted/loose capture dir:
  python scripts/minimax-chain-measure.py --dir D:\\claudish-captures --since ...
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone

REQ_RE = re.compile(r"^req-(\d+)-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-\d+Z-(\w+)\.json$")
RESP_RE = re.compile(r"^resp-(\d+)-r(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-\d+Z-(\w+)-(.+)\.sse$")
TS_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})")
RESP_HDR_REQN = re.compile(r"reqN=(\d+)")
PAIR_WINDOW = timedelta(minutes=35)


def parse_ts(s):
    m = TS_RE.search(s)
    if not m:
        return None
    y, mo, d, h, mi, se = (int(x) for x in m.groups())
    return datetime(y, mo, d, h, mi, se, tzinfo=timezone.utc)


def parse_iso(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def extract_archives(archives, scratch_root):
    """Extract each archive to scratch_root/<basename>; return the list of dirs."""
    try:
        import py7zr
    except ImportError:
        sys.exit("py7zr is required for --archive (pip install --user py7zr)")
    dirs = []
    for a in archives:
        dest = os.path.join(scratch_root, os.path.splitext(os.path.basename(a))[0])
        if os.path.isdir(dest) and os.listdir(dest):
            dirs.append(dest)
            continue
        os.makedirs(dest, exist_ok=True)
        with py7zr.SevenZipFile(a, mode="r") as z:
            z.extractall(path=dest)
        dirs.append(dest)
    return dirs


def scan(dirs, since, until, model_substr):
    total_resp = carriers = 0
    unparsed_resp = 0
    # lane map: reqN -> [resp ts] (model already filtered by filename)
    lane_reqn_ts = {}
    for d in dirs:
        for name in os.listdir(d):
            m = RESP_RE.match(name)
            if not m or model_substr.lower() not in name.lower():
                continue
            ts = parse_ts(m.group(3))
            if ts is None or (since and ts < since) or (until and ts > until):
                continue
            total_resp += 1
            try:
                with open(os.path.join(d, name), "r", encoding="utf-8", errors="replace") as f:
                    body = f.read()
            except OSError:
                unparsed_resp += 1
                continue
            # a thinking block on the wire: a thinking_delta event, or a
            # content_block_start whose block type is thinking (the unfiltered
            # #324 shape emits both; the filtered pre-#324 shape emits neither)
            if '"thinking_delta"' in body or '"type":"thinking"' in body or '"type": "thinking"' in body:
                carriers += 1
            reqn = m.group(2)
            hdr = RESP_HDR_REQN.search(body[:400])
            if hdr:
                reqn = hdr.group(1).lstrip("0") or "0"
            lane_reqn_ts.setdefault(reqn.lstrip("0") or "0", []).append(ts)

    total_cont = cont_with_thinking = unpaired_cont = unparsed_req = 0
    for d in dirs:
        for name in os.listdir(d):
            m = REQ_RE.match(name)
            if not m:
                continue
            ts = parse_ts(m.group(3))
            if ts is None or (since and ts < since) or (until and ts > until):
                continue
            # cheap prefilter on the raw text: a tool_result block must exist
            try:
                with open(os.path.join(d, name), "r", encoding="utf-8", errors="replace") as f:
                    raw = f.read()
            except OSError:
                unparsed_req += 1
                continue
            if '"tool_result"' not in raw:
                continue
            try:
                body = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                unparsed_req += 1
                continue
            msgs = body.get("messages") if isinstance(body, dict) else None
            if not isinstance(msgs, list) or not msgs:
                continue
            last = msgs[-1]
            if not isinstance(last, dict) or last.get("role") != "user":
                continue
            content = last.get("content")
            blocks = content if isinstance(content, list) else []
            if not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks):
                continue
            # tool-continuation shape confirmed -- lane attribution by pairing
            reqn = (m.group(2) or "0").lstrip("0") or "0"
            resp_ts_list = lane_reqn_ts.get(reqn)
            if not resp_ts_list or not any(abs((ts - rts).total_seconds()) <= PAIR_WINDOW.total_seconds() for rts in resp_ts_list):
                unpaired_cont += 1
                continue
            total_cont += 1
            # the preceding assistant turn: last assistant message before the
            # final user turn
            prev_asst = next((x for x in reversed(msgs[:-1]) if isinstance(x, dict) and x.get("role") == "assistant"), None)
            if prev_asst is None:
                continue
            pc = prev_asst.get("content")
            pblocks = pc if isinstance(pc, list) else ([{"type": "text", "text": str(pc)}] if isinstance(pc, str) else [])
            if any(isinstance(b, dict) and b.get("type") == "thinking" for b in pblocks):
                cont_with_thinking += 1

    return {
        "resp_total": total_resp,
        "resp_thinking_carriers": carriers,
        "resp_unparsed": unparsed_resp,
        "req_tool_continuation_paired": total_cont,
        "req_continuation_prev_asst_thinking": cont_with_thinking,
        "req_continuation_unpaired": unpaired_cont,
        "req_unparsed": unparsed_req,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--archive", action="append", default=[], help="7z archive path (repeatable)")
    ap.add_argument("--dir", action="append", default=[], help="loose/extracted capture dir (repeatable)")
    ap.add_argument("--since", help="ISO 8601 lower bound (window start, e.g. the recreate StartedAt)")
    ap.add_argument("--until", help="ISO 8601 upper bound")
    ap.add_argument("--model-substr", default="MiniMax", help="lane filter on the resp filename (default MiniMax)")
    ap.add_argument("--json", help="write the result JSON here")
    ap.add_argument("--keep", action="store_true", help="keep the extraction scratch dir (default: removed)")
    args = ap.parse_args()

    if not args.archive and not args.dir:
        ap.error("need at least one --archive or --dir")

    since, until = parse_iso(args.since), parse_iso(args.until)
    scratch = None
    dirs = list(args.dir)
    try:
        if args.archive:
            scratch = tempfile.mkdtemp(prefix="mm-chain-")
            dirs.extend(extract_archives(args.archive, scratch))
        res = scan(dirs, since, until, args.model_substr)
    finally:
        if scratch and not args.keep:
            shutil.rmtree(scratch, ignore_errors=True)

    rt, rc = res["resp_total"], res["resp_thinking_carriers"]
    ct, cc = res["req_tool_continuation_paired"], res["req_continuation_prev_asst_thinking"]
    print("MiniMax lane (%s), window %s -> %s" % (
        args.model_substr,
        since.isoformat() if since else "(start of data)",
        until.isoformat() if until else "(end of data)",
    ))
    print("(a) responses carrying a thinking block : %d/%d = %.1f%%  (pre-#324 baseline: 1/30 = 3.3%%)" % (
        rc, rt, (100.0 * rc / rt) if rt else 0.0))
    print("(b) tool-continuations whose PREVIOUS assistant turn carries thinking : %d/%d = %.1f%%" % (
        cc, ct, (100.0 * cc / ct) if ct else 0.0))
    print("    unpaired continuations (no MiniMax resp to attribute the lane): %d ; unparsed req/resp: %d/%d" % (
        res["req_continuation_unpaired"], res["req_unparsed"], res["resp_unparsed"]))
    print("(c) [ComposedHandler] Preserved lines: docker logs only -- not in captures (hub owner greps)")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=2)
        print("json -> %s" % args.json)


if __name__ == "__main__":
    main()
