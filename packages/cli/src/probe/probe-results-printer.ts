/**
 * probe-results-printer — bordered-card ANSI printer for the final probe results.
 *
 * This module exists to sidestep OpenTUI's in-place reconciliation bug that
 * garbles the final results panel when the component tree changes shape
 * between the "running" (progress bars) phase and the "complete" (results
 * table) phase. The live phase still runs through OpenTUI React; once the
 * renderer is shut down, the static results are printed to stderr as plain
 * ANSI text that persists in the scrollback without any diff-based redraws.
 *
 * The output is rendered as one bordered card per model. Each card contains
 * a chain table with provider/spec/status columns, optional error detail
 * sub-rows, and a compact key/wire footer.
 */

import {
  isFailureState,
  isReadyState,
  type ProbeResult,
} from "../providers/probe-live.js";
import { type KeyProvenance } from "../providers/api-key-provenance.js";

const pc = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  brightGreen: "\x1b[92m",
  gray: "\x1b[90m",
  // Background color for the fastest live provider row (dark green highlight).
  bgFastest: "\x1b[48;5;22m",
  // Background color for the slowest live provider row (muted rust — softer than pure red).
  bgSlowest: "\x1b[48;5;95m",
} as const;

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Visual (display) length of a string, ignoring ANSI escape sequences. */
function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

/** Pad a string (which may contain ANSI codes) to a target visible width. */
function padVisible(
  s: string,
  width: number,
  align: "left" | "right" = "left",
): string {
  const vis = visibleLength(s);
  if (vis >= width) return s;
  const pad = " ".repeat(width - vis);
  return align === "left" ? s + pad : pad + s;
}

/** Truncate a plain string to max display width, appending an ellipsis. */
function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return s.slice(0, max - 1) + "…";
}

/** Word-wrap a plain string into lines no wider than maxWidth. Splits on whitespace. */
function wordWrap(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    // Handle a single word that is longer than maxWidth by hard-breaking it.
    if (word.length > maxWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }
      let remaining = word;
      while (remaining.length > maxWidth) {
        lines.push(remaining.slice(0, maxWidth));
        remaining = remaining.slice(maxWidth);
      }
      current = remaining;
      continue;
    }
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxWidth) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export interface ChainEntry {
  provider: string;
  displayName: string;
  modelSpec: string;
  hasCredentials: boolean;
  credentialHint?: string;
  provenance?: KeyProvenance;
  probe?: ProbeResult;
}

export interface WiringInfo {
  formatAdapter: string;
  declaredStreamFormat: string;
  modelTranslator: string;
  contextWindow: number;
  supportsVision: boolean;
  transportOverride: string | null;
  effectiveStreamFormat: string;
}

export interface ModelResult {
  model: string;
  nativeProvider: string;
  isExplicit: boolean;
  routingSource: "direct" | "custom-rules" | "auto-chain";
  matchedPattern?: string;
  chain: ChainEntry[];
  directProbe?: ProbeResult;
  wiring?: WiringInfo;
}

type Writer = (s: string) => boolean;

const MIN_CARD_WIDTH = 60;
const CARD_PADDING_LEFT = 2; // spaces between '│' and first cell
const CARD_PADDING_RIGHT = 2;

function summaryColor(live: number, total: number): string {
  if (total === 0 || live === 0) return pc.red;
  if (live === total) return pc.green;
  return pc.yellow;
}

function shortStatusLabel(probe: ProbeResult | undefined, hasCreds: boolean, _hint?: string): string {
  if (!probe) {
    if (hasCreds) return `${pc.green}● ready${pc.reset}`;
    return `${pc.dim}${pc.red}○ missing${pc.reset}`;
  }
  switch (probe.state) {
    case "live":
      return `${pc.green}✓ ${probe.latencyMs}ms${pc.reset}`;
    case "key-missing":
      return `${pc.dim}${pc.red}○ missing${pc.reset}`;
    case "auth-failed":
      return `${pc.red}⊗ auth ${probe.httpStatus ?? ""}${pc.reset}`.replace(/\s+\u001b/, "\u001b");
    case "model-not-found":
      return `${pc.red}⊗ not found${pc.reset}`;
    case "rate-limited":
      return `${pc.red}⊗ rate-limited${pc.reset}`;
    case "server-error":
      return `${pc.red}⊗ server ${probe.httpStatus ?? ""}${pc.reset}`;
    case "timeout":
      return `${pc.red}⊗ timeout ${Math.round(probe.latencyMs / 1000)}s${pc.reset}`;
    case "network-error":
      return `${pc.red}⊗ network${pc.reset}`;
    case "error":
      return `${pc.red}⊗ error${probe.httpStatus ? ` ${probe.httpStatus}` : ""}${pc.reset}`;
  }
  return `${pc.red}⊗ unknown${pc.reset}`;
}

