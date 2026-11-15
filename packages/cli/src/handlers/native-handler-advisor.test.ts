import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAdvisorFlag } from "../cli.js";
import {
  OpenRouterCatalogResolver,
  resetOpenRouterCatalogForTests,
  setMemCatalogForTests,
} from "../providers/catalog-resolvers/openrouter.js";

// `launcher/catalog-warm.test.ts` installs `mock.module()` on
// `model-catalog-resolver.js` (to fake `getResolver`), and bun overrides are
// process-global with no undo — the suite runs every file in ONE process, and
// `launcher/` is loaded before `handlers/`. Left alone, the resolver seen here
// is that stub, whose `resolveSync` always returns null, so a seeded catalogue
// entry never reaches the wire (measured on CI 15/11: this file's pin received
// the bare id unchanged; reproduced locally with
// `bun test ./src/launcher/catalog-warm.test.ts ./src/handlers/native-handler-advisor.test.ts`).
// Mock again, with the REAL resolver class: openrouter resolves for real, every
// other provider keeps returning null exactly as the leaked stub did.
mock.module("../providers/model-catalog-resolver.js", () => {
  let real: OpenRouterCatalogResolver | null = null;
  return {
    getResolver: (provider: string) => {
      if (provider !== "openrouter") return null;
      real ??= new OpenRouterCatalogResolver();
      return real;
    },
  };
});
import { installStubFetch } from "../test-support/stub-fetch.js";
import {
  _debug_getTrackedAdvisorIds,
  _debug_resetTrackedAdvisorIds,
  convertToOpenAIMessages,
  extractBlocksAsText,
  fetchMultiModelAdvice,
  findPendingAdvisorToolResults,
  loadAdvisorSwapConfig,
  recordAdvisorEventsFromChunk,
  rewriteAdvisorToolResults,
  stripAdvisorBeta,
  stubAdvisorAdvice,
  swapAdvisorToolInBody,
} from "./native-handler-advisor.js";

afterEach(() => {
  _debug_resetTrackedAdvisorIds();
});

