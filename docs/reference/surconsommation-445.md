# Surconsommation #445 — D1 (lecture) and D2 (remediations, posed)

**Issue of record: `claudish#445`.** Every dashboard entry points back to it; this file is the
in-repo copy of the diagnostic, not a second state.

Measured 2026-10-29/30 on the hub seat (`myia-po-2025:claudish`) against the **live** capture
corpus (`D:\claudish-captures`, 95 648 request captures / 89 579 response captures, 14 lanes).
Instruments: `scripts/turn-autopsy.py sample|show` (read slices — a reading sample, never a
counting pass), `scripts/turn-composition.py envelope` (PR #770, per-model / per-machine
attribution), capture-name and `X-Claudish-Machine` header parsing.

DoD of the user mandate (29/10): **D1** qualitative diagnostic → **D2** remediation posed →
**D3** applied and verified by its effect → **D4** consumption back under the envelope
(~1 k$/month DeepSeek on top of ~1 k$ of subscriptions, at July's merge rate).

---

## D1 — what is actually inside the turns

The quantitative chain is closed and deposited separately (issue comments `6512079383`
per-model, `6513686261` per-machine, `6515641415` qualitative). This file carries the
**qualitative** grain and the **remediations**.

### The one number that orders everything

From the 20-turn reading sample (15 work turns, 5 organ turns):

| | median | max |
|---|---:|---:|
| `sys=` (client harness floor, tokens) | 11 078 | 22 534 |
| `cache_read` (the re-read, tokens) | **153 472** | 293 120 |
| `msgs` (conversation length) | 101 | 1 073 |
| `tools_decl` | 33 | 73 |

**The re-read is 13.9× the harness floor.** The harness is *not* the dominant lever — the
replayed history is. That corroborates #770's decomposition (requests ×7.3 while
bytes/request ×1.22): **axis A (harness slimming) is not the lever; axis B (turn count and
session length) is.**

### The five named causes (verbatim, read in the turns)

- **A. The floor is not one floor — it is four loaders.** See D2-2 below; the earlier
  "a block loaded twice" reading is **refuted** by the block-level diff.
- **B. Client reminders are re-injected every turn.** `last[system]` on 10/20 turns, dominant
  text: `Proactive output style is active. Execute autonomously, minimize interruptions,
  prefer action over planning.` Low token cost, 100 % presence — a constant that ties the
  turns together, not a cost lever.
