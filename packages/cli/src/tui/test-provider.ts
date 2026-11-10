/**
 * Provider API key tester for the TUI.
 *
 * Makes a minimal, lightweight API call to verify that a configured key is
 * valid and the endpoint is reachable. Each provider type uses the most
 * appropriate endpoint to minimise latency and cost:
 *
 *  - openai-compatible   → GET/POST {baseUrl}/v1/models  (list models)
 *  - anthropic-compatible → POST {baseUrl}/anthropic/v1/messages (minimal body)
 *  - gemini               → GET {baseUrl}/v1beta/models?key={key}
 *  - ollamacloud          → GET {baseUrl}/api/tags  (with auth header)
 */

import { getAllProviders, type ProviderDefinition } from "../providers/provider-definitions.js";

export type TestResult =
  | "valid"
  | `invalid (HTTP ${number})`
  | "timeout"
  | `error: ${string}`
  | "no key configured"
  | "unsupported provider";

const TIMEOUT_MS = 10_000;

/**
 * Resolve the effective base URL for a provider, respecting env-var overrides.
 */
function resolveBaseUrl(def: ProviderDefinition): string {
  if (def.baseUrlEnvVars) {
    for (const envVar of def.baseUrlEnvVars) {
      const val = process.env[envVar];
      if (val) return val.replace(/\/$/, "");
    }
  }
  return def.baseUrl.replace(/\/$/, "");
}

/**
 * Detect the API "family" for a provider based on its transport type.
 */
type ApiFamily = "openai" | "anthropic" | "gemini" | "ollamacloud" | "unsupported";

function getApiFamily(def: ProviderDefinition): ApiFamily {
  switch (def.transport) {
    case "openai":
    case "openrouter":
    case "litellm":
    case "kimi-coding":
      return "openai";
    case "anthropic":
      return "anthropic";
    case "gemini":
    case "gemini-oauth":
      return "gemini";
    case "ollamacloud":
      return "ollamacloud";
    default:
      return "unsupported";
  }
}

/**
 * Test an OpenAI-compatible provider by listing models.
 */
async function testOpenAI(baseUrl: string, apiKey: string): Promise<TestResult> {
  const url = `${baseUrl}/v1/models`;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal,
    });
    if (resp.ok) return "valid";
    return `invalid (HTTP ${resp.status})`;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") return "timeout";
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Test an Anthropic-compatible provider with a minimal messages call.
 */
async function testAnthropic(
  baseUrl: string,
  apiKey: string,
  authScheme: "bearer" | "x-api-key" = "x-api-key"
): Promise<TestResult> {
  const url = `${baseUrl}/anthropic/v1/messages`;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const authHeader: Record<string, string> =
    authScheme === "bearer" ? { Authorization: `Bearer ${apiKey}` } : { "x-api-key": apiKey };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        ...authHeader,
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 1,
        messages: [{ role: "user", content: "Hi" }],
      }),
      signal,
    });
    // 200 = valid, 4xx with body often means "valid key but bad model" which is fine for key test
    if (resp.ok || resp.status === 400) return "valid";
    return `invalid (HTTP ${resp.status})`;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") return "timeout";
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Test a Gemini provider via the REST models list endpoint.
 */
async function testGemini(baseUrl: string, apiKey: string): Promise<TestResult> {
  const url = `${baseUrl}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal });
    if (resp.ok) return "valid";
    return `invalid (HTTP ${resp.status})`;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") return "timeout";
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Test OllamaCloud via the tags endpoint.
 */
async function testOllamaCloud(baseUrl: string, apiKey: string): Promise<TestResult> {
  const url = `${baseUrl}/api/tags`;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (resp.ok) return "valid";
    return `invalid (HTTP ${resp.status})`;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") return "timeout";
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Test a provider's API key.
 *
 * @param providerName  - Canonical provider name from the TUI providers list
 * @param apiKey        - The resolved API key to test
 * @returns             - Human-readable result string
 */
export async function testProviderKey(providerName: string, apiKey: string): Promise<TestResult> {
  // Look up the full provider definition for transport/URL details
  const allDefs = getAllProviders();
  // providers.ts remaps "google" → "gemini" for display, so normalise back
  const canonicalName = providerName === "gemini" ? "google" : providerName;
  const def = allDefs.find((d) => d.name === canonicalName);

  if (!def) return "unsupported provider";

  const family = getApiFamily(def);
  const baseUrl = resolveBaseUrl(def);

  switch (family) {
    case "openai":
      return testOpenAI(baseUrl, apiKey);
    case "anthropic":
      return testAnthropic(baseUrl, apiKey, def.authScheme === "bearer" ? "bearer" : "x-api-key");
    case "gemini":
      return testGemini(baseUrl, apiKey);
    case "ollamacloud":
      return testOllamaCloud(baseUrl, apiKey);
    default:
      return "unsupported provider";
  }
}