describe("swapAdvisorToolInBody", () => {
  it("replaces advisor_20260301 with a regular tool of the same name", () => {
    const body = {
      tools: [
        { name: "Bash", input_schema: {} },
        { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-6" },
        { name: "Read", input_schema: {} },
      ],
    };
    const info = swapAdvisorToolInBody(body);
    expect(info).not.toBeNull();
    expect(body.tools).toHaveLength(3);
    // Bash and Read untouched
    expect((body.tools[0] as any).name).toBe("Bash");
    expect((body.tools[2] as any).name).toBe("Read");
    // Advisor replaced with regular tool
    const replaced = body.tools[1] as any;
    expect(replaced.name).toBe("advisor");
    expect(replaced.type).toBeUndefined();
    expect(replaced.input_schema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(typeof replaced.description).toBe("string");
    expect(replaced.description.length).toBeGreaterThan(50);
  });

  it("returns null when no advisor tool is present", () => {
    const body = { tools: [{ name: "Bash", input_schema: {} }] };
    expect(swapAdvisorToolInBody(body)).toBeNull();
  });

  it("returns null when tools is missing or not an array", () => {
    expect(swapAdvisorToolInBody({})).toBeNull();
    expect(swapAdvisorToolInBody({ tools: null as any })).toBeNull();
    expect(swapAdvisorToolInBody({ tools: "nope" as any })).toBeNull();
  });
});

describe("stripAdvisorBeta", () => {
  it("removes advisor-tool-2026-03-01 from a comma list", () => {
    const { stripped, changed } = stripAdvisorBeta(
      "claude-code-20250219,advisor-tool-2026-03-01,effort-2025-11-24"
    );
    expect(changed).toBe(true);
    expect(stripped).toBe("claude-code-20250219,effort-2025-11-24");
  });

  it("returns changed=false when advisor beta is absent", () => {
    const { stripped, changed } = stripAdvisorBeta("claude-code-20250219");
    expect(changed).toBe(false);
    expect(stripped).toBe("claude-code-20250219");
  });

  it("handles whitespace around entries", () => {
    const { stripped, changed } = stripAdvisorBeta(
      "claude-code-20250219, advisor-tool-2026-03-01 , effort-2025-11-24"
    );
    expect(changed).toBe(true);
    expect(stripped).toBe("claude-code-20250219,effort-2025-11-24");
  });

  it("returns undefined when the only entry was the advisor beta", () => {
    const { stripped, changed } = stripAdvisorBeta("advisor-tool-2026-03-01");
    expect(changed).toBe(true);
    expect(stripped).toBeUndefined();
  });

  it("is a no-op for missing header", () => {
    const { stripped, changed } = stripAdvisorBeta(undefined);
    expect(changed).toBe(false);
    expect(stripped).toBeUndefined();
  });
});

describe("extractAdvisorToolUseIds (via recordAdvisorEventsFromChunk)", () => {
  const cfg = { enabled: true, logPath: undefined };

  it("captures toolu_* ids from a content_block_start with name=advisor", () => {
    const chunk =
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,' +
      '"content_block":{"type":"tool_use","id":"toolu_01ABCxyz","name":"advisor","input":{}}}\n\n';
    recordAdvisorEventsFromChunk(cfg, chunk);
    expect(_debug_getTrackedAdvisorIds()).toContain("toolu_01ABCxyz");
  });

  it("captures ids when name comes before id (alternate field order)", () => {
    const chunk =
      '"content_block":{"name":"advisor","type":"tool_use","id":"toolu_alt123","input":{}}';
    recordAdvisorEventsFromChunk(cfg, chunk);
    expect(_debug_getTrackedAdvisorIds()).toContain("toolu_alt123");
  });

  it("does not capture ids for non-advisor tools", () => {
    const chunk =
      '"content_block":{"type":"tool_use","id":"toolu_99bash","name":"Bash","input":{}}';
    recordAdvisorEventsFromChunk(cfg, chunk);
    expect(_debug_getTrackedAdvisorIds()).not.toContain("toolu_99bash");
  });

  it("deduplicates repeated observations of the same id", () => {
    const chunk =
      '"content_block":{"type":"tool_use","id":"toolu_dup","name":"advisor","input":{}}';
    recordAdvisorEventsFromChunk(cfg, chunk);
    recordAdvisorEventsFromChunk(cfg, chunk);
    const ids = _debug_getTrackedAdvisorIds();
    expect(ids.filter((x) => x === "toolu_dup")).toHaveLength(1);
  });
});

describe("rewriteAdvisorToolResults", () => {
  it("rewrites an error tool_result for a known advisor id", () => {
    // First seed the tracker so rewrite recognises the id
    recordAdvisorEventsFromChunk(
      { enabled: true, logPath: undefined },
      '"content_block":{"type":"tool_use","id":"toolu_known","name":"advisor","input":{}}'
    );

    const body = {
      messages: [
        { role: "user", content: "build a rate limiter" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_known", name: "advisor", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_known",
              is_error: true,
              content: "<tool_use_error>Error: No such tool available: advisor</tool_use_error>",
            },
          ],
        },
      ],
    };
    const rewritten = rewriteAdvisorToolResults(body, stubAdvisorAdvice);
    expect(rewritten).toEqual(["toolu_known"]);

    const resultBlock = (body.messages[2] as any).content[0];
    expect(resultBlock.is_error).toBe(false);
    expect(Array.isArray(resultBlock.content)).toBe(true);
    expect(resultBlock.content[0].type).toBe("text");
    expect(resultBlock.content[0].text).toContain("CLAUDISH_ADVISOR_STUB_toolu_known");
  });

  it("ignores tool_result blocks with unknown ids", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_never_seen",
              is_error: true,
              content: "<tool_use_error>...</tool_use_error>",
            },
          ],
        },
      ],
    };
    const rewritten = rewriteAdvisorToolResults(body, stubAdvisorAdvice);
    expect(rewritten).toEqual([]);
    expect((body.messages[0] as any).content[0].is_error).toBe(true);
  });

  it("leaves non-advisor tool_results untouched even when ids exist in tracker", () => {
    recordAdvisorEventsFromChunk(
      { enabled: true, logPath: undefined },
      '"content_block":{"type":"tool_use","id":"toolu_adv","name":"advisor","input":{}}'
    );
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_some_other_tool",
              is_error: false,
              content: [{ type: "text", text: "output of Bash" }],
            },
          ],
        },
      ],
    };
    const rewritten = rewriteAdvisorToolResults(body, stubAdvisorAdvice);
    expect(rewritten).toEqual([]);
    // Unchanged
    const blk = (body.messages[0] as any).content[0];
    expect(blk.is_error).toBe(false);
    expect(blk.content[0].text).toBe("output of Bash");
  });

  it("is a no-op when messages is missing or content isn't a block array", () => {
    expect(rewriteAdvisorToolResults({}, stubAdvisorAdvice)).toEqual([]);
    expect(
      rewriteAdvisorToolResults(
        { messages: [{ role: "user", content: "plain text" }] },
        stubAdvisorAdvice
      )
    ).toEqual([]);
  });
});

