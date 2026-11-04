import { readFileSync } from "node:fs";

/**
 * #831 — reads a JSON file another process may still be writing.
 *
 * `existsSync` proves the directory entry exists, not that the writer finished:
 * between create and flush the file reads as "" or as a prefix, and `JSON.parse`
 * throws `Unexpected EOF` — measured live on the macOS CI leg, where a loaded
 * runner loses that race in ~416 ms while the quieter OSes never do. This poll
 * reads AND parses, so existence and completeness become the same condition.
 * On deadline it fails with the size and the head of what it saw — the evidence
 * a bare SyntaxError never carried.
 */
export function waitForJson<T = unknown>(
  path: string,
  timeoutMs = 10_000,
  intervalMs = 20
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const attempt = (resolve: (value: T) => void, reject: (error: Error) => void): void => {
    let text = "";
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      // Absent — the writer has not created it yet; keep waiting.
    }
    try {
      resolve(JSON.parse(text) as T);
    } catch (error) {
      if (Date.now() >= deadline) {
        reject(
          new Error(
            `waitForJson: ${path} never parsed within ${timeoutMs} ms — ` +
              `${text.length} chars, head=${JSON.stringify(text.slice(0, 120))}, ` +
              `last error: ${(error as Error).message}`
          )
        );
        return;
      }
      setTimeout(() => attempt(resolve, reject), intervalMs);
    }
  };
  return new Promise<T>((resolve, reject) => attempt(resolve, reject));
}

/**
 * #831 — the text counterpart, for files with no parse to lean on: settle on
 * the substrings the caller actually asserts, so "the log says it" and "the
 * log has been written" are the same wait instead of two adjacent guesses.
 */
export function waitForTextContaining(
  path: string,
  substrings: readonly string[],
  timeoutMs = 10_000,
  intervalMs = 20
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const attempt = (resolve: (value: string) => void, reject: (error: Error) => void): void => {
    let text = "";
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      // Absent — keep waiting.
    }
    const missing = substrings.filter((needle) => !text.includes(needle));
    if (missing.length === 0) {
      resolve(text);
      return;
    }
    if (Date.now() >= deadline) {
      reject(
        new Error(
          `waitForTextContaining: ${path} still missing ${missing.length} substring(s) ` +
            `after ${timeoutMs} ms — ${text.length} chars, first missing: ${JSON.stringify(
              missing[0]
            )}`
        )
      );
      return;
    }
    setTimeout(() => attempt(resolve, reject), intervalMs);
  };
  return new Promise<string>((resolve, reject) => attempt(resolve, reject));
}
