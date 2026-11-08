import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Shared port-claim scan (#791) — the single authority on which loopback ports
 * are already claimed by sibling in-process test suites.
 *
 * `port-allocation.test.ts` enforces the one-allocation-per-file convention with
 * this scan (the hand-kept "reserved elsewhere" lists in individual suites
 * drifted and missed two live collisions — measured 03/11 on 19921). A suite
 * that draws ports RANDOMLY inside a span (#630 shutdown-socket,
 * `19860 + random*120`) overlaps those point claims without ever declaring them,
 * which the duplicate check cannot see: CI run 42224660315 caught exactly that
 * (`nextPort()` landed on 19863, claimed by proxy-server-cascade-revisit).
 *
 * So the same scan now also feeds the draw: `declaredPortClaims(excludeFile)`
 * returns every port declared by a `const <…PORT…> = <4-5 digits>` in OTHER test
 * files, and a random draw must skip them (plus anything currently bound).
 *
 * Kept in `test-support/` (not inside the pin file) precisely so runtime code
 * and the pin share ONE regex — two copies would drift the same way the
 * hand-lists did.
 */

const SRC_ROOT = join(import.meta.dir, "..");
const PORT_DECL = /^\s*(?:const|let)\s+([A-Za-z_]*[Pp][Oo][Rr][Tt][A-Za-z_]*)\s*=\s*(\d{4,5})\b/gm;

export interface PortDeclaration {
  file: string;
  name: string;
  port: number;
}

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Every port-shaped const declaration in `*.test.ts` files (comments are
 * ignored by the regex — several suites document their neighbours in prose).
 * `excludeFile`, when given, is a relative path (forward slashes) whose OWN
 * declarations are skipped — a suite drawing from a span must not exclude its
 * own base port.
 */
export function declaredPortRows(excludeFile?: string): PortDeclaration[] {
  const rows: PortDeclaration[] = [];
  for (const file of collectTestFiles(SRC_ROOT)) {
    const rel = file
      .slice(SRC_ROOT.length + 1)
      .split(sep)
      .join("/");
    if (excludeFile !== undefined && rel === excludeFile) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(PORT_DECL)) {
      rows.push({ file: rel, name: match[1]!, port: Number(match[2]!) });
    }
  }
  return rows;
}

/** Port-only view of {@link declaredPortRows} — what a random draw must skip. */
export function declaredPortClaims(excludeFile: string): Set<number> {
  return new Set(declaredPortRows(excludeFile).map((row) => row.port));
}
