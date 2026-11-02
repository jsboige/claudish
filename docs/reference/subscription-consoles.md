# Subscription consoles — the wall ledger

The cascade is driven by other people's quota walls. A wall is only legible from
the provider's own console: the proxy sees the *refusal*, never the remaining
budget or the reset anchor. This file is the inventory of those consoles, the
instrument to read them, and the first reading that makes the fleet's real
headroom visible.

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
| `anthropic-payg` | console.anthropic.com/settings/billing | **PAYG API**, distinct from the claude.ai plan | *to authenticate* |
| `openai-payg` | platform.openai.com/usage | **PAYG API**, distinct from the chatgpt weekly plan | *to authenticate* |

⚠ Two pairs are easy to conflate: **claude.ai plan ≠ Anthropic PAYG**, and
**chatgpt weekly plan ≠ OpenAI PAYG**. They are separate counters with separate
wallets; a read of one says nothing about the other.

## First readings — 2026-11-02 ~14:35 local

Baseline recorded the day the consoles were opened. Keep corrections in the
readings log, not here.

| console | reading | consequence |
|---|---|---|
| z.ai Coding Plan | **5 h quota 100 % used**, MCP 0 %, **3 resets available, unused** | the sonnet nominal is dry *right now* — matches 0 `glm-5.3` served since 11h UTC |
| z.ai usage | 7 days: 17.87 B tokens, GLM-5.3 = 17.84 B, cache hit 97.1 %, off-peak 93.8 % | the plan is used as long-context bulk, not as chat |
| Kimi | **7 days 100 %**, 5 h 0 %, 7 d resets **02/11 21:08** | the free step returns tonight; total plan use 47.09 % |
| Qwen Token Plan | **monthly remaining 0.0 %**, reset **11/11 17:00 local**, plan quota 180 000 | dead until 11/11 — no lever here |
| Mistral | Pro, **25,5 €/month of API included**, reset in 28 days (monthly, 1st) | explains the `402 API budget exhausted` on `mistral@zai-glm-5-3` |
| DeepSeek PAYG | balance **$181.07**, **$600.33 last 30 days**, 340 646 requests, 58.06 B tokens | the invoice to defend — ≈ $20/day |
| claude.ai | warning: **limit reached Thursday evening, before the Friday 02:00 reset** | the interactive seats are on course to stall ~1 day early |
| Codex | **4 % left**, resets in 2 d 4 h | Codex capacity is effectively gone until then |
| Copilot | **19 / 1 500 credits**, resets 2026-12-01 | 1 481 credits idle — the one unused reservoir |

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
`role`, `auth`, `fields`, and `todo: True` while unauthenticated). No other file
needs to change; `list` and `urls` pick it up.
