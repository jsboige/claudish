import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createProxyAuthMiddleware } from "./proxy-auth.js";
import { matchesProxyKey, resolveProxyKeys } from "../../handlers/shared/proxy-keys.js";
import { inboundKeyFor, type InboundKeyEntry } from "../../handlers/shared/inbound-keys.js";

function buildApp(keys: string[], inboundKeys: InboundKeyEntry[] = []): Hono {
  const app = new Hono();
  app.use("/v1/*", createProxyAuthMiddleware(keys, inboundKeys));
  app.post("/v1/messages", (c) => c.json({ ok: true }));
  app.get("/v1/models", (c) => c.json({ ok: true }));
  return app;
}

function post(app: Hono, headers: Record<string, string> = {}, model = "gpt-4o"): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model }),
  });
}

describe("resolveProxyKeys", () => {
  it("returns just the primary when no previous is set", () => {
    expect(resolveProxyKeys("new", undefined)).toEqual(["new"]);
  });

  it("keeps primary first, previous second", () => {
    expect(resolveProxyKeys("new", "old")).toEqual(["new", "old"]);
  });

  it("dedupes when previous equals primary", () => {
    expect(resolveProxyKeys("same", "same")).toEqual(["same"]);
  });

  it("drops empty values and yields an empty set when nothing is configured", () => {
    expect(resolveProxyKeys("", "")).toEqual([]);
    expect(resolveProxyKeys(undefined, undefined)).toEqual([]);
  });
});

describe("matchesProxyKey", () => {
  it("accepts any configured key, rejects everything else", () => {
    const keys = ["new", "old"];
    expect(matchesProxyKey("new", keys)).toBe(true);
    expect(matchesProxyKey("old", keys)).toBe(true);
    expect(matchesProxyKey("guess", keys)).toBe(false);
    expect(matchesProxyKey(undefined, keys)).toBe(false);
    expect(matchesProxyKey("new", [])).toBe(false);
  });
});

