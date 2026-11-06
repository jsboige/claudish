# #867 AC3 — measurement protocol (ready, WAIT_FOR deploy)

Status: **protocol ready, blocked on deploy** (grain v45-6). AC2 (PR #898) added
the per-flip line this protocol greps. AC3 cannot run until #898 is deployed on
a live sidecar and that sidecar has flipped ≥ 10 times. `WAIT_FOR deploy` →
`RESUME_WHEN the sidecar image carries #898 and ≥10 NOMINAL flips are logged`.

## What AC3 asks

Median RECOVERED→NOMINAL over ≥ 10 real flips on a live sidecar, expected
**≤ 70 s** (cooldown floor ~61–66 s + margin), against the **83 s** median the
issue measured by hand on po-2027. The number is the queue the AC2 line now
prints per flip — no more hand re-assembly.

## The line AC3 reads (post-#898)

```
[Relay] upstream http://… healthy again → NOMINAL (relay resumed) — queue RECOVERED→NOMINAL 83.2s = wait 70.9s (cooldown floor 60s) + probe 12.3s [<model> <ms>ms fail (…); <model> <ms>ms ok]
```

- `queue` = the full RECOVERED→NOMINAL wait, in seconds, one decimal.
- `wait` = cooldown gate + tick alignment (the part AC3's ≤ 70 s bound targets).
- `probe` = the deep-probe latency, per attempt.
- A flip that had no RECOVERED stamp (jump-straight-to-autonomous) prints only
  `— probe …` and is **excluded** from the median (it never queued).

## Procedure (once deployed)

1. **Confirm the deploy carries #898.** On the sidecar, the line above appears
   only with #898. `docker logs claudish-sidecar 2>&1 | grep -m1 'queue RECOVERED→NOMINAL'`
   present ⇒ instrumented. Absent after a known flip ⇒ not yet deployed; stay
   WAIT_FOR.

2. **Collect the flips.** Grep the per-flip queue value, one per NOMINAL flip:
   ```bash
   docker logs -t claudish-sidecar 2>&1 \
     | grep 'queue RECOVERED→NOMINAL' \
     | grep -oE 'queue RECOVERED→NOMINAL [0-9]+\.[0-9]+s' \
     | grep -oE '[0-9]+\.[0-9]+'
   ```
   ⚠ Instrument traps, per memory: use **timestamp filtering** (`docker logs -t`
   + awk), not `--since` (truncates the tail on some hosts); the sidecar
   container is `claudish-sidecar`, not `claudish-proxy`. A NOMINAL sidecar
   relays, so flips are rare in steady state — the ≥ 10 sample may span days.
   Do NOT manufacture flips by restarting the hub: a drain-restart is a stream
   killer and would poison the very wait being measured.

3. **Median.** Sort the values, take the median (≥ 10 values). Report:
   - median RECOVERED→NOMINAL, n, min, max;
   - the `wait` vs `probe` split (grep the `wait …s` and `+ probe …s` fields the
     same way) — if the median exceeds 70 s, the split says whether the cooldown
     gate (wait) or the deep probe (probe) is the cause;
   - verdict: median ≤ 70 s ⇒ AC3 met; else AC3 fails and the split localizes
     the regression.

4. **Before/after.** The "before" is the issue's hand-measured 83 s on po-2027.
   The "after" is step 3's median on the same sidecar model. Same-machine
   comparison only — cooldown floor and tick alignment are machine-independent,
   but the probe latency is provider-dependent, so cross-machine medians are not
   comparable.

## Exclusions and honesty

- Flips printing only `— probe …` (no RECOVERED stamp) are excluded — they never
  queued (the AC2 degrade path).
- A flip during a fleet-announced hub outage is still a valid sample (the queue
  is what it is), but note it: a long hub-down inflates `wait` beyond the
  cooldown floor by design. Report such outliers separately rather than silently
  dropping them.
- AC4 (no extra fetch per tick) is independently pinned by the existing
  `sends exactly TWO requests when both attempts fail` test — this protocol does
  not re-measure it.

## Handoff

`WAIT_FOR deploy` — this lane does not deploy (no infra gestures in scope).
When #898 is live on a sidecar and ≥ 10 flips are logged, run steps 1–4 and post
the median + split to #867. Until then the grain stays blocked, not abandoned.
