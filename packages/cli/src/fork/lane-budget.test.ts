/**
 * #1055 g2 — module-level pins for the harness-lane budget + emergency stop.
 * Route wiring is pinned separately (proxy-server-lane-budget-route.test.ts);
 * these pin the instrument itself: parse grammar, refusal wording (the
 * isQuotaExhaustion contract), stop-file lane isolation, the attempt ledger.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitLaneBudget,
  laneBudgetConsumed,
  openLaneBudgetAttempt,
  parseLaneBudgets,
  recordLaneBudgetOutput,
  resetLaneBudgetForTests,
  sanitizeLane,
  setLaneBudgetClockForTests,
} from "./lane-budget.js";
import { isQuotaExhaustion } from "./failover.js";

const ENV = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  ...over,
} as NodeJS.ProcessEnv);

describe("lane-budget (#1055 g2)", () => {
  beforeEach(() => {
    resetLaneBudgetForTests();
    setLaneBudgetClockForTests();
  });

  it("parses the flat grammar: per-model bars, lane-wide defaults, malformed skipped", () => {
    const b = parseLaneBudgets(
      "nb-coder/nb-minimax:500000, nb-coder:1000000 , bad-entry, other/zero:0, x/y:-5"
    );
    expect(b.perModel.get("nb-coder|nb-minimax")).toBe(500000);
    expect(b.laneWide.get("nb-coder")).toBe(1000000);
    expect(b.perModel.size).toBe(1);
    expect(b.laneWide.size).toBe(1);
    // Cached by raw value: the same string returns the same parse, a different
    // one re-parses (tests set different budgets per test).
    const again = parseLaneBudgets("nb-coder/nb-minimax:500000, nb-coder:1000000 , bad-entry, other/zero:0, x/y:-5");
    expect(again).toBe(b);
    expect(parseLaneBudgets("nb-coder:7").laneWide.get("nb-coder")).toBe(7);
  });

  it("no lane header → null admission, zero work (pre-#1055 path)", () => {
    const env = ENV({ CLAUDISH_LANE_BUDGETS: "nb-coder:1" });
    expect(admitLaneBudget(null, "nb-minimax", env)).toBeNull();
    expect(admitLaneBudget("", "nb-minimax", env)).toBeNull();
    // A hostile lane name sanitizes to the same alphabet as the envelope field.
    expect(sanitizeLane('  evil"lane,<script>zzz')).toMatch(/^[a-zA-Z0-9._-]{1,64}$/);
  });

  it("a lane without a bar serves (armed lanes only)", () => {
    const env = ENV({ CLAUDISH_LANE_BUDGETS: "nb-coder:100" });
    expect(admitLaneBudget("other-lane", "m", env)).toBeNull();
  });

  it("over the bar → typed refusal, wording NEVER arms isQuotaExhaustion (pin)", async () => {
    const env = ENV({ CLAUDISH_LANE_BUDGETS: "nb-coder/nb-minimax:500" });
    // Feed the ledger: one attempt, terminal usage 600.
    let clock = 1_000_000;
    setLaneBudgetClockForTests(() => clock);
    const raw = {};
    openLaneBudgetAttempt(raw, "nb-coder", "nb-minimax", env);
    recordLaneBudgetOutput(raw, 600);
    expect(laneBudgetConsumed("nb-coder", "nb-minimax")).toBe(600);

    const adm = admitLaneBudget("nb-coder", "nb-minimax", env);
    expect(adm?.refused).toBe(true);
    expect(adm?.type).toBe("budget");
    expect(adm?.retryAfterSec).toBeGreaterThan(0);
    // The #317 wording contract, against the REAL predicate.
    expect(isQuotaExhaustion(429, adm!.message)).toBe(false);
  });

  it("two paid attempts of one request land in TWO slots — sum, not max", () => {
    const env = ENV({ CLAUDISH_LANE_BUDGETS: "nb-coder:1000" });
    setLaneBudgetClockForTests(() => 1_000_000);
    const raw = {};
    // Attempt 1 pays 400, then the cascade retries: FRESH token, pays 350.
    openLaneBudgetAttempt(raw, "nb-coder", "nb-minimax", env);
    recordLaneBudgetOutput(raw, 400);
    openLaneBudgetAttempt(raw, "nb-coder", "nb-minimax", env);
    recordLaneBudgetOutput(raw, 350);
    expect(laneBudgetConsumed("nb-coder", "nb-minimax")).toBe(750);
  });

  it("the model half of the key isolates counters (per-day per-model)", () => {
    const env = ENV({ CLAUDISH_LANE_BUDGETS: "nb-coder:1000" });
    setLaneBudgetClockForTests(() => 1_000_000);
    const rawA = {};
    openLaneBudgetAttempt(rawA, "nb-coder", "nb-minimax", env);
    recordLaneBudgetOutput(rawA, 300);
    const rawB = {};
    openLaneBudgetAttempt(rawB, "nb-coder", "haiku-x", env);
    recordLaneBudgetOutput(rawB, 500);
    expect(laneBudgetConsumed("nb-coder", "nb-minimax")).toBe(300);
    expect(laneBudgetConsumed("nb-coder", "haiku-x")).toBe(500);
  });

  it("the window slides: sealed events older than 24h stop counting", () => {
    const env = ENV({ CLAUDISH_LANE_BUDGETS: "nb-coder:400" });
    let clock = 1_000_000;
    setLaneBudgetClockForTests(() => clock);
    const raw = {};
    openLaneBudgetAttempt(raw, "nb-coder", "m", env);
    recordLaneBudgetOutput(raw, 500);
    // Settle the attempt (seal) — advance past ATTEMPT_SETTLE, then trigger
    // maintain via an admission.
    clock += 16 * 60 * 1000;
    const admSealed = admitLaneBudget("nb-coder", "m", env);
    expect(admSealed?.refused).toBe(true); // 500 >= 400 inside the window
    // Now the whole event is older than the 24h window → it stops counting.
    clock += 25 * 60 * 60 * 1000;
    expect(admitLaneBudget("nb-coder", "m", env)).toBeNull();
  });

  it("emergency stop file: immediate typed refusal for THAT lane only", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-stop-"));
    try {
      const env = ENV({ CLAUDISH_LANE_STOP_DIR: dir });
      writeFileSync(join(dir, "nb-coder"), "");
      const adm = admitLaneBudget("nb-coder", "nb-minimax", env);
      expect(adm?.refused).toBe(true);
      expect(adm?.type).toBe("stop");
      expect(isQuotaExhaustion(429, adm!.message)).toBe(false);
      // Lane isolation — the AC3 pin: other lanes untouched.
      expect(admitLaneBudget("other-lane", "nb-minimax", env)).toBeNull();
      // No stop dir configured → the file (if any) is irrelevant.
      expect(admitLaneBudget("nb-coder", "nb-minimax", ENV())).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the stop wins over an under-bar budget (checked first)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-stop-"));
    try {
      const env = ENV({ CLAUDISH_LANE_STOP_DIR: dir, CLAUDISH_LANE_BUDGETS: "nb-coder:100000" });
      writeFileSync(join(dir, "nb-coder"), "");
      const adm = admitLaneBudget("nb-coder", "nb-minimax", env);
      expect(adm?.type).toBe("stop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
