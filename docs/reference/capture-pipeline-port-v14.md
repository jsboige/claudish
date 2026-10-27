# Capture Pipeline Port to v14 — Spec (#641 blocker 2)

Status: spec (chosen over a direct port this cycle). Scope: make the traffic-measurement
apparatus survive the `replatform/v14` landing. The go/no-go evaluation (#641, comment
6434476328) lists the absent capture pipeline as hard blocker 2: on v14 (`d2afec56`) there
are zero capture writers, so `claudish_traffic`, the `traffic-*.ps1` family, attribution
(#98/#400/#566/#662), the leak-policy greps and `turn-autopsy.py` would all die at landing.

**This is a port, not a redesign.** Every behavior below already exists on main and is
pinned by tests; the spec is the inventory of what moves where, plus the invariants that
must not drift in the move. When the port lands, this document is deleted (the standing
capture documentation in `traffic-analysis.md` and the source headers take over).

## What v14 already has (verified at `d2afec56`)

The port surface is far narrower than "rebuild the pipeline" — v14 already carries every
dependency:

- all five stream parsers under `src/handlers/shared/stream-parsers/` (they exist, they
  just don't tap a capture);
- `src/instance-id.ts` (the `getInstanceId()` the envelope and relay key on);
- `src/handlers/shared/inbound-keys.ts` (`inboundKeyFor`);
- `src/fork/server/relay.ts` exporting `HOPS_HEADER` (hop-chain capture reads it);
- the `/v1/messages` route with the relay branch **before** handler resolution
  (`proxy-server.ts:1253` ff) — the ordering constraint the capture depends on is already
  in place;
- `src/handlers/composed-handler.ts` and `src/handlers/native-handler.ts`.

## Files to port (3, verbatim)

| main path | brings |
|---|---|
| `src/fork/middleware/request-logger.ts` | `req-*.json` capture, the pinned `[Request]` stdout line, `requestNumberFor` WeakMap, attribution fields, `hops`, `inbound_key` |
| `src/handlers/shared/response-capture.ts` | `resp-*.sse` capture, `[resp]` marker, `appendUpstreamError` → `upstream-errors.log` |
| `src/handlers/shared/traffic-markers.ts` | `ttftMarkerLine` / `respMarkerLine` / `wallMarkerLine` — the traffic-format contract's single source |

Their tests travel with them: `request-logger.test.ts`, `response-capture.test.ts`, and
`fork/middleware/traffic-format-producer.test.ts` (the producer-side format pin — without
it a format change breaks the consumers in the other repo weeks later, the #3391 lesson).

## Call sites to wire (9)

| # | site (v14 path) | wire |
|---|---|---|
| 1 | `src/proxy-server.ts` `/v1/messages` (after the relay branch, alongside handler resolution ≈ `:1347`) | `logRequest(body, handler.constructor.name, c.req.raw, hostnameConfig.remoteAddrMap)` — **one** wire; v14 has no `/v1/chat/completions` route, so main's second wire at `proxy-server.ts:3127` has no counterpart |
| 2 | `stream-parsers/anthropic-sse.ts` (≈ `:110`) | `reqN = requestNumberFor(c.req)`, `createResponseCapture("anthropic", …, reqN)`, `ttftMarkerLine` at first `data:` |
| 3 | `stream-parsers/openai-sse.ts` (≈ `:305`) | same, label `openai` |
| 4 | `stream-parsers/openai-responses-sse.ts` (≈ `:154`) | same, label `responses` |
| 5 | `stream-parsers/gemini-sse.ts` (≈ `:42`) | capture tap only (no ttft marker on main either) |
| 6 | `stream-parsers/ollama-jsonl.ts` (≈ `:33`) | capture tap only |
| 7 | `handlers/native-handler.ts` (≈ `:358`) | `createResponseCapture("native", …, requestNumberFor(c.req))` + `appendUpstreamError` at the non-ok site (≈ `:336`) |
| 8 | `handlers/composed-handler.ts` non-ok upstream sites (main `:1284`, `:1442`) | `appendUpstreamError({...})` |
| 9 | `handlers/composed-handler.ts` wall reporting (main `:1453`) | `logStderr(wallMarkerLine(this.provider.displayName, response.status, requestNumberFor(c.req), hint))` |

(Exact line numbers are main's, as the anchors to copy from; v14 equivalents sit in the
same functions — the files are 143 re-based M's, so verify each anchor on arrival.)

## Invariants that must not drift

1. **Fire-and-forget capture writes** — `writeFile(...).catch()`, never `writeFileSync`
   on the request path (2026-08-20 event-loop freeze). The one deliberate exception is
   `appendUpstreamError`'s `appendFileSync` (2 KB cap, error path only).
2. **The stdout marker precedes the disk write** — `[resp]` is the real-time hang signal;
   it must not wait on I/O.
3. **`reqN` is frozen at ingestion** via the `WeakMap<Request, number>` — never read from
   the global counter at response time (under concurrency every handler built in a window
   would share the latest number and break `req-*`↔`resp-*` pairing).
4. **`hops` is always written** (`[]` = direct, absent = pre-#566 capture) and seated
   after model/pid/attribution — the leak-policy reads attribution from the head of the
   capture (a long fake chain must not push `model` out of the window, measured offset
   73 → 618).
5. **Capture runs before `stripBillingHeaderFromBody`** — `cc_entrypoint`/`cc_workload`
   attribution reads the billing line in `system[0]` while it is still present.
6. **Filename formats are reader contracts** — `req-{pid}-{n}-{ts}-{src}.json`,
   `resp-{pid}-r{n}-{ts}-{label}-{model}.sse`; the scripts join by `(pid, reqN)`, never
   by parsing filenames, but every reader lists them by glob.
7. **`[Request]` / `[ttft]` / `[resp]` / wall lines are pinned shapes**
   (`traffic-format-producer.test.ts` + `__fixtures__/traffic-format/`) — the
   `claudish_traffic` MCP tool and the whole `traffic-*.ps1` family parse them
   field-by-field. A drift must fail in THIS repo, at the producer.
8. **Nominal relay forwards never capture locally** — wire #1 sits after the relay branch
   (already ordered correctly on v14); `createResponseCapture`'s `enabled=false` path
   covers the passthrough reuse.

## Acceptance

- `bun test traffic-format-producer response-capture request-logger lane-capture-coverage`
  green on the v14 branch, unmodified from main.
- A capture corpus produced by a v14 build (hub mode, `CLAUDISH_CAPTURE_DIR` set, a
  handful of real turns across openai/anthropic/native lanes) is read back by the
  unmodified consumer family — `claudish_traffic` MCP, `traffic-summary.ps1`,
  `turn-autopsy.py`, `native-consumption.py` — with correct attribution fields
  (`machine`, `hops`, `inbound_key`, `device_id8`, `entrypoint`/`workload`).
- `docker logs` shows a `[Request]` line for every admitted request and a `[resp]` (or an
  investigated absence) for every stream — the never-hang pairing signal.

## Effort

Small-to-medium: 3 file copies, 9 anchored wires, test carry-over. The risk is not the
code, it is a silent invariant drift (items 3, 4, 5 above) — which is why the producer
pins travel with the port and the acceptance run reads the corpus back with the real
consumers rather than eyeballing files.
