# Compaction on the wire

What a Claude Code compaction looks like when it crosses the proxy, how often it happens on the
fleet, what it costs per lane, and why routing it to a cheaper model is not the lever. Measured
05/11/2026 on the hub captures (Claude Code 2.1.31x). Instrument: `scripts/compaction-census.py`.

## Shape

A compaction is **not a separate, small request**. It is the main conversation re-sent unchanged —
same `messages`, same `tools`, same `model`, same effort, `max_tokens` 128000, adaptive thinking —
with an instruction block appended to the **last user message**. The model answers with text only:
an `<analysis>` block, then a `<summary>` with nine numbered sections (primary request, technical
concepts, files, errors, problem solving, all user messages, pending tasks, current work, next step).

Detection (what the census uses): both phrases `conversation so far` and `do not call any tools`
inside the text blocks of the last user message. Two traps:

- The older marker `create a detailed summary of the conversation` does **not** match this shape.
- A conversation that quotes the instruction in an *earlier* message is not a compaction — only the
  last user message counts.

Because the request is the conversation itself, it reaches the same lane as the turn before it, and
its prefix is the one that lane has just cached.

## Measured on 05/11, 08:00→12:30Z (all machines through the hub)

| Served lane | Compactions | Cache read on the compaction | Compactions' share of the lane's output tokens |
| --- | ---: | ---: | ---: |
| DeepSeek flash (PAYG) | 69 | 98 % | 11.8 % |
| Anthropic native (Opus) | 36 | 98 % | 21.2 % |
| GLM-5.3 | 24 | 83 % | 14.7 % |
| swift (vllm) | 17 | 0 % *(see below)* | 18.7 % |
| MiniMax | 12 | 100 % | 8.9 % |
| sol (OpenAI) | 6 | 24 % | 61.6 % |

- 176 compactions in 4 h 30 (12 without a paired response). **10 only** came after the session had
  been silent for ≥ 50 min; the rest fire mid-flight, between two working turns.
- One long interactive session alone produced 17 compactions in 3 h 40.
- **vllm never reports a cache read**: 205/205 swift responses carry `cache_read_input_tokens: 0`
  over 11:00–12:30Z, whatever the engine's prefix cache actually did (its own counters showed a
  ~74 % prefix hit rate that morning). The census flags such a lane: 0 % there is the instrument,
  not a miss. Whether vllm serves compactions from its prefix cache is an open question for the vllm
  lane, answerable only from the engine's counters.

## Routing compactions elsewhere — measured, not a gain

The idea (user, 05/11): route every compaction to a small cheap model, so that compacting more often
costs less. The measurement goes against it:

- On its own lane, a compaction is read at the **cache price** (83–100 % above). Moving it to another
  model pays a **cold prefill of the whole conversation** (~200 k tokens) on the target, to save only
  the output (6–17 k tokens).
- Probe: one captured compaction replayed on `kc@k3` (Kimi, Coding plan). It answered 200, text
  only, the same nine-section structure, in 193 s, slightly less faithful on the verbatim user quotes
  (section 6 at ~44 % of the original's length). It reported almost no cache read (~1 % of its
  input). Cost on the Kimi console: **+0.50 pt of the 7-day window and +1.26 pt of the 5-hour window
  for one compaction** (the 5-hour window was at 0 just before, so the whole increment is the probe).
  At that rate the remaining 7-day budget holds about two hours of the fleet's compactions.

So the lever is the **number** of compactions, not where they run:

- the **floor** each request carries (harness, system prompt, tool schemas — #874), which sets how
  soon a working conversation reaches the auto-compact threshold;
- the **idle-compaction threshold** (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`): with the fleet's
  auto-compact at 230 k × 95 % minus the reserve (≈ 197 k), a session never sits idle above the
  default 200 000 tokens, so idle compaction never fires today. Lowering it moves compactions from
  mid-flight to the silence between cron cycles — a user decision, not applied by this document;
- the **effort** the compaction inherits from the session (same effort as the working turn).

## Running the census

```text
python scripts/compaction-census.py D:\claudish-captures 2026-11-05T08-00-00 2026-11-05T12-30-00 --denominator
python scripts/compaction-census.py --self-test
```

- Timestamps are capture-file timestamps (`YYYY-MM-DDTHH-MM-SS`, UTC).
- The join is by time: the hub's request counter restarts with the container, so `(pid, reqN)` can
  name several response files; each request takes the first response of the same pair that ends at
  or after it, within 30 minutes — a join on the number alone picks a response from the previous
  container life. `--self-test` pins this and the
  last-message-only detection on a synthetic corpus.
- Output: one line per compaction (time, machine, 8-char session id, requested and served model,
  message count, token usage, idle gap), then per served lane. It never prints prompt or tool content.