function renderBorderTop(title: string, summary: string, width: number): string {
  // ┌─ {title} ─...─ {summary} ─┐
  // The total width includes the corners.
  const titleSeg = ` ${title} `;
  const summarySeg = ` ${summary} `;
  const titleVis = visibleLength(titleSeg);
  const summaryVis = visibleLength(summarySeg);
  // Layout: ┌─{title}─...─{summary}─┐
  // chars used: 2 corners + 1 left dash + 1 right dash + titleVis + summaryVis = width
  // middle dashes = width - 2 - 2 - titleVis - summaryVis
  const middleDashes = width - 4 - titleVis - summaryVis;
  const middle = "─".repeat(Math.max(1, middleDashes));
  return (
    `${pc.dim}┌─${pc.reset}` +
    titleSeg +
    `${pc.dim}${middle}${pc.reset}` +
    summarySeg +
    `${pc.dim}─┐${pc.reset}`
  );
}

function renderBorderBottom(width: number): string {
  return `${pc.dim}└${"─".repeat(width - 2)}┘${pc.reset}`;
}

function renderBlankLine(width: number): string {
  // │ ... spaces ... │
  return `${pc.dim}│${pc.reset}${" ".repeat(width - 2)}${pc.dim}│${pc.reset}`;
}

/**
 * Render a generic "raw text" line inside the card with left padding.
 * The provided body must already account for any ANSI codes — we'll measure
 * with visibleLength. If `bg` is provided, the entire inner content is wrapped
 * with that background color (for zebra-striping continuity with adjacent rows).
 */
