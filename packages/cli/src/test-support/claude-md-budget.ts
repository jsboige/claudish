/**
 * #445 A2 — the `CLAUDE.md` byte budget, as one shared decision.
 *
 * The always-loaded decision layer is paid on every turn (size × turns), so it
 * holds DECISIONS and nothing else; measurements and incident narratives live
 * in `docs/reference/<theme>.md` behind the pointer table at the top.
 *
 * A budget nobody checks is a wish, so `harness-budget.test.ts` checks it — this
 * module owns the number and the two operations the check needs, so the
 * boundary can be pinned (one byte over is refused, exactly at the budget is
 * accepted) instead of being an untested constant.
 *
 * The size is measured as COMMITTED (LF), not as checked out: under
 * core.autocrlf=true a Windows working copy carries one extra byte per line,
 * which would make the verdict depend on the machine running the suite.
 */

/**
 * 40 960 B — the #445 A1/A2 budget, i.e. exactly 40 KiB.
 *
 * The gate used to read `40 * 1024 + 960` = 41 920 B, i.e. 960 B LOOSER than the
 * epic's criterion ("≤ 40 960 octets", and A2's "test rouge à 40 961 octets").
 * The 960 B headroom was never a decision, it was an off-by-960 in the constant:
 * with it, `main` sat at 42 211 B — over even the loose budget — and the file
 * grew back because the gate had drifted from the criterion it was written for.
 * The boundary is now the epic's: at 40 960 is fine, 40 961 is refused.
 */
export const CLAUDE_MD_BUDGET_BYTES = 40 * 1024;

/** Bytes of a file's text, line-ending independent (CRLF counts as LF). */
export function measureBudgetedBytes(raw: string): number {
  return Buffer.byteLength(raw.replace(/\r\n/g, "\n"), "utf-8");
}

/** The gate itself: at the budget is fine, one byte over is not. */
export function withinClaudeMdBudget(
  size: number,
  budget: number = CLAUDE_MD_BUDGET_BYTES
): boolean {
  return size <= budget;
}

/**
 * The failure text an author sees — it must say WHERE the detail goes, or the
 * fix is "delete something", which is how the file grew back in the first place.
 */
export function claudeMdBudgetMessage(
  size: number,
  budget: number = CLAUDE_MD_BUDGET_BYTES
): string {
  const over = size - budget;
  if (over <= 0) {
    return `CLAUDE.md is ${size} B, within its ${budget} B budget.`;
  }
  return `CLAUDE.md is ${size} B, over its ${budget} B budget (+${over}). It is loaded on every turn: move the measurements / incident narrative / history into docs/reference/<theme>.md (see the pointer table at the top of CLAUDE.md) and leave a one-line pointer. Raising the budget is a #445 decision, not a fix.`;
}
