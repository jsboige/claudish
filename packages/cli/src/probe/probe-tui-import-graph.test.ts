/**
 * Pin for #386 — `cli.ts` must reach the probe TUI *lazily*.
 *
 * Measured defect (po-204, bun 1.3.14, main `6f732eb9`): under `bun test
 * --isolate`, a module whose scope reads a namespace produced by a dynamic
 * `import()` inside its own top-level await throws
 * `ReferenceError: Cannot access 'default' before initialization` *during its
 * own evaluation*. `@opentui/core` does exactly that (`zig.ts`:
 * `const module = await import(clipath); let targetLibPath = module.default`),
 * so any file whose static graph reaches it dies at load.
 *
 * `cli.ts` used to `import { startProbeTui } from "./probe/probe-tui-runtime.js"`
 * at module scope, which dragged `@opentui/core` into the load of every test
 * importing `cli.ts` — `cli.test.ts`, `cli-passthrough.test.ts`,
 * `handlers/native-handler-advisor.test.ts`, three permanent `load error`
 * entries in the strict baseline. Deferring the edge to the call site fixed all
 * three (0 pass/1 error → 26, 22, 40 pass under `--isolate`).
 *
 * Import ORDER was measured to be irrelevant (core-first and react-first both
 * fail; a bare `import "@opentui/core"` fails alone), so this pin guards
 * *reachability*, not ordering — the only lever that worked.
 *
 * The controls below keep the pin honest: a green line here must mean the
 * detector still matches a positive, not that a regex quietly stopped matching.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

const SRC = dirname(import.meta.dir); // packages/cli/src
const CLI = join(SRC, "cli.ts");
const RUNTIME = join(SRC, "probe", "probe-tui-runtime.tsx");

/** a static `import ... from "<specifier>"` (side-effect form included) */
const staticImportOf = (spec: string): RegExp =>
  new RegExp(String.raw`^\s*import\s+(?:[^'"\n]*?\s+from\s+)?["']${spec}["']`, "m");

const lazyImportOf = (spec: string): RegExp =>
  new RegExp(String.raw`await\s+import\(\s*["']${spec}["']\s*\)`);

/** every .ts/.tsx under packages/cli/src (tests excluded — they may load it on purpose) */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules") continue;
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

describe("Regression: #386 cli.ts reaches the probe TUI lazily", () => {
  test("premise control: probe-tui-runtime really pulls @opentui/core", () => {
    // If this ever stops holding, the pin below guards nothing — fail loudly
    // rather than let a vacuous green stand in for a real one.
    const runtime = readFileSync(RUNTIME, "utf-8");
    expect(runtime).toMatch(/from\s+["']@opentui\/core["']/);
  });

  test("detector control: the static-import regex matches a positive", () => {
    const synthetic = `import { startProbeTui } from "./probe/probe-tui-runtime.js";\n`;
    expect(staticImportOf("\\./probe/probe-tui-runtime[^\"']*").test(synthetic)).toBe(true);
  });

  test("cli.ts carries NO static import of the probe TUI runtime", () => {
    const cli = readFileSync(CLI, "utf-8");
    expect(staticImportOf(String.raw`\./probe/probe-tui-runtime[^"']*`).test(cli)).toBe(false);
  });

  test("cli.ts reaches it through a dynamic import at the call site", () => {
    const cli = readFileSync(CLI, "utf-8");
    expect(lazyImportOf(String.raw`\./probe/probe-tui-runtime[^"']*`).test(cli)).toBe(true);
  });

  test("no non-test module statically imports the probe TUI runtime", () => {
    const offenders = sourceFiles(SRC).filter((f) =>
      staticImportOf(String.raw`[^"']*probe-tui-runtime[^"']*`).test(readFileSync(f, "utf-8")),
    );
    expect(offenders).toEqual([]);
  });
});
