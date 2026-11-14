import { describe, expect, test } from "bun:test";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { OpenAIProviderTransport } from "./openai.js";

const mockProvider = {
  name: "opencode-zen",
  baseUrl: "https://opencode.ai/zen",
  apiPath: "/v1/chat/completions",
} as RemoteProvider;

describe("OpenAIProviderTransport 429 retry (#66)", () => {
  test("retries on 429 with exponential backoff", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve(new Response('{"error":"rate limited"}', { status: 429 }));
      }
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });

    expect(response.status).toBe(200);
    expect(callCount).toBe(3); // 2 retries + 1 success
  }, 15000); // 2s + 4s backoff

  test("respects Retry-After header", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;
    const startTime = Date.now();

    const response = await transport.enqueueRequest(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response('{"error":"rate limited"}', {
            status: 429,
            headers: { "Retry-After": "1" },
          })
        );
      }
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });

    const elapsed = Date.now() - startTime;
    expect(response.status).toBe(200);
    expect(callCount).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(900); // ~1s Retry-After
  }, 10000);

  test("returns 429 response after max retries exhausted", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(new Response('{"error":"rate limited"}', { status: 429 }));
    });

    expect(response.status).toBe(429);
    expect(callCount).toBe(6); // 1 initial + 5 retries
  }, 120000);

  test("does not retry non-429 errors", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(new Response('{"error":"bad request"}', { status: 400 }));
    });

    expect(response.status).toBe(400);
    expect(callCount).toBe(1); // No retry
  });
});
