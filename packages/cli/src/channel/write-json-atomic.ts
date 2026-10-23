// Atomic JSON file writes: serialize first, write a temp file in the same
// directory, then rename over the target — a concurrent reader never sees a
// half-written file (an external monitor polls session meta.json while the
// session is live). Port of upstream 9aef742c, which relies on a helper this
// fork did not have.

import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function writeJsonAtomic(filePath: string, value: unknown): void {
  // Serialize before touching the filesystem: a serialization failure must
  // leave any pre-existing target intact.
  const data = JSON.stringify(value, null, 2);
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort: the tmp file may never have been created
    }
    throw err;
  }
}
