import { describe, expect, test } from "bun:test";
import {
  buildConnectionErrorMessage,
  classifyConnectionError,
  connectRetryPolicy,
} from "./connection-error.js";

describe("classifyConnectionError", () => {
  test("classifies direct connection error codes", () => {
    const cases = [
      ["ECONNREFUSED", "refused"],
      ["ENOTFOUND", "dns"],
      ["EAI_AGAIN", "dns"],
      ["ETIMEDOUT", "unreachable"],
      ["ENETUNREACH", "unreachable"],
      ["EHOSTUNREACH", "unreachable"],
      ["ConnectionRefused", "refused"],
      ["FailedToOpenSocket", "unreachable"],
      // Reached, then dropped by the peer — never the user's network.
      ["ECONNRESET", "closed"],
      ["EPIPE", "closed"],
      ["UND_ERR_SOCKET", "closed"],
      ["ConnectionClosed", "closed"],
      ["ERR_SOCKET_CLOSED", "closed"],
    ] as const;

    for (const [code, kind] of cases) {
      expect(classifyConnectionError({ code })).toEqual({ kind, code });
    }
  });

  test("walks an undici-style cause chain", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND host"), { code: "ENOTFOUND" }),
    });

    expect(classifyConnectionError(error)).toEqual({ kind: "dns", code: "ENOTFOUND" });
  });

  test("walks a deep two-level cause chain", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("request failed"), {
        cause: Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" }),
      }),
    });

    expect(classifyConnectionError(error)).toEqual({
      kind: "unreachable",
      code: "ETIMEDOUT",
    });
  });

  test("falls back to DNS wording when no code is present", () => {
    const error = new Error("failed to lookup address information: nodename nor servname provided");

    expect(classifyConnectionError(error)).toEqual({ kind: "dns", code: "ENOTFOUND" });
  });

  test("falls back to Bun's connection message when no code is present", () => {
    const error = new Error("Unable to connect. Is the computer able to access the url?");

    expect("code" in error).toBe(false);
    expect(classifyConnectionError(error)).toEqual({
      kind: "refused",
      code: "ConnectionRefused",
    });
  });

  test("returns null for non-connection errors", () => {
    expect(classifyConnectionError({ code: "ERR_INVALID_ARG_TYPE" })).toBeNull();
    expect(classifyConnectionError(new Error("ordinary failure"))).toBeNull();
    expect(classifyConnectionError(undefined)).toBeNull();
  });

  test("stops walking a self-referential cause", () => {
    const error = new Error("cyclic") as Error & { cause?: unknown };
    error.cause = error;

    expect(classifyConnectionError(error)).toBeNull();
  });
});

describe("buildConnectionErrorMessage", () => {
  test("builds an actionable DNS message from the endpoint host", () => {
    const message = buildConnectionErrorMessage(
      "dns",
      "OpenAI Codex",
      "https://chatgpt.com/backend-api/codex/responses"
    );

    expect(message).toContain("Cannot resolve");
    expect(message).toContain("chatgpt.com");
    expect(message).toContain("DNS");
    expect(message).toContain("not OpenAI Codex");
  });

  test("tells users to start a refused loopback server", () => {
    const loopbackEndpoints = [
      "http://localhost:11434/v1/chat/completions",
      "http://127.0.0.1:11434/v1/chat/completions",
      "http://[::1]:11434/v1/chat/completions",
      "http://0.0.0.0:11434/v1/chat/completions",
    ];

    for (const endpoint of loopbackEndpoints) {
      const message = buildConnectionErrorMessage("refused", "Local provider", endpoint);
      expect(message).toContain("Make sure the server is running");
    }
  });

  test("uses network and DNS guidance for a refused remote host", () => {
    const message = buildConnectionErrorMessage(
      "refused",
      "OpenAI Codex",
      "https://chatgpt.com/backend-api/codex/responses"
    );

    expect(message).not.toContain("Make sure the server is running");
    expect(message).toContain("network");
    expect(message).toContain("DNS");
    expect(message).toContain("chatgpt.com");
  });

  test("builds an actionable unreachable-host message", () => {
    const message = buildConnectionErrorMessage(
      "unreachable",
      "Remote provider",
      "https://api.example.com/v1/messages"
    );

    expect(message).toContain("Check your network connection");
  });

  test("does NOT blame the user's network when the peer closed the connection", () => {
    const message = buildConnectionErrorMessage(
      "closed",
      "Remote provider",
      "https://api.example.com/v1/messages"
    );

    expect(message).toContain("closed before a response");
    expect(message).toContain("not your network");
    expect(message).not.toContain("Check your network connection");
  });

  test("uses a non-URL endpoint verbatim", () => {
    const message = buildConnectionErrorMessage("dns", "Provider", "not-a-url");

    expect(message).toContain("not-a-url");
  });
});

describe("connectRetryPolicy — which connect failures get a bounded retry", () => {
  /**
   * The 2026-11-06 widening: on a roaming WAN seat, dns/refused/unreachable
   * are seconds-long BURSTS, not stable conditions — 26 turns were killed by
   * blips the old "closed-only" ladder let straight through to a terminal 400
   * in mono-candidate routing. These tests pin the three edges: the link
   * ladder exists for remote endpoints, never for loopback, and a single env
   * var disarms it.
   */
  const REMOTE = "https://api.z.ai/api/anthropic/v1/messages";
  const LOOPBACK = "http://localhost:3000/v1/messages";

  test('"closed" keeps the #251 ladder regardless of endpoint', () => {
    for (const endpoint of [REMOTE, LOOPBACK]) {
      const policy = connectRetryPolicy("closed", endpoint);
      expect(policy?.max).toBe(2);
      expect(policy?.delaysMs).toEqual([400, 1200]);
    }
  });

  test("dns/refused/unreachable on a REMOTE endpoint get the link ladder", () => {
    for (const kind of ["dns", "refused", "unreachable"] as const) {
      const policy = connectRetryPolicy(kind, REMOTE);
      expect(policy?.max).toBe(3);
      expect(policy?.delaysMs).toEqual([500, 2000, 5000]);
    }
  });

  test("a LOOPBACK endpoint never gets the link ladder — 'refused on localhost' is stable", () => {
    for (const kind of ["dns", "refused", "unreachable"] as const) {
      expect(connectRetryPolicy(kind, LOOPBACK)).toBeNull();
    }
  });

  test("CLAUDISH_CONNECT_RETRY_LINK=0 disarms the link ladder, not the closed ladder", () => {
    process.env.CLAUDISH_CONNECT_RETRY_LINK = "0";
    try {
      expect(connectRetryPolicy("refused", REMOTE)).toBeNull();
      expect(connectRetryPolicy("closed", REMOTE)?.max).toBe(2);
    } finally {
      delete process.env.CLAUDISH_CONNECT_RETRY_LINK;
    }
  });

  test("CLAUDISH_CONNECT_RETRY_LINK_MAX=0 is an empty ladder, not a disarm error", () => {
    process.env.CLAUDISH_CONNECT_RETRY_LINK_MAX = "0";
    try {
      expect(connectRetryPolicy("refused", REMOTE)?.max).toBe(0);
    } finally {
      delete process.env.CLAUDISH_CONNECT_RETRY_LINK_MAX;
    }
  });
});