- **C. A misfiring guard becomes the next turn's input.** Verbatim: `PreToolUse:Bash hook
  error: [node "D:\dev\roo-extensions\scripts\hooks\guard-bash-composite.js"]:
  guard-bash-composite (#4243) : commande composee cd + rm sur un chemin …` — a guard that
  blocks in error pays for a whole turn.
- **D. Coordination and machine state get dumped into the input.** A `ls -la` listing, a PDF
  title listing, a Python traceback `rc=1`, a GitHub PR JSON body, a `roosync_messages` dump
  plus a log queue, a cron preamble, **a 6 643-token cluster-state dump**, and a compaction
  prompt, all read as turn inputs.
- **E. The dormant tool cost is paid per turn.** `tools_decl` median 33, up to 73 (po-2024 on
  Sol) — schemas declared in the clear on turns that will not use all of them.

---

## D2-2 — the floor taxonomy (the "doubled block" is refuted)

The D1 qualitative deposit reported the bimodal floor as `11 055-11 078` … `22 534 ×2` and
read the high mode as *2 × 11 267* — "a session trait, not a machine trait". **The block-level
diff refutes that**: no block is internally duplicated in the high mode. The high mode is a
**different agent**, and the floor splits into four loaders:

| loader | `sys=` (chars) | shape | where |
|---|---:|---|---|
| **Hermes** (orchestrator) | **21 026** | 2 blocks: identity 8 415 + **12 611 chars of `## Skills` catalogue (60 % of the prompt)** | ai-01, both high-mode turns |
| **Interactive + Proactive style** | **13 514** | base harness + **+2 790 chars** of Proactive-style lines (`Ask before you start only when…`, `The reasoning effort setting…`, `When one part of a task is blocked…`) | haiku lanes (ai-01, po-2024, po-2028) |
| **Interactive base** | **10 725** | `You are an interactive agent that helps users according to your "Output Style"` | the sonnet/opus lanes |
| **Agent profile** | **2 864** | `You are an agent for Claude Code…` — a different base prompt, not the interactive one | ai-01 (cc 2.1.312.ec7), po-2028 (cc 2.1.311.0cc) |

⇒ The floor is **not** a constant to be shrunk once; it is a function of *which agent* and
*which output style* the seat runs. A single "trim the harness" lever would have moved the
2 864 tier and left the Hermes catalogue untouched.

### Fleet weight of each loader

Weighted by the per-machine request volume already measured (ai-01 23 167 · po-2024 13 613 ·
po-2028 13 298 · po-2023 11 514 · po-2025 11 044 · po-2027 5 865 · web1/web2 2 721), applied to
the loader mix observed in the 200-turn stratified sample:

| loader | share of fleet requests | mean floor (chars) |
|---|---:|---:|
| Interactive base | **57,5 %** | 11 234 |
| Interactive + Proactive style | **27,2 %** | 13 511 |
| **Hermes (skills catalogue)** | **7,0 %** | **20 974** |
| Other / mixed | 4,7 % | 6 118 |
| Agent profile | 2,6 % | 2 871 |
| No system block | 1,0 % | 0 |

**The Hermes catalogue is 7 % of the fleet's requests and 24 % of ai-01's** — it is the only
loader whose excess is worth a dedicated action (the catalogue, not the harness). The
`(none)` machine bucket (3 316 requests) had no sampled turn and is excluded from the
weighting; the totals above therefore cover 81 222 of the 84 538 measured requests.

> The exhaustive fleet-wide version of this census (95 648 request files) was **started and
> stopped**: it read ~190 GB off `D:` at ~48 ms/file and would have competed with the hub's
> own capture writes. The stratified sample above replaces it, and says so.


---

## D2-1 — compaction threshold, quantified (the counterfactual)

Method: 200-turn stratified sample (`--stratify lane`), messages bytes measured exactly on
the copied captures, re-read measured as `cache_read` from the response usage. For each turn
above the threshold, the counterfactual re-read is `cache_read × threshold / n_messages`
(**per-turn** density — an earlier attempt that extrapolated from the fleet-median
bytes/message was wrong in sign and was discarded).

| compaction threshold | fleet re-read (200-turn sample) | reduction |
|---|---:|---:|
| 200 msgs | −15.9 % | **−2.28 G tokens/day** (extrapolated on ~95 000 turns/day) |
| **300 msgs** | **−8.2 %** | **−1.18 G tokens/day** |
| 400 msgs | −5.4 % | −0.78 G tokens/day |
| 600 msgs | −3.2 % | −0.46 G tokens/day |

Distribution: median `n_messages` 125 (p75 236, p90 392, max 1 982); **16 % of turns exceed
300 messages and carry 22 % of the re-read**; their `cache_read` median is 201 088 against
159 360 for the fleet.

**The saving is concentrated, not diffuse** — which is what makes a threshold worth setting:
a 300-message threshold touches 16 % of turns for 8.2 % of the re-read, a 200-message
threshold touches fewer turns for twice the effect.

### Where the re-read lands (and why it is not an OpenAI problem)

Re-read share by **served** lane (the model that actually answered):

| served lane | share of re-read | share of output |
|---|---:|---:|
| `openai/deepseek-flash` | 34.1 % | 38 % |
| `anthropic/MiniMax-M3.1-Flash` | **27.9 %** | 26 % |
| `openai/glm-5.3` | 20.1 % | 16 % |
| `anthropic/k3.1-pro` | 13.0 % | 3 % |
| `native/claude-opus-5-5` | 3.5 % | 3 % |
| `responses/gpt-6.1-sol` | 0.5 % | 0.9 % |

⇒ The OpenAI credit burn is **not** driven by the re-read (0.5 % of it) — it is the
Opus→Sol absorption measured on the request side (2 080 fallback responses + 1 045 direct on
29/10). The re-read lands on **MiniMax (27.9 %)**, DeepSeek PAYG (34.1 %) and GLM (20.1 %).

**Link to the plan wall (Q-39)**: MiniMax's console reads 51.61 B tokens/day on the Coding
plan, and the MiniMax plan bills on tokens. A 300-message compaction threshold therefore cuts
the MiniMax plan's daily consumption by ≈ 6 % (≈ 27.3 % of the re-read is MiniMax's, and the
threshold removes 8.2 % of the re-read), pushing the weekly wall out by roughly an hour; at
200 messages, ≈ 12 % and ≈ 2.4 hours. Modest — but it is the **only** lever measured here that
touches the wall's driver rather than its symptom.

