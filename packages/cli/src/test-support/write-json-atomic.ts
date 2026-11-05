import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";

/**
 * #831 — the WRITE side of "a JSON file another process will read".
 *
 * `waitForJson` (./wait-for-json.ts) makes a reader survive a writer that has not
 * finished: it reads AND parses until both hold. That is the net. This is the cure —
 * a writer that never exposes a half-written file, so `existsSync` becomes a
 * sufficient condition again and no reader has to poll.
 *
 * Measured cause, kept because it is the reason this file exists: `existsSync` proves
 * the directory entry exists, not that the bytes landed. A loaded macOS CI leg read a
 * probe between create and flush and died on `JSON.parse: Unexpected EOF` at 416 ms —
 * fast, so not a timeout: an empty file that existed. `writeFileSync` writes in place.
 *
 * The shape is the one `auth/credential-file.ts` already uses for the credentials:
 * write a sibling temp file, fsync, then rename onto the destination. Rename is atomic
 * on APFS, NTFS and ext4, so a reader opens either the old file or the new one.
 *
 * Two properties a caller may rely on, both pinned in the test beside this file:
 *   - the temp file lives in the SAME directory as the destination, so the rename
 *     never crosses a filesystem boundary (a cross-device rename throws EXDEV);
 *   - a value that cannot be serialised throws BEFORE the destination is touched, so
 *     a failed write leaves the previous content intact rather than emptying it.
 *
 * Test-support only: it is imported by the fake child (`pane/test-helpers/`) whose
 * probes the session suites read back.
 */
export function writeJsonAtomic(path: string, value: unknown, indent: number | string = 1): void {
  // Serialise first: a circular value or a BigInt must fail with the old file intact.
  const text = JSON.stringify(value, null, indent);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const fd = openSync(tmp, "wx", 0o666);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never created, or already renamed by a successful attempt.
    }
    throw error;
  }
}
