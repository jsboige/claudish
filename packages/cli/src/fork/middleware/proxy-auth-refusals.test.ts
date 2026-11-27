import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import {
  REFUSAL_MARKER_INTERVAL_MS,
  _resetProxyAuthRefusalsForTest,
  noteProxyAuthRefusal,
  proxyAuthRefusalCounts,
} from "./proxy-auth-refusals.js";
import { createProxyAuthMiddleware } from "./proxy-auth.js";

const SECRET = "sk-wrong-cluster-key-0123456789abcdef";

describe("noteProxyAuthRefusal — the marker", () => {
  beforeEach(() => _resetProxyAuthRefusalsForTest());

  it("names bucket, cumulative count, the header used, the headers present and the model", () => {
    const line = noteProxyAuthRefusal(
      {
        "x-proxy-key": SECRET,
        authorization: "Bearer oauth-token",
        "x-claudish-machine": "myia-po-2026",
      },
      "glm-5.4",
      1_000
    );
    expect(line).toBe(
      "[ProxyAuth] refused 401 bucket=myia-po-2026 n=1 used=x-proxy-key present=x-proxy-key+authorization model=glm-5.4"
    );
  });

  it("never carries key material — no value, no prefix, no length", () => {
    const line = noteProxyAuthRefusal(
      { "x-api-key": SECRET, "user-agent": "claude-cli/2.1.300" },
      "or@glm-5.3",
      1_000
    )!;
    expect(line).toContain("bucket=claude-cli");
    expect(line).toContain("used=x-api-key");
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("sk-");
    expect(line).not.toContain(String(SECRET.length));
  });

  it("a request with no credential at all reads used=none present=none", () => {
    const line = noteProxyAuthRefusal({}, "frognano-4b", 1_000)!;
    expect(line).toContain("bucket=unknown");
    expect(line).toContain("used=none present=none");
  });

  it("distinguishes a Bearer authorization from a raw one", () => {
    expect(noteProxyAuthRefusal({ authorization: "Bearer x" }, "m", 1_000)).toContain(
      "used=authorization-bearer"
    );
    _resetProxyAuthRefusalsForTest();
    expect(noteProxyAuthRefusal({ authorization: "x" }, "m", 1_000)).toContain(
      "used=authorization "
    );
  });

  it("is rate-limited per bucket, while the count keeps climbing", () => {
    const h = { "x-claudish-machine": "myia-po-2026" };
    expect(noteProxyAuthRefusal(h, "m", 1_000)).not.toBeNull();
    expect(noteProxyAuthRefusal(h, "m", 1_000 + 10)).toBeNull();
    expect(noteProxyAuthRefusal(h, "m", 1_000 + REFUSAL_MARKER_INTERVAL_MS - 1)).toBeNull();
    // Another bucket has its own clock.
    expect(
      noteProxyAuthRefusal({ "x-claudish-machine": "myia-po-2028" }, "m", 1_000 + 20)
    ).not.toBeNull();
    const next = noteProxyAuthRefusal(h, "m", 1_000 + REFUSAL_MARKER_INTERVAL_MS);
    expect(next).toContain("n=4");
    expect(proxyAuthRefusalCounts()).toEqual({ "myia-po-2026": 4, "myia-po-2028": 1 });
  });

  it("a hostile header or model cannot inject into the log line", () => {
    const line = noteProxyAuthRefusal(
      { "x-claudish-machine": "evil\n[Failover] fake", "user-agent": "x\r\ny" },
      "glm\n[ProxyKey] forged",
      1_000
    )!;
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
    expect(line).toContain("bucket=unknown");
    expect(line).toContain("model=other");
  });

  it("the bucket map is bounded — minted machine names collapse into one overflow bucket", () => {
    for (let i = 0; i < 300; i++)
      noteProxyAuthRefusal({ "x-claudish-machine": `m${i}` }, "m", 1_000);
    const counts = proxyAuthRefusalCounts();
    expect(Object.keys(counts).length).toBeLessThanOrEqual(257);
    expect(counts.overflow).toBe(300 - 256);
  });
});

describe("proxy-auth middleware — the 401 now leaves a trace", () => {
  let lines: string[] = [];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    _resetProxyAuthRefusalsForTest();
    lines = [];
    spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });
  afterEach(() => spy.mockRestore());

  function app(): Hono {
    const a = new Hono();
    a.use("/v1/*", createProxyAuthMiddleware(["fleet-key"]));
    a.post("/v1/messages", (c) => c.json({ ok: true }));
    return a;
  }

  const post = (a: Hono, headers: Record<string, string>, model: string) =>
    Promise.resolve(
      a.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ model }),
      })
    );

  it("a refused request logs one marker; the accepted one logs none", async () => {
    const a = app();
    const refused = await post(
      a,
      { "x-proxy-key": SECRET, "x-claudish-machine": "myia-po-2026" },
      "or@glm-5.3"
    );
    expect(refused.status).toBe(401);
    expect(
      await post(
        a,
        { "x-proxy-key": "fleet-key", "x-claudish-machine": "myia-po-2026" },
        "or@glm-5.3"
      )
    ).toHaveProperty("status", 200);
    const markers = lines.filter((l) => l.includes("[ProxyAuth]"));
    expect(markers.length).toBe(1);
    expect(markers[0]).toContain("bucket=myia-po-2026 n=1 used=x-proxy-key");
    expect(markers.join("")).not.toContain(SECRET);
    expect(proxyAuthRefusalCounts()).toEqual({ "myia-po-2026": 1 });
  });

  it("used= follows the middleware's precedence: a wrong x-proxy-key is judged even when x-api-key holds the right key", async () => {
    // Pins both sides of the x-proxy-key > x-api-key order (review M4). If the
    // middleware flips, the request is served (200, no marker); if usedHeader
    // flips, the marker names x-api-key. Either way this test fails.
    const res = await post(
      app(),
      { "x-proxy-key": SECRET, "x-api-key": "fleet-key", "x-claudish-machine": "myia-po-2026" },
      "or@glm-5.3"
    );
    expect(res.status).toBe(401);
    const markers = lines.filter((l) => l.includes("[ProxyAuth]"));
    expect(markers.length).toBe(1);
    expect(markers[0]).toContain("used=x-proxy-key present=x-proxy-key+x-api-key");
    expect(markers.join("")).not.toContain(SECRET);
    expect(markers.join("")).not.toContain("fleet-key");
  });

  it("the native exemption is unchanged: a keyless claude-* is not a refusal and is not counted", async () => {
    const a = app();
    expect((await post(a, {}, "claude-opus-5-5")).status).toBe(200);
    expect(proxyAuthRefusalCounts()).toEqual({});
    expect(lines.some((l) => l.includes("[ProxyAuth]"))).toBe(false);
  });

  it("the 401 body is unchanged", async () => {
    const res = await post(app(), {}, "or@glm-5.3");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("invalid proxy authentication");
  });
});
