/**
 * NativeAnthropicCredentialProvider — credential authority for the native Claude
 * Code pass-through.
 *
 * The native path normally carries the user's OWN inbound auth header (Claude
 * Code's session), which the NativeHandler prefers. This provider supplies the
 * FALLBACK credential (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN) for when no
 * inbound auth is present — resolved through the single layer (env → config →
 * op://) so even the native fallback no longer reads process.env directly.
 */

import { getApiKey } from "../../profile-config.js";
import { hasOpSources, resolveOpKeyForEnvVars } from "./op-source.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export class NativeAnthropicCredentialProvider implements CredentialProvider {
  readonly catalogName = "native-anthropic";
  private cachedKey: string | undefined;

  invalidate(): void {
    this.cachedKey = undefined;
  }

  /** Resolve ANTHROPIC_API_KEY: env → config → op:// (lazy SDK). */
  private async resolveKey(): Promise<string> {
    if (this.cachedKey !== undefined) return this.cachedKey;
    const local =
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      getApiKey("ANTHROPIC_API_KEY");
    if (local) {
      this.cachedKey = local;
      return local;
    }
    if (hasOpSources()) {
      const r = await resolveOpKeyForEnvVars(new Set(["ANTHROPIC_API_KEY"]), {
        onAuthFailure: "skip",
      });
      const v = r.ANTHROPIC_API_KEY;
      if (v) {
        process.env.ANTHROPIC_API_KEY = v; // write-through mirror
        this.cachedKey = v;
        return v;
        // (not cached as "" on a transient miss — see ApiKeyCredentialProvider)
      }
      return "";
    }
    this.cachedKey = "";
    return "";
  }

  async isAvailable(): Promise<boolean> {
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
    return !!(await this.resolveKey());
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    const key = await this.resolveKey();
    if (!key) return { headers: {} };
    // #641 step 4 — shape the header here, main's swap predicate verbatim: an
    // OAuth token (sk-ant-oat*, the ANTHROPIC_AUTH_TOKEN case — exactly what
    // this provider resolves as a fallback) signs with `authorization: Bearer`,
    // an API key with `x-api-key`. Emitting x-api-key unconditionally put OAuth
    // tokens on the wrong header name at every consumer of this authority
    // (main's equivalent swap sites have been shape-aware since #282/#439).
    // The scheme decision lives in the authority, per the centralization rule
    // at the top of api-key-credential.ts — consumers must not re-inline it.
    if (key.startsWith("sk-ant-oat")) {
      return { headers: { authorization: `Bearer ${key}` } };
    }
    return { headers: { "x-api-key": key } };
  }
}
