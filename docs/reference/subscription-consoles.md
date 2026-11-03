# Subscription consoles — the wall ledger

The cascade is driven by other people's quota walls. A wall is only legible from
the provider's own console: the proxy sees the *refusal*, never the remaining
budget or the reset anchor. This file is the inventory of those consoles and the
instrument to read them.

Catalogue (single source): `python scripts/console-tabs.py list` ·
`scripts/console-tabs.py urls` prints the reopen list, one URL per line.
Readings accumulate in `~/.claudish/console-readings.jsonl` (machine-local, never
committed — one JSON object per observation, so a series exists instead of a
snapshot).

## The console profile

All consoles are read through the **playwright MCP's persistent browser profile**.
One browser, several tabs, one session cookie per provider. Consequences:

- **A lost cookie is the normal failure**, not an incident: the tab lands on a
  login wall. Ask the user to re-authenticate in the visible tab — do not attempt
  a password flow, and never type credentials.
- **The MCP owns the profile lock**, so no second process may launch the same
  profile. A script cannot drive these tabs; it can only hold the catalogue.
- **Never click a destructive control in a console.** In particular z.ai's
  *« Réinitialiser le quota »* spends one of a finite number of resets, and any
  "top up" / "activate additional usage" button spends money. Reading is the job.

## Reading recipe

    # 1. reopen (only the missing tabs — the rest usually survive)
    roosync playwright browser_tabs list
    roosync playwright browser_tabs new <url>          # per missing console

    # 2. read: text digest, bounded, never a full snapshot (a snapshot of a
    #    dashboard is thousands of lines for one number)
    browser_evaluate: () => { const t=(document.body.innerText||'').replace(/\n{2,}/g,'\n').trim();
                              return { url: location.href, text: t.slice(0, 700) }; }

    # 3. when the number is buried, target it instead of dumping the page:
    browser_evaluate: () => { const m=(document.body.innerText||'').match(/[^\n]*(Utilisation|[Ll]imite|restant|Réinitialis)[^\n]*/g)||[];
                              return m.slice(0,20); }

    # 4. persist
    python scripts/console-tabs.py log --provider zai --field "5h=100%" --field "resets_available=3"

`location.href` matters: some consoles rewrite the URL with trace parameters
(QwenCloud does), so record the clean form and never paste the session-laden one
into a document.

### A tab is not a live view — reload before you read

An open tab renders when it was last loaded, not when it is read. Measured
2026-11-03 on a plan-usage console: the DOM was **byte-identical at 14:45Z to the
reading taken 4 h 45 earlier — same share, same countdowns** — and only a
`browser_navigate` to the same URL moved both the consumed share (by ~13 %
relative) and the remaining window (from hours to minutes). Nothing in the text
announces the staleness: the countdown still reads like a countdown.

So step 2 carries a step 0 — **`browser_navigate` to the console URL before
extracting**, and record the instant of the *reading*, not of the tab. Two
consecutive readings that agree to the minute on every countdown are the same
render, not a flat curve: re-read before concluding either.

### From a reading to a projection

`scripts/minimax-projection.py` (pins: `scripts/tests/test_minimax_projection.py`)
computes the weekly wall from a single reading and **refuses a caller-chosen pace
window**: the window is `reset_anchor − 7 d`, so the pace is elapsed time since the
window opened, never the gap between two samples. The distinction is not academic —
on a decelerating curve the two windows disagree by more than ×2 on the same reading,
enough to flip "the wall lands before the reset" into "no wall", and on 2026-11-03
three successive hand computations of one journal came out ×1.7 apart (cumulative
pace, a 5.3 h gap, and a reset anchor slipped by a day applied to remaining time).
`--recompute-log` re-derives a whole journal with the canonical column and flags the
rows that disagree; `--assume-anchor` repairs a row whose stored anchor slipped a
day (the same reading projects **×3 higher** on that anchor).

⚠ Measured console levels never enter this repository (public fork): the readings
live in the machine-local watch logs. What travels here is the ratio, the duration
and the arithmetic.

## The inventory

