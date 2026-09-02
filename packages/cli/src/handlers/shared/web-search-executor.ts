/**
 * Web search executor — intercepts web_search tool calls from providers
 * (z.ai, GLM) and executes them via SearXNG.
 *
 * When a provider model requests web_search, claudish:
 * 1. Extracts the search query from tool arguments
 * 2. Calls the SearXNG MCP server (when SEARXNG_MCP_URL is set),
 *    falling back to the direct SearXNG HTTP API
 * 3. Returns formatted results as a text block in the stream
 *
 * Fallback chains (HARD constraint: a failed search/fetch must NEVER
 * stop the agent — every path ends in well-formed text, never a throw):
 *   search: MCP searxng_web_search → direct HTTP /search → error text
 *   fetch:  MCP web_url_read → MCP via r.jina.ai prefix → direct HTTP → error text
 *
 * IMPORTANT: these executors must not block the SSE stream.
 * Every network call is bounded by a strict deadline.
 */

import { log } from "../../logger.js";
import { isMcpSearxngAvailable, mcpWebSearch, mcpUrlRead } from "./mcp-searxng-client.js";

/**
 * SearXNG endpoint config, read per call (like mcp-searxng-client) so tests
 * and late-injected container env work without import-order concerns.
 *
 * Basic-auth credentials may be embedded in SEARXNG_URL userinfo — the
 * standard curl-style form `https://user:pass@search.myia.io`. The public
 * URL sits behind IIS Basic Auth (Windows account, deployed 2026-08-19 to
 * stop external scraping); LAN deployments use a credless URL and send no
 * Authorization header. Credentials never appear in logs — only the
 * stripped base URL does.
 */
