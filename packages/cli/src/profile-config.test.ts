import { describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configExists, configFilePath, getConfigPath, mergeLoadedConfig } from "./profile-config.js";

// #410 — loadConfig() is a hand-rolled field-by-field copy; a field present in
// the interface but missing from the copy list is silently dropped from every
// running proxy. That is exactly how `inboundKeys` shipped dead: #402 wired the
// resolver and the middleware, the loader dropped the field, and the scoped-key
// unit tests built configs directly — bypassing this merge — so nothing caught
// it. These pins hold the copy list itself.
describe("mergeLoadedConfig (#410)", () => {
  it("preserves inboundKeys — the field loadConfig used to drop silently", () => {
    const inboundKeys = {
      "external-vllm": {
        key: "${EXTERNAL_VLLM_KEY}",
        allowModels: ["frognano-4b", "mini"],
        maxConcurrency: 2,
      },
    };
    const merged = mergeLoadedConfig({ inboundKeys });
    expect(merged.inboundKeys).toEqual(inboundKeys);
  });

  it("absent inboundKeys stays absent (no placeholder object)", () => {
    expect(mergeLoadedConfig({}).inboundKeys).toBeUndefined();
  });

  it("preserves the other fields the proxy reads (routing, customEndpoints, apiKeys, proxyKey)", () => {
    const merged = mergeLoadedConfig({
      routing: { mini: ["frognano@mini"] },
      customEndpoints: { frognano: { models: ["frognano-4b"] } },
      apiKeys: { EXTERNAL_VLLM_KEY: "value" },
      proxyKey: "pk",
      proxyKeyPrevious: "old-pk",
      providerConcurrency: { "glm-coding": 4 },
    });
    expect(merged.routing).toEqual({ mini: ["frognano@mini"] });
    expect(merged.customEndpoints).toEqual({ frognano: { models: ["frognano-4b"] } });
    expect(merged.apiKeys).toEqual({ EXTERNAL_VLLM_KEY: "value" });
    expect(merged.proxyKey).toBe("pk");
    expect(merged.proxyKeyPrevious).toBe("old-pk");
    expect(merged.providerConcurrency).toEqual({ "glm-coding": 4 });
  });
});

// #791 — CLAUDISH_CONFIG_PATH moves the resolved config path for the whole
// process. Read per call (never latched at import), so a test can set it in
// beforeAll; unset, the value is the historical ~/.claudish/config.json.
describe("configFilePath override (#791)", () => {
  it("unset resolves to ~/.claudish/config.json", () => {
    const prev = process.env.CLAUDISH_CONFIG_PATH;
    delete process.env.CLAUDISH_CONFIG_PATH;
    try {
      expect(configFilePath()).toBe(join(homedir(), ".claudish", "config.json"));
    } finally {
      if (prev !== undefined) process.env.CLAUDISH_CONFIG_PATH = prev;
    }
  });

  it("set overrides every reader (getConfigPath and configExists follow it)", () => {
    const prev = process.env.CLAUDISH_CONFIG_PATH;
    process.env.CLAUDISH_CONFIG_PATH = join(tmpdir(), "no-such-claudish-791", "config.json");
    try {
      expect(configFilePath()).toBe(process.env.CLAUDISH_CONFIG_PATH);
      expect(getConfigPath()).toBe(process.env.CLAUDISH_CONFIG_PATH);
      expect(configExists()).toBe(false); // the override is followed, not ignored
    } finally {
      if (prev === undefined) delete process.env.CLAUDISH_CONFIG_PATH;
      else process.env.CLAUDISH_CONFIG_PATH = prev;
    }
  });
});