| id | console | answers | wall shape it produces |
|---|---|---|---|
| `minimax` | platform.minimax.io/console/usage | 5 h **and** weekly plan usage | weekly wall → haiku cascade diverts to `role:sonnet` |
| `zai` | z.ai/manage-apikey/coding-plan/personal/usage | Coding Plan **5 h** quota, MCP quota, available resets | `1302` rate limit + `1308` 5 h window, arms the **sonnet** bucket for 20-40 min |
| `kimi` | kimi.ai/settings/subscription | **5 h and 7 day** Code windows | 7-day saturates and stays at 100 % for days |
| `deepseek` | platform.deepseek.com/usage | **the PAYG bill**: balance, 30-day cost/requests/tokens | none — this is what the other walls cost |
| `qwen` | home.qwencloud.com/analytics/token-plan/individual | **monthly** Token Plan quota + reset timestamp | dead for the rest of the month once at 0 % |
| `mistral` | admin.mistral.ai/subscription | API allowance **included in the Pro subscription** | `402 API budget exhausted` — a *budget*, not a rate limit |
| `claude` | claude.ai/new#settings/usage | Anthropic plan weekly limit + reset | the interactive seats' own ceiling |
| `chatgpt` | chatgpt.com/settings/usage?tab=overview | weekly limit shared by Codex/Work/agents | Codex capacity |
| `copilot` | github.com/settings/copilot/features | monthly AI credits | rarely bound — a large idle reservoir |
| `openrouter` | openrouter.ai/workspaces/default/activity | **PAYG aggregator** — what the fleet pays when a direct step is walled and the route lands on `or@` | an aggregator wall moves the bill, not the cap |
| `anthropic-payg` | console.anthropic.com/settings/billing | **PAYG API**, distinct from the claude.ai plan; carries a monthly credit | *to authenticate* — the natural home for the dashboard condensation (Haiku) if vllm no longer wants it on swift |
| `openai-payg` | platform.openai.com/settings/organization/usage | **PAYG API**, distinct from the chatgpt weekly plan | *to authenticate* |

⚠ Two pairs are easy to conflate: **claude.ai plan ≠ Anthropic PAYG**, and
**chatgpt weekly plan ≠ OpenAI PAYG**. They are separate counters with separate
wallets; a read of one says nothing about the other.

### Provenance — the tab set moves

The catalogue is the single source of *what each console answers*, not of *what
was open at some past instant*. The user opens and closes tabs; a URL recorded
once and printed later can land the next session on a page with no session, which
reads as a dead plan. Every entry therefore carries a `provenance` (`vu` in
`list`): `verbatim tab-NN, <instant>` = read off that live tab at that instant,
`jamais observé` = a standard console path still to confirm. **Re-verify an entry
whose provenance is old before reopening it**, and correct it here rather than
inheriting a stale link.

## Readings live elsewhere

Levels — balances, percentages, reset anchors — **never go in this file**: they
expire the moment they are written and eight-day-old numbers get read as current.
They accumulate in `~/.claudish/console-readings.jsonl` (machine-local) and are
reported on the fleet dashboard. What belongs here are the **structural** facts
that do not move: Mistral's API allowance is monthly and included in the Pro plan;
Qwen's Token Plan is a monthly window; Kimi carries two windows (5 h and 7 d); the
Anthropic account carries a monthly PAYG credit distinct from the claude.ai plan.

## Why this matters to the cascade

A wall in a console is not the same event as a wall in the proxy log. Three
distinctions that changed a diagnosis on 2026-11-02:

1. **A rate limit is not a quota.** `1302` ("rate limit reached for requests")
   clears in seconds and *still* arms a 20-40 minute bucket wall, because two
   consecutive qualifying refusals arm the SONNET bucket
   (`CLAUDISH_FAILOVER_ARM_AFTER`, default 2). The console shows the 5 h quota
   still refilling while the lane is benched — the cost is ours, not theirs.
2. **A budget is not a rate limit.** Mistral's `402 API budget exhausted` is a
   **prepaid allowance inside the subscription**, monthly, not a 5 h window. It
   cannot be waited out; only the calendar closes it.
3. **A 7-day window is not a 5-hour window.** Kimi's 5 h sits at 0 % while the
   7-day sits at 100 %: the step is refused for days, and a 5 h reading alone
   would wrongly call it healthy.

Reading rule that follows: **never infer a wall's shape from its status code
alone.** Read the console for the window that produced it, and record the reset
anchor with the percentage.

## Adding a console

Append one entry to `CONSOLES` in `scripts/console-tabs.py` (`id`, `name`, `url`,
`role`, `auth`, `fields`, `provenance`, and `todo: True` while unauthenticated).
`provenance` is mandatory in practice: say which tab you read it off and when, or
write `jamais observé`. No other file needs to change; `list` and `urls` pick it up.
