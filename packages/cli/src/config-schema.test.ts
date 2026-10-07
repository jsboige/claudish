import { describe, expect, test } from "bun:test";
import {
  BuiltinDefaultProviderSchema,
  CustomEndpointComplexSchema,
  CustomEndpointSchema,
  CustomEndpointSimpleSchema,
  DefaultProviderSchema,
} from "./config-schema.js";

describe("CustomEndpointSimpleSchema", () => {
  test("accepts a valid simple endpoint and round-trips through CustomEndpointSchema", () => {
    const input = {
      kind: "simple" as const,
      url: "https://api.example.com/v1",
      format: "openai" as const,
      apiKey: "sk-test-1234",
      modelPrefix: "example/",
      models: ["model-a", "model-b"],
    };

    const parsed = CustomEndpointSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("accepts minimal simple endpoint without optional fields", () => {
    const input = {
      kind: "simple" as const,
      url: "https://api.example.com",
      format: "anthropic" as const,
      apiKey: "key",
    };

    const parsed = CustomEndpointSimpleSchema.parse(input);
    expect(parsed.kind).toBe("simple");
    expect(parsed.modelPrefix).toBeUndefined();
    expect(parsed.models).toBeUndefined();
  });

  test("rejects a non-URL `url`", () => {
    expect(() =>
      CustomEndpointSimpleSchema.parse({
        kind: "simple",
        url: "not-a-url",
        format: "openai",
        apiKey: "sk",
      })
    ).toThrow();
  });

  test("rejects an empty `apiKey`", () => {
    expect(() =>
      CustomEndpointSimpleSchema.parse({
        kind: "simple",
        url: "https://api.example.com",
        format: "openai",
        apiKey: "",
      })
    ).toThrow();
  });

  // Cap 8 → 32 (2026-10-07): the fleet's FrogNano-4B endpoint runs
  // definitive maxConcurrency=16 (gates N=16/32 passed); at the old cap the
  // entry failed validation and the endpoint was silently skipped. The cap
  // stays a typo guard — 33 is still rejected.
  test("maxConcurrency: accepts 16 (fleet value) and 32, rejects 33", () => {
    const base = {
      kind: "simple" as const,
      url: "https://api.example.com",
      format: "openai" as const,
      apiKey: "sk",
    };
    for (const n of [16, 32]) {
      expect(CustomEndpointSimpleSchema.parse({ ...base, maxConcurrency: n }).maxConcurrency).toBe(n);
    }
    expect(() => CustomEndpointSimpleSchema.parse({ ...base, maxConcurrency: 33 })).toThrow();
    expect(() =>
      CustomEndpointComplexSchema.parse({
        kind: "complex",
        displayName: "x",
        transport: "openai",
        baseUrl: "https://api.example.com",
        apiKey: "sk",
        maxConcurrency: 33,
      })
    ).toThrow();
  });
});

describe("CustomEndpointComplexSchema", () => {
  test("accepts a valid complex endpoint and round-trips through CustomEndpointSchema", () => {
    const input = {
      kind: "complex" as const,
      displayName: "My vLLM",
      transport: "openai" as const,
      baseUrl: "https://vllm.example.com",
      apiPath: "/v1/chat/completions",
      apiKey: "key-xyz",
      authScheme: "bearer" as const,
      headers: { "X-Custom": "value" },
      streamFormat: "openai-sse" as const,
      modelPrefix: "vllm/",
      models: ["llama-3"],
    };

    const parsed = CustomEndpointSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("accepts minimal complex endpoint with only required fields", () => {
    const input = {
      kind: "complex" as const,
      displayName: "Minimal",
      transport: "openai" as const,
      baseUrl: "https://example.com",
      apiKey: "k",
    };

    const parsed = CustomEndpointComplexSchema.parse(input);
    expect(parsed.displayName).toBe("Minimal");
    expect(parsed.headers).toBeUndefined();
    expect(parsed.streamFormat).toBeUndefined();
  });
});

describe("CustomEndpointSchema (discriminated union)", () => {
  test("rejects an object missing the `kind` field", () => {
    expect(() =>
      CustomEndpointSchema.parse({
        url: "https://api.example.com",
        format: "openai",
        apiKey: "sk",
      })
    ).toThrow();
  });
});

describe("BuiltinDefaultProviderSchema", () => {
  test("accepts openrouter", () => {
    expect(BuiltinDefaultProviderSchema.parse("openrouter")).toBe("openrouter");
  });
  test("accepts litellm", () => {
    expect(BuiltinDefaultProviderSchema.parse("litellm")).toBe("litellm");
  });
  test("accepts openai", () => {
    expect(BuiltinDefaultProviderSchema.parse("openai")).toBe("openai");
  });
  test("accepts anthropic", () => {
    expect(BuiltinDefaultProviderSchema.parse("anthropic")).toBe("anthropic");
  });
  test("accepts google", () => {
    expect(BuiltinDefaultProviderSchema.parse("google")).toBe("google");
  });

  test("rejects unknown builtin name", () => {
    expect(() => BuiltinDefaultProviderSchema.parse("not-a-builtin")).toThrow();
  });
});

describe("DefaultProviderSchema", () => {
  test("accepts builtin name", () => {
    expect(DefaultProviderSchema.parse("openrouter")).toBe("openrouter");
  });

  test("accepts a custom endpoint name like `my-vllm`", () => {
    expect(DefaultProviderSchema.parse("my-vllm")).toBe("my-vllm");
  });

  test("rejects empty string", () => {
    expect(() => DefaultProviderSchema.parse("")).toThrow();
  });
});