describe("proxy-auth middleware", () => {
  it("accepts the single configured key and rejects wrong or missing keys", async () => {
    const app = buildApp(["only-key"]);
    expect((await post(app, { "x-proxy-key": "only-key" })).status).toBe(200);
    expect((await post(app, { "x-proxy-key": "wrong" })).status).toBe(401);
    expect((await post(app)).status).toBe(401);
  });

  it("during a rotation accepts BOTH the new and the retiring key", async () => {
    const app = buildApp(["new-key", "old-key"]);
    expect((await post(app, { "x-proxy-key": "new-key" })).status).toBe(200);
    expect((await post(app, { "x-proxy-key": "old-key" })).status).toBe(200);
    expect((await post(app, { "x-proxy-key": "pre-rotation-guess" })).status).toBe(401);
  });

  it("accepts the retiring key in every header form (x-proxy-key, x-api-key, Bearer)", async () => {
    const app = buildApp(["new-key", "old-key"]);
    expect((await post(app, { "x-api-key": "old-key" })).status).toBe(200);
    expect((await post(app, { authorization: "Bearer old-key" })).status).toBe(200);
    expect((await post(app, { authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("native-anthropic targets bypass the proxy key entirely", async () => {
    const app = buildApp(["new-key", "old-key"]);
    expect((await post(app, {}, "anthropic/claude-opus-5")).status).toBe(200);
  });

  it("GET requests are exempt (health / model discovery)", async () => {
    const app = buildApp(["new-key"]);
    expect((await app.request("/v1/models")).status).toBe(200);
  });

  it("a malformed body falls through to the route handler", async () => {
    const app = buildApp(["new-key"]);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(200);
  });
});

describe("proxy-auth middleware — scoped inbound keys (#400)", () => {
  const fleetKeys = ["fleet-key"];
  const scoped: InboundKeyEntry[] = [
    {
      name: "external",
      key: "scoped-secret",
      allowModels: ["swift-1.5-27b", "qwen3.6-35b-a3b", "frognano-4b"],
    },
  ];
  const build = () => buildApp(fleetKeys, scoped);

  it("an allowlisted model passes with the scoped key", async () => {
    const app = build();
    expect((await post(app, { "x-api-key": "scoped-secret" }, "swift-1.5-27b")).status).toBe(200);
    expect((await post(app, { authorization: "Bearer scoped-secret" }, "qwen3.6-35b-a3b")).status).toBe(200);
  });

  it("a NON-allowlisted model is a labeled 403 — subscriptions and native stay fleet-internal", async () => {
    const app = build();
    for (const model of ["glm-5.3", "MiniMax-M3", "claude-opus-5-5", "or@glm-5.3"]) {
      const res = await post(app, { "x-proxy-key": "scoped-secret" }, model);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe("permission_error");
      expect(body.error.message).toContain("[InboundKey]");
      expect(body.error.message).toContain(model);
      // #296 doctrine: this refusal must never arm isQuotaExhaustion — the
      // wording is load-bearing and pinned here against the real predicate.
      expect(body.error.message).not.toMatch(/quota|usage limit|credit|balance/i);
    }
  });

  it("a scoped key naming a native model is refused 403 — it never rides the Anthropic passthrough exemption", async () => {
    const app = build();
    // Without the scoped branch ordering, this model hits the native exemption
    // BEFORE any key check and would pass keyless.
    const res = await post(app, { "x-api-key": "scoped-secret" }, "anthropic/claude-opus-5");
    expect(res.status).toBe(403);
  });

  it("explicit provider@model forms only pass on an EXACT raw allowlist hit (no cross-transport riding)", async () => {
    const app = build();
    expect((await post(app, { "x-proxy-key": "scoped-secret" }, "or@swift-1.5-27b")).status).toBe(403);
    expect((await post(app, { "x-proxy-key": "scoped-secret" }, "frognano@frognano-4b")).status).toBe(403);
    const explicit: InboundKeyEntry[] = [
      { name: "explicit", key: "s2", allowModels: ["frognano@frognano-4b"] },
    ];
    const app2 = buildApp(fleetKeys, explicit);
    expect((await post(app2, { "x-proxy-key": "s2" }, "frognano@frognano-4b")).status).toBe(200);
  });

  it("the fleet key is UNCHANGED by the presence of scoped keys (regression)", async () => {
    const app = build();
    expect((await post(app, { "x-proxy-key": "fleet-key" }, "glm-5.3")).status).toBe(200);
  });

  it("a key that is neither scoped nor fleet gets the plain 401 on non-exempt routes (no scope matching for strangers)", async () => {
    // NOTE: a BARE unknown model name parses to native-anthropic and rides the
    // native exemption (pre-existing behavior, unchanged by #400) — so the
    // stranger pin must use an explicit-provider form the exemption does not
    // cover. In the real proxy a stranger naming a bare id hits NativeHandler's
    // #296 credential refusal instead, never a scoped lane.
    const app = build();
    expect((await post(app, { "x-proxy-key": "not-any-key" }, "or@glm-5.3")).status).toBe(401);
  });

  it("the matched request is marked for capture attribution — inboundKeyFor returns the name on the route side", async () => {
    // Own app (not buildApp): a second handler stacked on an existing route
    // never runs in Hono — the first registered one's Response wins.
    const app = new Hono();
    app.use("/v1/*", createProxyAuthMiddleware(fleetKeys, scoped));
    const seen: (string | undefined)[] = [];
    app.post("/v1/messages", (c) => {
      // request-logger reads the same raw Request the middleware marked.
      seen.push(inboundKeyFor(c.req.raw));
      return c.json({ ok: true });
    });
    const res = await post(app, { "x-api-key": "scoped-secret" }, "frognano-4b");
    expect(res.status).toBe(200);
    expect(seen).toEqual(["external"]);
  });
});