describe("loadAdvisorSwapConfig", () => {
  const orig = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, orig);
  });

  it("reads CLAUDISH_SWAP_ADVISOR and log paths from env", () => {
    process.env.CLAUDISH_SWAP_ADVISOR = "1";
    process.env.CLAUDISH_SWAP_ADVISOR_LOG = "/tmp/foo.ndjson";
    process.env.CLAUDISH_SWAP_ADVISOR_DUMP = "1";
    const cfg = loadAdvisorSwapConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.logPath).toBe("/tmp/foo.ndjson");
    expect(cfg.dumpBodies).toBe(true);
  });

  it("is disabled when CLAUDISH_SWAP_ADVISOR is unset", () => {
    delete process.env.CLAUDISH_SWAP_ADVISOR;
    const cfg = loadAdvisorSwapConfig();
    expect(cfg.enabled).toBe(false);
  });

  it("is enabled when CLI models are provided (even without env var)", () => {
    delete process.env.CLAUDISH_SWAP_ADVISOR;
    const cfg = loadAdvisorSwapConfig(["gemini-3-pro", "grok-3"], "haiku");
    expect(cfg.enabled).toBe(true);
    expect(cfg.models).toEqual(["gemini-3-pro", "grok-3"]);
    expect(cfg.collector).toBe("haiku");
  });

  it("stores collector as undefined when null is passed", () => {
    const cfg = loadAdvisorSwapConfig(["gemini-3-pro"], null);
    expect(cfg.enabled).toBe(true);
    expect(cfg.collector).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage 3: Multi-model advisor tests
// ---------------------------------------------------------------------------

describe("parseAdvisorFlag", () => {
  it("parses multiple models with default haiku collector", () => {
    const result = parseAdvisorFlag("gemini-3-pro,grok-3,gpt-5");
    expect(result.models).toEqual(["gemini-3-pro", "grok-3", "gpt-5"]);
    expect(result.collector).toBe("haiku");
  });

  it("parses explicit collector after colon", () => {
    const result = parseAdvisorFlag("gemini-3-pro,grok-3:gemini-2.5-flash");
    expect(result.models).toEqual(["gemini-3-pro", "grok-3"]);
    expect(result.collector).toBe("gemini-2.5-flash");
  });

  it("disables collector with trailing colon", () => {
    const result = parseAdvisorFlag("gemini-3-pro,grok-3:");
    expect(result.models).toEqual(["gemini-3-pro", "grok-3"]);
    expect(result.collector).toBeNull();
  });

  it("single model → no collector (passthrough)", () => {
    const result = parseAdvisorFlag("gemini-3-pro");
    expect(result.models).toEqual(["gemini-3-pro"]);
    expect(result.collector).toBeNull();
  });

  it("single model with explicit colon still no collector", () => {
    const result = parseAdvisorFlag("gemini-3-pro:haiku");
    expect(result.models).toEqual(["gemini-3-pro"]);
    expect(result.collector).toBeNull();
  });

  it("trims whitespace from model names", () => {
    const result = parseAdvisorFlag(" gemini-3-pro , grok-3 : sonnet ");
    expect(result.models).toEqual(["gemini-3-pro", "grok-3"]);
    expect(result.collector).toBe("sonnet");
  });

  it("handles provider@model syntax in advisor models", () => {
    const result = parseAdvisorFlag("or@deepseek/deepseek-r1,g@gemini-3-pro");
    expect(result.models).toEqual(["or@deepseek/deepseek-r1", "g@gemini-3-pro"]);
    expect(result.collector).toBe("haiku");
  });
});

describe("findPendingAdvisorToolResults", () => {
  const cfg = { enabled: true, logPath: undefined };

  it("finds tool_result blocks matching tracked advisor IDs", () => {
    // Seed the tracker
    recordAdvisorEventsFromChunk(
      cfg,
      '"content_block":{"type":"tool_use","id":"toolu_pending1","name":"advisor","input":{}}'
    );
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_pending1",
              is_error: true,
              content: "No such tool",
            },
          ],
        },
      ],
    };
    expect(findPendingAdvisorToolResults(payload)).toEqual(["toolu_pending1"]);
  });

  it("ignores tool_results for non-advisor IDs", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_unknown", is_error: true, content: "err" },
          ],
        },
      ],
    };
    expect(findPendingAdvisorToolResults(payload)).toEqual([]);
  });

  it("returns empty for missing messages", () => {
    expect(findPendingAdvisorToolResults({})).toEqual([]);
  });
});