export function searxngConfig(): { base: string; authHeaders: Record<string, string> } {
  const raw = process.env.SEARXNG_URL || "http://search.myia.io";
  try {
    const u = new URL(raw);
    if (u.username) {
      const cred = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password ?? "")}`;
      const authHeaders = { Authorization: `Basic ${Buffer.from(cred).toString("base64")}` };
      u.username = "";
      u.password = "";
      return { base: u.toString().replace(/\/+$/, ""), authHeaders };
    }
  } catch {
    // Unparseable — use as-is, no auth.
  }
  return { base: raw.replace(/\/+$/, ""), authHeaders: {} };
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Per-attempt SearXNG deadline, dimensioned 2026-09-03 (roo-extensions #3388):
 * 20-sample measurement against the LAN endpoint (mixed warm/cold queries)
 * gave p50 0.92s, p90 1.57s, p95 2.97s — the two ~3s outliers were unique
 * (cold) queries hitting cold engines. 5s ≈ 1.7×p95 keeps headroom under
 * load; a single attempt still loses p99 events, hence the one retry in
 * executeWebSearch. SEARXNG_ATTEMPT_TIMEOUT_MS overrides it (tests, or a
 * known-slower endpoint such as the Basic-auth public URL).
 */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5000;

/**
 * Smallest remaining budget worth spending on a retry attempt. Below this we
 * report failure instead of starting a call we already know will be cut short.
 */
const MIN_ATTEMPT_BUDGET_MS = 250;

/**
 * Maximum attempts per executeWebSearch call: 1 initial + 1 retry.
 */
const MAX_SEARCH_ATTEMPTS = 2;

function attemptTimeoutMs(): number {
  const raw = Number(process.env.SEARXNG_ATTEMPT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 50 ? raw : DEFAULT_ATTEMPT_TIMEOUT_MS;
}

/**
 * Rolling latency telemetry for the direct HTTP route (issue #3388: quantify
 * real p50/p95 client-side and detect drift). Successful AND failed attempts
 * are recorded — a timeout is the measurement that matters most. Kept in
 * memory only; every 10th sample logs the window stats.
 */
const LATENCY_WINDOW = 50;
const searxngLatencies: number[] = [];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function recordLatency(ms: number): void {
  searxngLatencies.push(ms);
  if (searxngLatencies.length > LATENCY_WINDOW) searxngLatencies.shift();
  if (searxngLatencies.length % 10 === 0) {
    const stats = searxngLatencyStats();
    log(`[WebSearch] latency window: n=${stats?.n} p50=${stats?.p50}ms p95=${stats?.p95}ms`);
  }
}

/** Current rolling latency stats for the direct HTTP route, or null if no samples. */
export function searxngLatencyStats(): { n: number; p50: number; p95: number } | null {
  if (searxngLatencies.length === 0) return null;
  const sorted = [...searxngLatencies].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

/** Test hook: clear the rolling latency window. */
export function _resetSearxngTelemetry(): void {
  searxngLatencies.length = 0;
}

/**
 * Execute a web search via SearXNG. Throws on timeout/network error so the
 * caller's retry loop can distinguish "attempt failed, retry" from
 * "server answered" (HTTP non-ok returns [] like before).
 */
async function fetchFromSearXNG(
  query: string,
  maxResults = 5,
  timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS
): Promise<SearchResult[]> {
  const { base, authHeaders } = searxngConfig();
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
  log(`[WebSearch] Executing: "${query}" via ${base} (attempt timeout ${timeoutMs}ms)`);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json", ...authHeaders },
  });

  if (!response.ok) {
    log(`[WebSearch] SearXNG returned HTTP ${response.status}`);
    return [];
  }

  const data = (await response.json()) as any;
  const results: SearchResult[] = (data.results || [])
    .slice(0, maxResults)
    .map((r: any) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.content || r.description || "",
    }));

  log(`[WebSearch] Got ${results.length} results for "${query}"`);
  return results;
}

/**
 * Stream-safe web search: MCP searxng_web_search first (when configured),
 * then the direct SearXNG HTTP API with one retry inside the budget.
 * Returns formatted results text, never throws, never blocks > deadlineMs.
 *
 * deadlineMs is a TOTAL budget (default 8000ms = one 5s attempt + one retry
 * floor, dimensioned from measured p95 ≈ 3s — see DEFAULT_ATTEMPT_TIMEOUT_MS).
 */
export async function executeWebSearch(query: string, deadlineMs = 8000): Promise<string> {
  const deadlineAt = Date.now() + deadlineMs;

  if (isMcpSearxngAvailable()) {
    const mcp = await mcpWebSearch(query, Math.max(deadlineMs, 5000));
    if (mcp.ok) {
      return `[Web search results for "${query}"]\n\n${mcp.text}`;
    }
    log(`[WebSearch] MCP route failed (${mcp.error}), falling back to direct HTTP`);
  }

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt++) {
    const remaining = deadlineAt - Date.now();
    if (remaining < MIN_ATTEMPT_BUDGET_MS) {
      log(`[WebSearch] Budget exhausted before attempt ${attempt}/${MAX_SEARCH_ATTEMPTS} for "${query}"`);
      break;
    }

    const timeoutMs = Math.min(attemptTimeoutMs(), remaining);
    const startedAt = Date.now();
    try {
      const results = await fetchFromSearXNG(query, 5, timeoutMs);
      const took = Date.now() - startedAt;
      recordLatency(took);
      log(`[WebSearch] attempt ${attempt}/${MAX_SEARCH_ATTEMPTS} ok in ${took}ms (${results.length} results)`);
      return formatSearchResults(query, results);
    } catch (err: any) {
      const took = Date.now() - startedAt;
      recordLatency(took);
      lastError = err.message || String(err);
      log(`[WebSearch] attempt ${attempt}/${MAX_SEARCH_ATTEMPTS} failed after ${took}ms: ${lastError}`);
      // Loop continues: retry if budget remains, else exit and report failure.
    }
  }

  return `[Web search for "${query}" failed after ${MAX_SEARCH_ATTEMPTS} attempts within ${deadlineMs}ms budget. SearXNG did not respond in time (last error: ${lastError || "budget exhausted before start"}).]`;
}

/**
 * Format search results as a text block for injection into the stream.
 */
export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `[Web search for "${query}" returned no results. The search service may be unavailable.]`;
  }

  const lines = [`[Web search results for "${query}"]\n`];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   ${r.url}`);
    if (r.snippet) {
      lines.push(`   ${r.snippet}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Maximum bytes to download from a URL. Prevents multi-MB pages from
 * consuming memory and blocking the event loop during regex processing.
 * 500 KB is plenty for text extraction — we only keep 15K chars of output.
 */
const MAX_FETCH_BYTES = 500_000;

/**
 * Maximum HTML input size for regex-based htmlToText(). If the downloaded
 * HTML exceeds this, it is pre-truncated. Since we only keep 15K chars of
 * output, 100K chars of input HTML is more than sufficient.
 */
const MAX_HTML_INPUT_CHARS = 100_000;

/**
 * Fetch a URL with graceful degradation. Never throws.
 *
 * Chain: MCP web_url_read (server-side fetch + markdown) → MCP web_url_read
 * with the r.jina.ai reader prefix (bypasses 403s on bot-hostile hosts) →
 * direct streaming HTTP fetch → error text.
 */
export async function executeWebFetch(url: string, deadlineMs = 10_000): Promise<string> {
  if (isMcpSearxngAvailable()) {
    const direct = await mcpUrlRead(url, 12_000);
    if (direct.ok && isUsefulFetchResult(direct.text)) {
      return truncateContent(direct.text, 15000);
    }
    log(`[WebFetch] MCP web_url_read failed for "${url}" (${direct.ok ? "low-content result" : direct.error}), trying r.jina.ai prefix`);

    const viaJina = await mcpUrlRead(`https://r.jina.ai/${url}`, 12_000);
    if (viaJina.ok && isUsefulFetchResult(viaJina.text)) {
      return truncateContent(viaJina.text, 15000);
    }
    log(`[WebFetch] MCP via r.jina.ai failed for "${url}" (${viaJina.ok ? "low-content result" : viaJina.error}), falling back to direct HTTP`);
  }

  return fetchViaHttp(url, deadlineMs);
}