function renderTextLine(body: string, width: number, bg?: string): string {
  // │  {body}{spaces}  │
  // inner width = width - 2 (borders)
  const inner = width - 2;
  const leftPad = " ".repeat(CARD_PADDING_LEFT);
  const rightPad = " ".repeat(CARD_PADDING_RIGHT);
  const usable = inner - CARD_PADDING_LEFT - CARD_PADDING_RIGHT;
  let content = body;
  if (visibleLength(content) > usable) {
    // Truncate plain (we don't try to be ANSI-clever for footers)
    content = truncate(stripAnsi(content), usable);
  }
  const padded = padVisible(content, usable, "left");
  if (bg) {
    // Re-apply bg after every reset within the body so the stripe stays continuous
    const tinted = padded.replace(/\x1b\[0m/g, `\x1b[0m${bg}`);
    return `${pc.dim}│${pc.reset}${bg}${leftPad}${tinted}${rightPad}${pc.reset}${pc.dim}│${pc.reset}`;
  }
  return `${pc.dim}│${pc.reset}${leftPad}${padded}${rightPad}${pc.dim}│${pc.reset}`;
}

/**
 * Render a chain-table row with column separators.
 * cells/widths arrays must have matching length. Each cell may contain ANSI.
 * If `bg` is provided, the entire inner row content is wrapped with that
 * background color (for zebra-striping). The border `│` chars stay un-tinted.
 */
function renderRow(
  cells: string[],
  widths: number[],
  width: number,
  bg?: string,
): string {
  // Layout:
  // │  c0 │ c1 │ c2 │ c3  │
  // inner = width - 2
  const inner = width - 2;
  const leftPad = " ".repeat(CARD_PADDING_LEFT);
  const rightPad = " ".repeat(CARD_PADDING_RIGHT);

  const padded: string[] = cells.map((c, i) => padVisible(c, widths[i], "left"));
  // Column separator: when zebra background is active, the bg must extend
  // through the separator too — so we use the bg color on the spaces but keep
  // the `│` dim. We re-apply the bg right after each reset so the stripe
  // doesn't break.
  const sep = bg
    ? ` ${pc.dim}│${pc.reset}${bg} `
    : ` ${pc.dim}│${pc.reset} `;
  const sepVis = 3; // " │ "
  const fixedUsed =
    CARD_PADDING_LEFT +
    widths.reduce((a, b) => a + b, 0) +
    (cells.length - 1) * sepVis +
    CARD_PADDING_RIGHT;
  // If fixedUsed < inner, pad the last cell further to fill.
  if (fixedUsed < inner) {
    const extra = inner - fixedUsed;
    padded[padded.length - 1] = padded[padded.length - 1] + " ".repeat(extra);
  }

  // When applying a background, we must re-apply `bg` after each cell's
  // internal `pc.reset` so the stripe stays continuous across colored text.
  const body = bg
    ? padded.map((cell) => cell.replace(/\x1b\[0m/g, `\x1b[0m${bg}`)).join(sep)
    : padded.join(sep);

  if (bg) {
    return (
      `${pc.dim}│${pc.reset}${bg}${leftPad}${body}${rightPad}${pc.reset}${pc.dim}│${pc.reset}`
    );
  }
  return (
    `${pc.dim}│${pc.reset}${leftPad}${body}${rightPad}${pc.dim}│${pc.reset}`
  );
}

/**
 * Render the separator row: ├───┼──────┼──────────┼──────────┤
 * Spans the entire card width from the left border to the right border,
 * using `├` and `┤` corners so it merges cleanly with the vertical borders.
 */
function renderSepRow(widths: number[], width: number): string {
  // inner = width - 2 (the two corner cells)
  const inner = width - 2;
  // We want to place `┼` tees at the same columns where ` │ ` column
  // separators appear in a data row. In a data row the layout inside the
  // borders is:
  //   leftPad + c0 + " │ " + c1 + " │ " + c2 + " │ " + c3 + trailing + rightPad
  // so the tee for the i-th separator sits at visual column:
  //   leftPad + widths[0] + 1 (space) + ... + widths[i] + 1
  // We rebuild that exact layout but fill every non-tee position with `─`.
  const n = widths.length;
  const teeCols: number[] = [];
  let col = CARD_PADDING_LEFT;
  for (let i = 0; i < n - 1; i++) {
    col += widths[i];
    col += 1; // leading space of " │ "
    teeCols.push(col);
    col += 2; // "│ " chars that follow the leading space
  }
  // Build a buffer of length `inner` filled with dashes, then place tees.
  const buf: string[] = new Array(inner).fill("─");
  for (const c of teeCols) {
    if (c >= 0 && c < inner) buf[c] = "┼";
  }
  const body = buf.join("");
  return `${pc.dim}├${body}┤${pc.reset}`;
}

interface RowData {
  num: string;
  provider: string;
  spec: string;
  status: string;
  errorDetail?: string;
  /** True if this is the fastest live provider in the chain (green bg) */
  fastest?: boolean;
  /** True if this is the slowest live provider in the chain (red bg) */
  slowest?: boolean;
}

function buildRowData(result: ModelResult, isLiveProbe: boolean): RowData[] {
  // Find fastest and slowest live providers by latency.
  // Only highlight if there are 2+ live providers (no point marking 1 as both).
  let fastestIdx = -1;
  let slowestIdx = -1;
  if (isLiveProbe) {
    let fastestLatency = Infinity;
    let slowestLatency = -Infinity;
    let liveCount = 0;
    result.chain.forEach((entry, i) => {
      if (entry.probe?.state === "live") {
        liveCount++;
        if (entry.probe.latencyMs < fastestLatency) {
          fastestLatency = entry.probe.latencyMs;
          fastestIdx = i;
        }
        if (entry.probe.latencyMs > slowestLatency) {
          slowestLatency = entry.probe.latencyMs;
          slowestIdx = i;
        }
      }
    });
    // Don't mark slowest if only 1 live provider (it's also the fastest)
    if (liveCount < 2) slowestIdx = -1;
  }

  return result.chain.map((entry, i) => {
    const isFastest = i === fastestIdx;
    const isSlowest = i === slowestIdx;

    let status = shortStatusLabel(entry.probe, entry.hasCredentials, entry.credentialHint);
    if (isFastest) {
      status = `${status} ${pc.brightGreen}●${pc.reset}`;
    }

    let errorDetail: string | undefined;
    if (entry.probe && isFailureState(entry.probe.state) && entry.probe.errorMessage) {
      errorDetail = stripAnsi(entry.probe.errorMessage).replace(/\s+/g, " ").trim();
    }

    return {
      num: `${i + 1}`,
      provider: entry.displayName,
      spec: entry.modelSpec,
      status,
      errorDetail,
      fastest: isFastest,
      slowest: isSlowest,
    };
  });
}

function buildDirectRowData(result: ModelResult): RowData[] {
  const probe = result.directProbe;
  let status: string;
  if (!probe) {
    status = `${pc.dim}— no probe —${pc.reset}`;
  } else {
    status = shortStatusLabel(probe, true);
    if (probe.state === "live") {
      status = `${status} ${pc.brightGreen}●${pc.reset}`;
    }
  }
  let errorDetail: string | undefined;
  if (probe && isFailureState(probe.state) && probe.errorMessage) {
    errorDetail = stripAnsi(probe.errorMessage).replace(/\s+/g, " ").trim();
  }
  return [
    {
      num: "1",
      provider: result.nativeProvider,
      spec: `${result.nativeProvider}@${result.model}`,
      status,
      errorDetail,
    },
  ];
}

function computeColumnWidths(rows: RowData[]): number[] {
  const headers = ["#", "Provider", "Model Spec", "Status"];
  const wNum = Math.max(headers[0].length, ...rows.map((r) => r.num.length));
  const wProv = Math.max(headers[1].length, ...rows.map((r) => visibleLength(r.provider)));
  const wSpec = Math.max(headers[2].length, ...rows.map((r) => visibleLength(r.spec)));
  const wStatus = Math.max(headers[3].length, ...rows.map((r) => visibleLength(r.status)));
  return [wNum, wProv, wSpec, wStatus];
}

/**
 * Compute the card width required to fit a single model result, accounting
 * for table columns, top border title/summary, and footer key/wire lines.
 * Also clamps to the current terminal width so callers get a width they
 * can safely render.
 */
function computeCardWidth(
  _rows: RowData[],
  widths: number[],
  topTitleVis: number,
  topSummaryVis: number,
  footerVis: number,
): number {
  // table row width:
  // 2 borders + leftPad + sum(widths) + (n-1)*" │ " + rightPad
  const tableRowWidth =
    2 +
    CARD_PADDING_LEFT +
    widths.reduce((a, b) => a + b, 0) +
    (widths.length - 1) * 3 +
    CARD_PADDING_RIGHT;
  // top border width: 2 corners + 1 left dash + 1 right dash + titleSeg(2 spaces+title) + summarySeg(2 spaces+summary) + at least 1 mid dash
  // ┌─ title ─...─ summary ─┐
  // = 2 (corners) + 2 (─) + (title with surround) + (summary with surround) + 1 (mid dash)
  const topMin = 2 + 2 + (topTitleVis + 2) + (topSummaryVis + 2) + 1;
  // footer width: 2 borders + leftPad + footerVis + rightPad
  const footerMin = 2 + CARD_PADDING_LEFT + footerVis + CARD_PADDING_RIGHT;

  const termCols = process.stderr.columns ?? process.stdout.columns ?? 100;
  const maxAllowed = Math.max(MIN_CARD_WIDTH, termCols - 4);

  let width = Math.max(MIN_CARD_WIDTH, tableRowWidth, topMin, footerMin);
  if (width > maxAllowed) width = maxAllowed;
  return width;
}

function formatContextWindow(ctx: number): string {
  if (ctx <= 0) return "0K";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`;
  return `${Math.round(ctx / 1000)}K`;
}

function buildKeyLine(activeEntry?: ChainEntry, directKeyVar?: string): string {
  if (activeEntry?.provenance) {
    const p = activeEntry.provenance;
    if (p.effectiveValue) {
      return `${pc.bold}Key${pc.reset}  $${p.envVar}  ${pc.dim}(${p.effectiveSource})${pc.reset}`;
    }
    return `${pc.bold}Key${pc.reset}  $${p.envVar}  ${pc.dim}(not set)${pc.reset}`;
  }
  if (directKeyVar) {
    const has = !!process.env[directKeyVar];
    return `${pc.bold}Key${pc.reset}  $${directKeyVar}  ${pc.dim}(${has ? "shell env" : "not set"})${pc.reset}`;
  }
  return `${pc.bold}Key${pc.reset}  ${pc.dim}—${pc.reset}`;
}

function buildWireLine(wiring: WiringInfo, activeProvider?: string): string {
  const ctx = formatContextWindow(wiring.contextWindow);
  const head = activeProvider ? `${activeProvider} → ` : "";
  return `${pc.bold}Wire${pc.reset} ${head}${wiring.effectiveStreamFormat} · ${wiring.modelTranslator} · ${ctx}`;
}

/**
 * Internal: gather all the pre-computed bits needed both to size a card
 * and to render it. Extracted so sizing (pass 1) and rendering (pass 2)
 * don't drift apart.
 */
interface CardLayout {
  rows: RowData[];
  widths: number[];
  titleStyled: string;
  summaryStyled: string;
  keyLine: string;
  wireLine: string;
  footerVis: number;
  activeEntry: ChainEntry | undefined;
}

function buildCardLayout(
  result: ModelResult,
  isLiveProbe: boolean,
  directKeyVar?: string,
): CardLayout {
  const rows =
    result.routingSource === "direct"
      ? buildDirectRowData(result)
      : buildRowData(result, isLiveProbe);

  const totalLinks = rows.length;
  const liveCount = result.chain
    ? result.chain.filter((c) => c.probe?.state === "live").length
    : result.directProbe?.state === "live"
      ? 1
      : 0;
  const effLive = result.routingSource === "direct" ? liveCount : liveCount;
  const effTotal =
    result.routingSource === "direct" ? totalLinks : result.chain.length;

  const titleText = result.model;
  const sumColor = summaryColor(effLive, effTotal);
  const summaryPlain = `${result.nativeProvider} · ${effLive}/${effTotal} live`;
  const titleStyled = `${pc.bold}${pc.cyan}${titleText}${pc.reset}`;
  const summaryStyled = `${sumColor}${summaryPlain}${pc.reset}`;

  const activeEntry =
    result.chain?.find((c) => c.probe?.state === "live") ??
    result.chain?.find((c) => c.hasCredentials);

  const keyLine = buildKeyLine(activeEntry, directKeyVar);
  const wireLine = result.wiring
    ? buildWireLine(
        result.wiring,
        activeEntry?.displayName ?? result.nativeProvider,
      )
    : "";
  const footerVis = Math.max(visibleLength(keyLine), visibleLength(wireLine));

  const widths = computeColumnWidths(rows);

  return {
    rows,
    widths,
    titleStyled,
    summaryStyled,
    keyLine,
    wireLine,
    footerVis,
    activeEntry,
  };
}

/**
 * Return the width (in columns) that a single card would require to fit its
 * content. Used by `printProbeResults` to compute a shared global width
 * across all rendered cards so they line up vertically.
 */
export function computeRequiredWidth(
  result: ModelResult,
  isLiveProbe: boolean,
  directKeyVar?: string,
): number {
  const layout = buildCardLayout(result, isLiveProbe, directKeyVar);
  return computeCardWidth(
    layout.rows,
    layout.widths,
    visibleLength(layout.titleStyled),
    visibleLength(layout.summaryStyled),
    layout.footerVis,
  );
}

function renderCard(
  result: ModelResult,
  isLiveProbe: boolean,
  w: Writer,
  width: number,
  directKeyVar?: string,
): void {
  const layout = buildCardLayout(result, isLiveProbe, directKeyVar);
  const {
    rows,
    widths,
    titleStyled,
    summaryStyled,
    keyLine,
    wireLine,
  } = layout;

  // === Render ===
  w(renderBorderTop(titleStyled, summaryStyled, width) + "\n");
  w(renderBlankLine(width) + "\n");

  // Header row (dim styled headers)
  const headerCells = [
    `${pc.dim}#${pc.reset}`,
    `${pc.dim}Provider${pc.reset}`,
    `${pc.dim}Model Spec${pc.reset}`,
    `${pc.dim}Status${pc.reset}`,
  ];
  w(renderRow(headerCells, widths, width) + "\n");
  w(renderSepRow(widths, width) + "\n");

  // Data rows — only highlight fastest (green bg) and slowest (red bg) live
  // providers. Other rows have no background. Each "logical row" (data row +
  // its optional error sub-rows) shares one bg so error details stay grouped.
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const r = rows[rowIdx];
    const bg = r.fastest
      ? pc.bgFastest
      : r.slowest
        ? pc.bgSlowest
        : undefined;

    const cells = [
      r.num,
      r.provider,
      `${pc.dim}${r.spec}${pc.reset}`,
      r.status,
    ];
    w(renderRow(cells, widths, width, bg) + "\n");

    if (r.errorDetail) {
      // Render the error as a full-width sub-row (or rows) beneath the
      // failed row, word-wrapped to fit the card's inner usable width.
      // Layout inside the card for an error line:
      //   │{leftPad}{errorIndent}└ {text}{pad}{rightPad}│
      // where errorIndent visually insets the error one column past the
      // "#" column so it reads as a child of the failed row.
      const innerUsable =
        width - 2 - CARD_PADDING_LEFT - CARD_PADDING_RIGHT;
      const errorIndent = 4; // 4 spaces of indent inside the usable area
      const prefixVis = 2; // "└ " or "  "
      const textWidth = innerUsable - errorIndent - prefixVis;
      const MAX_ERROR_LINES = 4;

      if (textWidth > 0) {
        let wrapped = wordWrap(r.errorDetail, textWidth);
        let truncated = false;
        if (wrapped.length > MAX_ERROR_LINES) {
          wrapped = wrapped.slice(0, MAX_ERROR_LINES);
          truncated = true;
        }
        if (truncated) {
          const last = wrapped[wrapped.length - 1];
          // Append an ellipsis to the last kept line (replace last char if needed).
          if (last.length >= textWidth) {
            wrapped[wrapped.length - 1] = last.slice(0, textWidth - 1) + "…";
          } else {
            wrapped[wrapped.length - 1] = last + "…";
          }
        }
        const indentStr = " ".repeat(errorIndent);
        for (let i = 0; i < wrapped.length; i++) {
          const prefix = i === 0 ? "└ " : "  ";
          const body = `${indentStr}${pc.dim}${pc.red}${prefix}${wrapped[i]}${pc.reset}`;
          w(renderTextLine(body, width, bg) + "\n");
        }
      }
    }
  }

  w(renderBlankLine(width) + "\n");

  // Footer: Key + Wire
  if (visibleLength(keyLine) > 0) {
    w(renderTextLine(keyLine, width) + "\n");
  }
  if (visibleLength(wireLine) > 0) {
    w(renderTextLine(wireLine, width) + "\n");
  }

  // Routing-source note (custom rules)
  if (result.routingSource === "custom-rules" && result.matchedPattern) {
    const note = `${pc.dim}Custom rule: ${pc.reset}${pc.cyan}${result.matchedPattern}${pc.reset}`;
    w(renderTextLine(note, width) + "\n");
  }

  w(renderBorderBottom(width) + "\n");
}

