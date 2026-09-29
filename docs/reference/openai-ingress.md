# OpenAI-Compatible Ingress (`/v1/chat/completions`)

Decision layer: `CLAUDE.md` § "OpenAI-Compatible Ingress". This file holds the translation detail.

Anthropic is the **native** ingress (`/v1/messages`). `POST /v1/chat/completions` is a **translated**
ingress: an OpenAI-format request is converted to Anthropic shape, run through the **same** routing
pipeline (`getHandlerForRequest` → `ComposedHandler.handle`), and the response translated back to
OpenAI wire shape. Everything the Anthropic path earns — routing cascade, budget failover,
accounting, leak policy — the OpenAI path inherits for free. A consumer flips onto the hub by
changing `base_url` alone.

## Request converter

`handlers/shared/format/openai-request-to-anthropic.ts`:

| OpenAI | Anthropic |
|---|---|
| `system` / `developer` role | top-level `system` field |
| `user` (string, or parts incl. `image_url`) | content blocks |
| assistant `tool_calls` | `tool_use` blocks |
| assistant `reasoning_content` | `thinking` blocks |
| `tool` role | `tool_result` |
| function tools | `input_schema` |
| `tool_choice` | mapped |
| *(absent)* `max_tokens` | defaulted — Anthropic requires it, OpenAI does not |

## Response translators

`handlers/shared/anthropic-to-openai.ts`:

- `anthropicMessageToChatCompletion` — non-streaming: collected message → `chat.completion` JSON,
  computes `total_tokens`.
- `createOpenAIChatStreamFromAnthropic` — streaming: Anthropic SSE → `chat.completion.chunk` SSE,
  terminated by `data: [DONE]`.

`thinking` blocks surface as `reasoning_content` (the OpenAI extension DeepSeek and GLM use).
`stop_reason` maps to `finish_reason`: `end_turn`/`stop_sequence` → `stop`, `tool_use` →
`tool_calls`, `max_tokens` → `length`.

**Never-hang holds on this path**: a malformed stream degrades to a single terminal chunk plus
`[DONE]` rather than stalling the consumer.

## Failover notices (#229)

On this route a failover notice is **never** written into the
content. It is set as the `x-claudish-failover-notice` response header, whose value is base64 of the
UTF-8 notice text (header values are single-line ASCII; the notice is multi-line markdown). It is
present on both the streaming and the non-streaming response, and a relay passes it through from the hub.

Why: the notices exist for an agent in the loop, which recalibrates when told its model changed
(#126). A programmatic consumer cannot, and for it a notice in the content IS the answer. Measured
on 2026-09-23: a code-review step whose entire content was the recovery notice over an empty model
output, so an empty-output guard never fired. The discriminator is the route
(`noticePolicyForIngress` in `handlers/shared/failover-stream-notice.ts`) and deliberately not the
user-agent, which drifts with client versions. `/v1/messages` keeps the in-content notice.

Route-level pin: `proxy-server-openai-notice.test.ts` (header present, content byte-clean, inert
when nothing is armed).

## Relay behavior

`relay.ts` is **path-aware**: a sidecar forwards to the SAME route the client hit, so an OpenAI
request on a sidecar reaches the hub's `/v1/chat/completions` in NOMINAL mode. That preserves the
whole resilience model rather than special-casing one ingress. The deep liveness probe stays on
`/v1/messages`.

## Out of scope (for now)

`/v1/models` discovery · OpenAI web-search tool interception · per-role thinking policy on the
OpenAI path.