describe("extractBlocksAsText", () => {
  it("handles plain string content", () => {
    expect(extractBlocksAsText("hello")).toBe("hello");
  });

  it("extracts text blocks", () => {
    const blocks = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ];
    expect(extractBlocksAsText(blocks)).toBe("first\nsecond");
  });

  it("represents tool_use blocks with name and truncated input", () => {
    const blocks = [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }];
    const result = extractBlocksAsText(blocks);
    expect(result).toContain("[Called tool: Bash");
    expect(result).toContain("ls -la");
  });

  it("represents tool_result blocks with truncated content", () => {
    const blocks = [
      {
        type: "tool_result",
        tool_use_id: "toolu_123",
        content: "file1.ts\nfile2.ts",
      },
    ];
    const result = extractBlocksAsText(blocks);
    expect(result).toContain("[Tool result (toolu_123):");
    expect(result).toContain("file1.ts");
  });

  it("handles tool_result with array content", () => {
    const blocks = [
      {
        type: "tool_result",
        tool_use_id: "toolu_456",
        content: [{ type: "text", text: "output here" }],
      },
    ];
    const result = extractBlocksAsText(blocks);
    expect(result).toContain("output here");
  });

  it("returns empty string for non-array, non-string content", () => {
    expect(extractBlocksAsText(null)).toBe("");
    expect(extractBlocksAsText(42)).toBe("");
    expect(extractBlocksAsText(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// #1027 — the `model` field sent to OpenRouter is an id, not a resolution object
// ---------------------------------------------------------------------------

describe("OpenRouter request body — the model field is an id (#1027)", () => {
  const originalCachePath = process.env.CLAUDISH_MODEL_CACHE_PATH;
  const sentBodies: Array<{ model?: unknown }> = [];
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    sentBodies.length = 0;
    // Cold in-memory catalogue AND an unreadable disk cache: `_getEntries()`
    // falls back to readAllModelsCache() whenever the memory catalogue is empty,
    // and a warm disk cache would turn the "unknown id" pin into a catalogue hit.
    resetOpenRouterCatalogForTests();
    process.env.CLAUDISH_MODEL_CACHE_PATH = join(
      tmpdir(),
      `claudish-1027-absent-${Date.now()}`,
      "all-models.json"
    );
    restoreFetch = installStubFetch(async (req) => {
      sentBodies.push(JSON.parse(await req.text()));
      return new Response(JSON.stringify({ choices: [{ message: { content: "advice" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    resetOpenRouterCatalogForTests();
    if (originalCachePath === undefined) {
      // Reflect.deleteProperty, not `delete`: same effect on process.env,
      // without the noDelete diagnostic this file's baseline does not carry.
      Reflect.deleteProperty(process.env, "CLAUDISH_MODEL_CACHE_PATH");
    } else {
      process.env.CLAUDISH_MODEL_CACHE_PATH = originalCachePath;
    }
  });

  // `or@x-ai/grok-4`, not bare `x-ai/grok-4`: parseModelSpec auto-detects the
  // `x-ai/*` native pattern and strips the vendor prefix (measured:
  // `x-ai/grok-4` → {provider:"xai", model:"grok-4"}), so the bare form never
  // reaches this branch with its prefix intact — that strip is line 460-462
  // territory, explicitly out of scope for #1027. `or@` is the form that puts
  // a vendor-prefixed id on the OpenRouter wire.
  it("sends a vendor-prefixed id as that string, not as a resolution object", async () => {
    await fetchMultiModelAdvice(
      "toolu_1027a",
      [{ role: "user", content: "hi" }],
      ["or@x-ai/grok-4"],
      null,
      { openrouter: "sk-or-test" }
    );
    expect(sentBodies).toHaveLength(1);
    expect(typeof sentBodies[0].model).toBe("string");
    expect(sentBodies[0].model).toBe("x-ai/grok-4");
  });

  it("maps a bare id the catalogue knows to its OpenRouter external id", async () => {
    setMemCatalogForTests([
      {
        modelId: "grok-4",
        aliases: [],
        sources: { "openrouter-api": { externalId: "x-ai/grok-4" } },
      },
    ]);
    await fetchMultiModelAdvice(
      "toolu_1027b",
      [{ role: "user", content: "hi" }],
      ["grok-4"],
      null,
      { openrouter: "sk-or-test" }
    );
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0].model).toBe("x-ai/grok-4");
  });

  it("sends an id the catalogue does not know unchanged, as a string", async () => {
    await fetchMultiModelAdvice(
      "toolu_1027c",
      [{ role: "user", content: "hi" }],
      ["unknown-vendor-model-1027"],
      null,
      { openrouter: "sk-or-test" }
    );
    expect(sentBodies).toHaveLength(1);
    expect(typeof sentBodies[0].model).toBe("string");
    expect(sentBodies[0].model).toBe("unknown-vendor-model-1027");
  });
});

describe("convertToOpenAIMessages", () => {
  it("converts simple text messages", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const result = convertToOpenAIMessages(messages);
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("converts block-style content to text", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "please help" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Sure, let me check." },
          { type: "tool_use", name: "Read", input: { file_path: "/foo.ts" } },
        ],
      },
    ];
    const result = convertToOpenAIMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("please help");
    expect(result[1].content).toContain("Sure, let me check.");
    expect(result[1].content).toContain("[Called tool: Read");
  });

  it("filters out system messages", () => {
    const messages = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ];
    const result = convertToOpenAIMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("filters out empty messages", () => {
    const messages = [
      { role: "assistant", content: [] },
      { role: "user", content: "real content" },
    ];
    const result = convertToOpenAIMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("real content");
  });
});