---

## D2-5 — the denominator (work requests vs organ requests)

In the 20-turn reading sample, **5 of 20 turns were not agentic work**: a canary (`ping`),
an arithmetic probe (`Think step by step about 17*23`), a FrogNano extraction, a compaction
summary prompt, and one `sys=`=514 turn. In the 200-turn sample the same class is **5/200 =
2.5 %** of turns but **≈ 0 % of the re-read** (192 tokens).

⇒ The **request** counters of #328/#445 currently mix organ traffic into the work denominator;
the **token** counters are essentially untouched by it. The honest ×7.3 is a request-count
ratio; the re-read analysis is a token ratio. They must not be quoted as one number.

---

## D2-3 / D2-4 — routed, not patched here

| # | Remediation | Owner | Note |
|---|---|---|---|
| **D2-1** | Compaction threshold on long sessions | agent policy, several workspaces | effect measured above (−8.2 % at 300 msgs, −15.9 % at 200) |
| **D2-2** | Act per loader, not on a global floor | workspace-specific | taxonomy above |
| **D2-3** | A guard's error must not become the next turn's input | `roo-extensions` | **signal, not a patch** (other workspace) |
| **D2-4** | Do not inject machine/coordination dumps into the input | `roo-extensions` | **signal, not a patch**; the 6 643-token cluster dump is the measured case |
| **D2-5** | Separate work requests from organ requests in the #328/#445 denominator | instrument (#770) | 2.5 % of turns, ≈ 0 % of the re-read |

**No cascade change is involved in any row above.** No `DIRECTION`, no `LABEL`, no
`STEP_EXCLUDE`, no step order: the entries here are agent-policy, harness and instrument
gates. Any cascade-side remedy remains behind the 28/10 arbitration rule.

---

## Limits (stated, not implied)

- The qualitative grain is a **reading sample** (20 turns read; 200 measured) against 95 648
  requests — **0.2 %** of the corpus. It is a named-cause sample, **not** a cost distribution.
- `cache_read` and `sys=` are **client input tokens**, not an invoice. The mapping from
  tokens to € is the cost ledger's job (`cost-ledger-405`), not this file's.
- The counterfactual is **linear in message count** and assumes the history would otherwise be
  replayed unchanged; a real compaction also replaces tool-result bulk with a summary, so the
  saving is a **lower bound**.
- The **live corpus no longer contains July** (compaction pushed it into the `captures-*.7z`
  archives) ⇒ **no before/after ratio is computable here**. It requires a `history` pass over
  the archives, announced beforehand (17/10 pre-flight guard).
- The re-read split by served lane is a **200-turn** sample of a 95 648-request corpus.

— hub seat `myia-po-2025:claudish` · grain: D1 qualitative + D2 posed. D3 (applied, verified
by effect) is the next grain and needs the user's arbitration on D2-1 and D2-2.