/**
 * Heuristic: an MCP fetch result that is empty or a bare error/denial page
 * should trigger the next fallback instead of being returned to the model.
 */
function isUsefulFetchResult(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 50) return false;
  if (/^(error|403|404|access denied|forbidden)/i.test(trimmed) && trimmed.length < 300) return false;
  return true;
}

/**
 * Direct HTTP fetch of a URL with HTML → readable text conversion.
 * Uses streaming with a byte cap to avoid loading multi-MB pages into memory,
 * and pre-truncates HTML before regex to prevent event-loop blocking.
 */
async function fetchViaHttp(url: string, deadlineMs = 10_000): Promise<string> {
  try {
    log(`[WebFetch] Fetching: "${url}"`);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(deadlineMs),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Claudish/1.0)",
        Accept: "text/html,application/xhtml+xml,text/plain,*/*",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";

    // Stream the response body with a byte cap to avoid loading
    // multi-MB pages (e.g. HuggingFace model cards) into memory.
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let truncated = false;
    const reader = response.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.length;
        if (totalBytes > MAX_FETCH_BYTES) {
          log(`[WebFetch] Body exceeded ${MAX_FETCH_BYTES} bytes after ${totalBytes} bytes, truncating download`);
          truncated = true;
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Decode collected chunks
    const decoder = new TextDecoder();
    let body = chunks.map(c => decoder.decode(c, { stream: true })).join("") + decoder.decode();

    // If it's already plain text or JSON, return as-is (truncated)
    if (contentType.includes("text/plain") || contentType.includes("application/json")) {
      return truncateContent(body, 15000);
    }

    // HTML content — pre-truncate before regex to prevent CPU spikes,
    // then strip tags and decode entities
    if (contentType.includes("text/html") || body.trimStart().startsWith("<")) {
      if (body.length > MAX_HTML_INPUT_CHARS) {
        log(`[WebFetch] Pre-truncating HTML: ${body.length} → ${MAX_HTML_INPUT_CHARS} chars before regex`);
        body = body.slice(0, MAX_HTML_INPUT_CHARS);
      }
      const text = htmlToText(body);
      log(`[WebFetch] Converted HTML to text: ${body.length} → ${text.length} chars${truncated ? " (download truncated)" : ""}`);
      return truncateContent(text, 15000);
    }

    // Unknown content type — return truncated raw text
    return truncateContent(body, 15000);
  } catch (err: any) {
    log(`[WebFetch] Error fetching "${url}": ${err.message}`);
    return `[Web fetch for "${url}" failed: ${err.message}]`;
  }
}