export function printProbeResults(
  results: ModelResult[],
  isLiveProbe: boolean,
): void {
  const w: Writer = process.stderr.write.bind(process.stderr);

  w("\n");

  // Pass 1: compute required width for each card.
  const requiredWidths = results.map((r) => computeRequiredWidth(r, isLiveProbe));

  // Pick the global width: the max required width, clamped to the terminal.
  const termCols = process.stderr.columns ?? process.stdout.columns ?? 100;
  const maxAllowed = Math.max(MIN_CARD_WIDTH, termCols - 4);
  let globalWidth = requiredWidths.reduce(
    (a, b) => Math.max(a, b),
    MIN_CARD_WIDTH,
  );
  if (globalWidth > maxAllowed) globalWidth = maxAllowed;

  // Pass 2: render each card with the shared width so borders align.
  for (const result of results) {
    renderCard(result, isLiveProbe, w, globalWidth);
    w("\n");
  }

  // Compact tip footer (no legend — cards are self-describing).
  w(
    `  ${pc.dim}Tip: chain order is LiteLLM → Zen Go → Subscription → Native API → OpenRouter${pc.reset}\n`,
  );
  w("\n");

  // Suppress unused-import warnings: keep isReadyState referenced in case
  // future render paths need it. (No-op at runtime.)
  void isReadyState;
}
