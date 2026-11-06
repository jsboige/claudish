# v14 never-hang audit (#641 G4)

Scope: the `Never-Hang Constraints` section of `CLAUDE.md`, verified against the
v14 tree (`r1-port`, = `replatform/v14` line). Verdict first, then the per-site
table. Paths below are relative to `packages/cli/src`; `origin/main` here is the
flattened `packages/cli/src` subtree, so the same relative paths resolve on both.

## Verdict

**No `controller.error()` on any client-facing stream.** Main has zero such
calls in production (the only non-test hit is the *comment* in
`handlers/shared/endpoint-token-budget.ts` stating the rule). v14 has **six**
`controller.error()` call sites, all in **fork-only files**, and every one sits
on an **internal** stream whose error is caught and converted into a terminal
`message_stop` tail by the parser downstream of it. None is the response body
handed to Claude Code.

The invariant that makes this safe: a stream that can `error()` is always read
by a component that treats a read rejection as "upstream died mid-turn" and
responds by emitting the terminal pair (`message_delta` + `message_stop`) and
closing — never by propagating the rejection to the client socket.

## The six sites and why each is contained

| # | Site (file:line) | Stream it errors | Reader that catches it | Terminal guarantee | Pin |
|---|---|---|---|---|---|
| 1 | `handlers/shared/stream-head-sniffer.ts:132` | replayed upstream body (Responses sniff) | `openai-sse.ts` read loop → `finalize()` (guarded, re-called by outer catch) | `message_stop` via `finalize()` | `stream-parsers/*` suites |
| 2 | `handlers/shared/devin-stream-head-sniffer.ts:163` | replayed upstream body (Devin sniff) | `devin-connect.ts` → same parser family | terminal pair | devin parser suite |
| 3 | `handlers/shared/call-context.ts:217` (`releaseWhenBodyEnds`) | re-read of the **already-finalized** client response | the client socket | see note below | `advisor-*`, `composed-handler-*` suites |
| 4 | `handlers/shared/stream-parsers/upstream-cancel.ts:97` (`notifyOnDownstreamCancel`) | wrap **downstream** of the parser output | the client socket | parser already emitted the tail upstream of this wrap | `stream-parsers/client-cancel.test.ts` |
| 5 | `handlers/advisor-decorator.ts:510` (`withAdvisorSwap` passthrough) | tee of the handler's response to the advisor scan | the handler's own consumer | advisor-only path, not a harness turn | `advisor-decorator.test.ts` |
| 6 | `hooks/raw.ts:676`, `hooks/raw.ts:964` | raw-hook tap replay / fallback reader | the raw-stream tap consumer | hook taps never gate the client turn | `hooks/raw.test.ts` (13 tests) |

### Note on sites 3 and 4 (the only two downstream of the parser)

These two wrap the response **after** the parser produced it, so their reader is
the client. They are still not leak paths, for a structural reason:

- The parser (`anthropic-sse.ts` / `openai-sse.ts`) **never** calls
  `controller.error()` on its own output. Its terminal paths all
  `controller.enqueue()` the tail then `controller.close()` (see
  `finalizeAbandonedStream`, anthropic-sse.ts:250–317, and the outer
  `catch (e)` at :914 that finalizes then closes).
- `releaseWhenBodyEnds` and `notifyOnDownstreamCancel` only `await
  reader.read()` on that finalized stream and re-enqueue. A read can only
  reject if the parser errored its output — which, per the point above, does not
  happen. Their `controller.error(err)` is a defensive re-throw that is
  unreachable in practice, not a live leak.

## The load-bearing parser guarantees (v14)

- `anthropic-sse.ts:250` `finalizeAbandonedStream` — always ends with
  `send("message_stop", …)`; guarded by `isClosed || sawMessageStop`; the
  `catch {}` at :309 swallows a double-fault so it never masks the original.
- `anthropic-sse.ts:634` `readLoop` — `catch (readFail)` at :638 tries the #170
  pre-visible re-forward, else rethrows into the outer `catch (e)` at :914,
  which calls `finalizeAbandonedStream(controller)` then `controller.close()`.
  This is the exact analog of main's `finalizeWithError` (main
  `anthropic-sse.ts:362`).
- `openai-sse.ts` `finalize()` — re-entry-guarded on `state.finalized`;
  re-called by the outer catch so a mid-flush throw still terminates.

## Constraints checklist (CLAUDE.md §Never-Hang)

| Constraint | v14 status |
|---|---|
| No `controller.error()` in production sources | **Holds on the client plane** — six internal sites, all contained (table above) |
| Every terminating path emits `message_stop` (incl. `finalizeWithError`, relay passthrough) | Holds — `finalizeAbandonedStream`, `openai-sse.finalize()`, relay `finalizeWithError` |
| `stream:false` returns one JSON `message`, never SSE | Holds — `ComposedHandler.handle()` buffers via the SSE collector |
| Failed web search/fetch never stops the agent | Holds — backend fallback chain degrades to text |
| Never gzip the SSE response | Holds (response not gzipped) |
| First-useful-event watchdog confines a silent 200 | Holds — `first-event-watchdog.ts` emits terminal on timeout |
| Retried stream gets its OWN watchdog | Holds — `boundRetryUpstream()` wraps per attempt |
| Upstream death before any client-visible event is recovered (#170) | Holds — `tryPreVisibleReforward` in `readLoop` |
| Policy refusal retried then surfaced labeled (#65) | Holds on v14 via the parser's refusal path; main's `policy-refusal.ts` module is main-only (see port-map) |
| #565 context admission refuses with numbers, recoverable turn | Holds — `context-overflow.ts` + the census block in `proxy-server.ts` (PR #900) |
| #772 frame `event:`/JSON `type` coherence | Holds — `frame-coherence` repair at `emitDataLine` |

## What this audit does NOT certify

- It is a **static** containment argument plus the existing test suites. It is
  not a fuzz of the live socket. The client-cancel contract is pinned by
  `stream-parsers/client-cancel.test.ts` (G2–G4 in an isolated HOME).
- Sites 3 and 4 rest on "the parser never errors its own output." If a future
  change ever adds a `controller.error()` to a parser's output stream, these two
  wrappers become live leak paths and this audit must be re-run.