/**
 * Basic HTML → plain text conversion.
 * Strips tags, decodes entities, normalizes whitespace.
 * Enhanced: extracts main content when possible, removes navigation chrome.
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove script and style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Remove SVG blocks (common in GitHub navigation chrome)
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  text = text.replace(/<path\b[^>]*>/gi, "");

  // Try to extract main content area before stripping tags.
  // Many sites (GitHub, docs) use <main>, <article>, or role="main".
  const mainContent =
    text.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
    text.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
    text.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/\w+>/i)?.[1];
  if (mainContent && mainContent.length > 200) {
    text = mainContent;
  }

  // Remove <nav>, <header>, <footer> blocks (navigation chrome)
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");

  // Convert common block elements to newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|br|tr|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Add newlines before headings for better readability
  text = text.replace(/<h[1-6][^>]*>/gi, "\n\n");

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Collapse excessive whitespace (3+ newlines → 2)
  text = text.replace(/\n{3,}/g, "\n\n");
  // Collapse excessive spaces
  text = text.replace(/[ \t]+/g, " ");

  return text.trim();
}

/**
 * Heuristic: detect low-quality web content that is mostly navigation chrome
 * rather than useful page content. Used to decide whether to re-fetch via MCP
 * or at least clean up the content.
 */
export function isLowQualityWebContent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 100) return false;

  // Known navigation chrome markers (GitHub, docs sites, etc.)
  const chromeMarkers = [
    "Skip to content",
    "Navigation Menu",
    "Toggle navigation",
    "Appearance settings",
    "Sign in",
    "PlatformAI",
    "DEVELOPER WORKFLOWS",
    "APPLICATION SECURITY",
    "EXPLORE BY TOPIC",
    "SUPPORT & SERVICES",
  ];
  const chromeHits = chromeMarkers.filter(m => trimmed.includes(m)).length;
  if (chromeHits >= 3) return true;

  // SVG path data (indicates raw HTML rendering artifacts)
  if (/M\d+\.\d+ \d+\.\d+[a-z]\d+/.test(trimmed)) return true;

  // High ratio of markdown links to text — many `[text](url)` patterns
  const linkCount = (trimmed.match(/\[([^\]]{1,50})\]\([^)]+\)/g) || []).length;
  const lineCount = trimmed.split("\n").filter(l => l.trim().length > 0).length;
  if (linkCount > 20 && linkCount / lineCount > 0.4) return true;

  return false;
}

/**
 * Extract the original URL from web content that Claude Code fetched.
 * Looks for the first identifiable URL pattern in the content.
 */
export function extractUrlFromWebContent(text: string): string | null {
  // Try to find a URL in the first 500 chars (often near the title)
  const head = text.substring(0, 500);

  // GitHub pattern: the title line often contains the repo URL
  const githubMatch = head.match(/github\.com\/[\w.-]+\/[\w.-]+/);
  if (githubMatch) return `https://${githubMatch[0]}`;

  // Generic URL: first http(s) link
  const urlMatch = head.match(/https?:\/\/[^\s)\]"']+/);
  if (urlMatch) return urlMatch[0];

  // Search entire content for a markdown link that looks like the page URL
  const mdLink = text.match(/\]\((https?:\/\/[^\s)]+)\)/);
  if (mdLink) return mdLink[1];

  return null;
}

/**
 * Clean raw web content that arrived as poorly-converted HTML/markdown.
 * Strips navigation chrome, normalizes structure, keeps only useful text.
 */
export function cleanRawWebContent(text: string): string {
  let cleaned = text;

  // Remove common navigation chrome sections (markdown form)
  // GitHub-specific: the long navigation block at the top
  cleaned = cleaned.replace(/Skip to content[\s\S]*?(?=##|\n[A-Z][a-z])/i, "");

  // Remove SVG path data lines
  cleaned = cleaned.replace(/^[ \t]*M\d+\.\d+.*$/gm, "");

  // Remove lines that are just navigation links (short lines with markdown links)
  const lines = cleaned.split("\n");
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return true;
    if (trimmed.length < 3) return false;
    if (/^\[.+\]\(.*\)$/.test(trimmed) && trimmed.length < 60) return false;
    if (/^-{3,}$/.test(trimmed)) return false;
    return true;
  });

  cleaned = filtered.join("\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return truncateContent(cleaned.trim(), 15000);
}

/**
 * Truncate content to a maximum length, adding an ellipsis if truncated.
 */
function truncateContent(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n\n[... content truncated at ${maxLen} chars. Original length: ${text.length} chars]`;
}

/**
 * Extract the search query from a web_search tool call's arguments JSON.
 */
export function extractSearchQuery(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson);
    return args.query || args.q || args.search_query || args.keyword || "";
  } catch {
    // If args aren't valid JSON, try to extract from raw string
    const match = argsJson.match(/"query"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
    const match2 = argsJson.match(/"q"\s*:\s*"([^"]+)"/);
    if (match2) return match2[1];
    return "";
  }
}
