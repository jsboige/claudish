# Workload routing — route by `agent-sdk` vs interactive, not by machine (design spec, unarbitrated)

**Status: design proposal, no code.** Dispatched by ai-01 (QUEUE v6, grain 2) to resolve the
Q-31 impasse: the 25/10 user arbitration ("ai-01 = MiniMax, never swift") is machine-level,
while the measurement ("ai-01 = 66 % of MiniMax, of which **52 % is `agent-sdk` planned
work**") shows the burn driver is a *workload*, not the machine. This spec defines routing
on that workload. It composes with the haiku→swift unlock design (`docs/reference/haiku-swift-debrayage.md`,
PR #704): it is the **mechanism inside that design's W door** — lifting the ai-01 exclusion
safely, one workload at a time.

## (a) The signal — verified in code, not invented

The hub already sees the workload marker **in the request body**, today, and an instrument
already classifies on it:

- Claude Code embeds attribution fields in the request's system block (`cc_entrypoint=…`,
  `cc_workload=…` — billing-attribution markers, #98).
- `scripts/traffic-consumption.py` (`BILLING_EP` / `BILLING_WL` regexes, `bucket_of()` at
  ~l.180) buckets every captured request into **cron / interactive / agent-sdk / other**:
  `wl == "cron"` → cron; `ep.startswith("sdk")` → agent-sdk; any other non-empty `ep` →
  interactive. The ai-01 census figure ("52 % agent-sdk") comes from these buckets.
- The proxy itself reads body state at the routing seam today (inline-`role:"system"`
  stripping, workspace attribution, the #565 admission census) — parsing two more markers
  there adds no new class of work.

**Chosen predicate**: exactly the census predicate (`cc_entrypoint` starts with `sdk` →
`agent-sdk`; `cc_workload=cron` → `cron`; else `interactive`). One predicate shared by
instrument and router — if the census re-buckets, the router follows, and the "52 %"
figure stays commensurable with what the route actually diverts.

Rejected alternatives, measured against the same corpus: the **User-Agent**
(`claude-cli/2.1.310`, `claude-vscode/…`) is captured on the `[Request]` stdout line but is
*client-shell*, not workload — an interactive `claude` and a scheduled agent-sdk run can
carry the same UA family. `cc_is_subagent` marks sub-agents, a different dimension: planned
work is often the *main* agent of its session. Neither distinguishes what the census counts.

## (b) Where the rule sits

- **Not `modelMap`/`routing` config**: keyed by model name; workload is orthogonal to model.
- **Not a failover cascade step**: the cascade is *failure*-driven; a workload preference is
  not a failure and must not write failure state (no `markStepFailed`, no wall, no backoff).
- **Yes: a per-request substitution at nominal resolution**, the same seam as
  `resolveNativeModelPin()` inside `handleWithCascade`'s loop (per-attempt re-resolution,
  request state in scope, kill-switch-shaped):
  - `resolveWorkloadRoute(role, body)` returns an override target only when an armed mapping
    matches; otherwise nominal resolution is untouched.
  - Arming (config): `routing.workload = { "haiku:agent-sdk": "swift@swift-1.5-27b" }`
    (plus the usual env override for fleet rollout). **Unset = inert**, same doctrine as
    budget failover: configuring a target does not activate it.
  - Every substitution announces through the existing centralized notice channel
    (`applyFailoverNotices`, facts-not-instructions wording) — an agent-sdk session on ai-01
    must be able to *see* it was served by swift.
  - Kill switch `CLAUDISH_WORKLOAD_ROUTE=0`, read per request.

**Composability with #693 `STEP_EXCLUDE`** — the load-bearing constraint. Today ai-01's
haiku is kept away from swift by a machine-wide step exclusion. If workload routing lands
*without* touching that exclusion, the two rules fight: the exclude subtracts swift from
ai-01's cascade walks regardless of workload. The exclusion predicate and the route
predicate must become **the same vocabulary**: an exclusion entry narrows from
`<step>:<machine>` to `<step>:<machine>[workload=interactive]` — i.e. "interactive ai-01
never reaches swift; agent-sdk ai-01 may, when the route is armed". Machine-wide exclusion
remains expressible (no workload clause = all workloads), so no existing fleet pose changes
semantics on landing.

## (c) What changes for the 25/10 arbitration

Nothing automatic. The arbitration said: on ai-01, MiniMax, never swift — a machine-level
rule drawn with a machine-level instrument. This spec asks the user to **refine** it:
*interactive* ai-01 stays MiniMax (unchanged); *planned agent-sdk* work on ai-01 may use
swift when the #704 R door (engine reliability) has passed and the route is armed. Lane
recommendation: refine, because it serves the arbitration's measured intent (stop planned
burn from eating MiniMax) without touching what the user actually sits at. **Worker lanes
never arm it** — same doctrine as `CLAUDISH_SESSION_BUDGET_CEILING`.

## (d) The pin that proves it

One test file, three requests against a locally-armed route, machine header `myia-ai-01`:

1. body with `cc_entrypoint=sdkCli` in the system block, model `claude-haiku-*` →
   **target resolves to swift**, and the notice was emitted;
2. same body **without** the marker (interactive) → **MiniMax**, no notice;
3. interactive body + machine-wide STEP_EXCLUDE still armed → **swift unreachable**
   (exclusion semantics unchanged when un-narrowed).

Plus a vocabulary pin: `bucket_of()`'s predicate and the router's predicate are asserted
equal (same source of truth import or a shared fixture) — the census and the route can
never silently disagree about what "agent-sdk" means.

## Costs and risks

- Route-time body read: none new (body already parsed at the seam).
- Marker spoofing: client-controlled string; it steers a *preference*, not auth — a spoofed
  marker gets the spoofer's own session onto swift. Acceptable; note it in the doc when
  implemented.
- Engine pressure: the #704 R door (ECONNRESET/hairpin fixed, capacity measured) gates any
  arming — this spec does not bypass it.

**Trigger conditions** (ROADMAP): (1) user refines the 25/10 arbitration to
workload-level; (2) #704 porte R passed. Either alone parks the item.
