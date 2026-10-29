# Capture Pipeline Port to v14 — Spec (#641 blocker 2)

Status: spec delivered as PR #722 (`port/641-capture-pipeline`, open, on `replatform/v14`)
— the 3 verbatim files plus the wires below, executed 27/10. The port's measured
deviations from this document are recorded in the last section; review #722 against
both. Scope: make the traffic-measurement apparatus survive the `replatform/v14` landing. The go/no-go evaluation (#641, comment
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
| 4 | `stream-parsers/openai-responses-sse.ts` (≈ `:154`) | same, label `responses` — v14 reality: the parser is 3 sub-modules there, the tap hooks `onFirstUpstreamData` in `responses-leg.ts` |
| 5 | `stream-parsers/gemini-sse.ts` (≈ `:42`) | capture tap only (no ttft marker on main either) |
| 6 | `stream-parsers/ollama-jsonl.ts` (≈ `:33`) | capture tap only |
| 7 | `handlers/native-handler.ts` (≈ `:358`) | `createResponseCapture("native", …, requestNumberFor(c.req))` + `appendUpstreamError` at the non-ok site (≈ `:336`) |
| 8 | `handlers/composed-handler.ts` non-ok upstream sites (main `:1284`, `:1442`) | `appendUpstreamError({...})` |
| 9 | `handlers/composed-handler.ts` wall reporting (main `:1453`) | `logStderr(wallMarkerLine(this.provider.displayName, response.status, requestNumberFor(c.req), hint))` |

(Exact line numbers are main's, as the anchors to copy from; v14 equivalents sit in the
same functions — the files are 143 re-based M's, so verify each anchor on arrival.)

## Deviations measured in the port (PR #722, relecture 29/10)

Most of these are wiring realities of the v14 tree, recorded so this spec matches what
the branch actually carries. **One of them broke a reader contract, and the read-back is
what caught it** — see the `srv.requestIP` bullet:

- **responses parser**: v14 splits it into 3 sub-modules — the capture tap is a hook
  (`onFirstUpstreamData`) in `responses-leg.ts`, not a single anchored site.
- **`srv.requestIP(req)` is Bun on v14 — and it entered the FILENAME.** The port adapted
  the remote-addr path to the v14 server API and let the result flow through
  `resolveSourceIp`, so a locally-served capture was named
  `req-<pid>-<n>-<ts>-127.0.0.1.json`. `turn-autopsy.py`'s `REQ_RE` accepts only
  `direct` or the relay-pair form (`a.b.c.d__e.f.g.h_n`), so the **entire v14 corpus
  read back as "no req-* members found"** while the same turns through main paired 2/2.
  All **1 371** production captures on the hub are `-direct`: main's `ctx.remoteAddress`
  never resolved on Bun, so that shape had never been emitted. Fixed in PR #757 —
  `src` keeps the historical vocabulary (`x-forwarded-for` / `x-real-ip`, else
  `direct`) and the address becomes the additive `remote` payload field, after `hops`.
- **One `appendUpstreamError` site has no v14 counterpart**: main's policy-refusal site
  (#65) does not exist on the v14 tree — absent, not wired.
- **`appendUpstreamError` receives the already-rewritten error text** (v14's
  signing-lease invariant), where main's site passes it at an earlier stage.
- **`headerLatencyMs` rides a new `handleStream` parameter** — main's mechanism for the
  wall/latency marker did not transplant as-is.
- **`BodyInit` ×2 base casts → `SerializedBody`** (`6f5cdc88`): the v14 base's
  `as BodyInit` casts at `relay.ts:535/:736` fail the `macos-bridge` typecheck pass;
  replaced with the trunk's `SerializedBody` union (`providers/transport/types.ts`).
- **11th v14 file touched: `src/recovery-contract/child-proxy-run.ts`** (CP-10): the
  recovery child parses its own stdout as one JSON line and the ungated traffic markers
  broke it. Fixed by ONE shared filter, `src/test-support/traffic-markers-silence.ts`,
  installed by that child and by the 3 hermetic test children that parse their stdout
  (the marker-pollution family, `82e580ea`). The filter is a narrow whitelist: a real
  marker-shape leak still fails tests.
- **Mutation audit: 7/8 invariants redden their exact pin.** INV-1 (fire-and-forget) is
  not unit-mutable — the structural guarantee is documented inside
  `response-capture.test.ts` itself.
- **Acceptance**: producer pins green on the branch (50 + 171 + 87 tests). Consumer
  read-back **measured 2026-10-29** on a live v14 build fed the same two turns
  (openai + anthropic lane) as main, consumers run unchanged:
  `traffic-summary.ps1` identical verdicts on both corpora;
  `turn-autopsy.py` invisible on v14 before the fix, then **2 req / 2 resp, 2 lanes,
  pairing 2/2 — identical to main, field for field** after it; `native-consumption.py`
  identical ("no native capture", no native turn in either corpus — the native lane was
  not exercised, no Anthropic credential was passed to the bench).
  The bench ran **outside the container**, so `pid` is a host id, not `1`; the
  comparison was made on copies whose pid token was rewritten to `1`, content
  untouched (environment artifact, identical on both sides).
  Merge remains the port PR's call; the fix rides PR #757 (base
  `port/641-capture-pipeline`), and no consumer file was modified.

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
