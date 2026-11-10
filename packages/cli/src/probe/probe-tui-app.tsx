/** @jsxImportSource @opentui/react */
/**
 * Probe TUI — React component tree rendered with @opentui/react.
 *
 * Renders the LIVE phase only: banner, pipeline steps, and animated progress
 * bars. Once all probes settle, cli.ts shuts down this OpenTUI renderer and
 * prints the static results table via `probe-results-printer.ts`. Doing the
 * final render as plain ANSI avoids an OpenTUI in-place reconciliation bug
 * that garbled the results panel when the component tree changed shape
 * between phases.
 */

import { useEffect, useState } from "react";
import { C } from "../tui/theme.js";
import { VERSION } from "../version.js";

// ── Types ──────────────────────────────────────────────────────────

export interface ProbeStepState {
  name: string;
  status: "pending" | "running" | "done" | "error";
}

export interface ProbeLinkState {
  id: string;
  /** Grouping key — the user-facing model input, e.g. "gpt-4o" */
  model: string;
  /** Provider display name, e.g. "LiteLLM" */
  displayName: string;
  /** Pinned model spec, e.g. "litellm@gpt-4o" */
  modelSpec: string;
  status: "waiting" | "probing" | "live" | "failed";
  startTime?: number;
  endTime?: number;
  error?: string;
}

export interface ProbeAppState {
  steps: ProbeStepState[];
  links: ProbeLinkState[];
}

// ── External store ──────────────────────────────────────────────────

/**
 * A tiny observable state holder. Lives outside React so imperative async
 * code in cli.ts can mutate state via setState() and trigger re-renders.
 */
export class ProbeStore {
  private state: ProbeAppState;
  private listeners: Set<() => void> = new Set();

  constructor(initial: ProbeAppState) {
    this.state = initial;
  }

  getState(): ProbeAppState {
    return this.state;
  }

  setState(updater: (prev: ProbeAppState) => ProbeAppState): void {
    this.state = updater(this.state);
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export function useProbeStore(store: ProbeStore): ProbeAppState {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  return store.getState();
}

/** Bumps a counter every 100ms while active — used for progress bar animation and elapsed timers. */
export function useAnimationFrame(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % 1_000_000), 100);
    return () => clearInterval(id);
  }, [active]);
  return frame;
}

// ── Helpers ────────────────────────────────────────────────────────

const ANIM_FRAMES = ["\u2593", "\u2592", "\u2591", "\u2592"]; // ▓ ▒ ░ ▒
const BAR_WIDTH = 20;

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function padEndSafe(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

// ── Banner ─────────────────────────────────────────────────────────

function Banner() {
  // Big "CLAUD" in orange block letters (6 rows, ~42 cols wide), with a smaller
  // "ish" in green half-block letters — matching the official claudish wordmark
  // where "ish" sits as a small lowercase suffix at the baseline of CLAUD.
  //
  // The "ish" letters use half-block Unicode chars (▀▄█) to pack 6 pixel rows
  // into 3 terminal rows — giving the same vertical pixel density as CLAUD
  // while being visually half the height. "ish" is placed on rows 4-6 of the
  // 6-row CLAUD block (baseline-aligned to CLAUD's bottom).
  const claudLines = [
    "   \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557      \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557 ",
    "  \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557",
    "  \u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551",
    "  \u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551",
    "  \u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551  \u2588\u2588\u2551\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D",
    "   \u255A\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D ",
  ];

  // "ish" rendered as 4 rows of clean serifed ASCII text. Positioned on rows
  // 3-6 of the 6-row CLAUD block (one row lower than before, baseline-aligned
  // to CLAUD's bottom). Each row is wrapped in a brown-background box.
  //
  //   _    _
  //  (_)__| |_
  //  | (_-< ' \
  //  |_/__/_||_|
  const ishLines = [
    "  _    _    ",
    " (_)__| |_  ",
    " | (_-< ' \\ ",
    " |_/__/_||_|",
  ];

  const ishPad = "  "; // 2 spaces between CLAUD and "ish"
  const ishGreen = "#00ff7f"; // bright spring green — pops against dark terminal bg

  // Render one banner row as: orange CLAUD text + gap + bold bright-green ish text.
  const renderBannerRow = (claudLine: string, ishLine: string | null, key: number) => (
    <box key={key} flexDirection="row">
      <text><span fg={C.orange}>{claudLine}</span></text>
      {ishLine !== null && (
        <>
          <text>{ishPad}</text>
          {/* opentui TextNode has no `bold` prop — the attribute was inert */}
          <text><span fg={ishGreen}>{ishLine}</span></text>
        </>
      )}
    </box>
  );

  return (
    <box flexDirection="column">
      {renderBannerRow(claudLines[0], null, 0)}
      {renderBannerRow(claudLines[1], null, 1)}
      {renderBannerRow(claudLines[2], ishLines[0], 2)}
      {renderBannerRow(claudLines[3], ishLines[1], 3)}
      {renderBannerRow(claudLines[4], ishLines[2], 4)}
      {renderBannerRow(claudLines[5], ishLines[3], 5)}
      <text>
        <span fg={C.dim}>{"  Provider Routing Probe"}</span>
        <span fg={C.dim}>{" ".repeat(38)}</span>
        <span fg={C.dim}>{`v${VERSION}`}</span>
      </text>
    </box>
  );
}

// ── Step indicator ─────────────────────────────────────────────────

function StepIndicator({ step }: { step: ProbeStepState }) {
  const iconMap: Record<ProbeStepState["status"], string> = {
    pending: "\u25CB",
    running: "\u25CC",
    done: "\u2713",
    error: "\u2717",
  };
  const colorMap: Record<ProbeStepState["status"], string> = {
    pending: C.dim,
    running: C.cyan,
    done: C.green,
    error: C.red,
  };
  return (
    <text>
      <span>{"  "}</span>
      <span fg={colorMap[step.status]}>
        {iconMap[step.status]} {step.name}
      </span>
    </text>
  );
}

// ── Progress bar row ───────────────────────────────────────────────

function ProgressBar({
  link,
  animFrame,
  maxNameLen,
}: {
  link: ProbeLinkState;
  animFrame: number;
  maxNameLen: number;
}) {
  const elapsedMs =
    link.status === "waiting"
      ? 0
      : link.startTime
        ? (link.endTime ?? Date.now()) - link.startTime
        : 0;
  const elapsed = formatElapsed(elapsedMs);

  let bar: string;
  let barColor: string;
  let statusText: string;
  let statusColor: string;

  switch (link.status) {
    case "waiting":
      bar = "\u2591".repeat(BAR_WIDTH);
      barColor = C.dim;
      statusText = "\u23F3 waiting...";
      statusColor = C.dim;
      break;
    case "probing": {
      let animated = "";
      for (let i = 0; i < BAR_WIDTH; i++) {
        animated += ANIM_FRAMES[(animFrame + i) % ANIM_FRAMES.length];
      }
      bar = animated;
      barColor = C.cyan;
      statusText = "probing...";
      statusColor = C.cyan;
      break;
    }
    case "live": {
      const latency =
        link.endTime && link.startTime ? link.endTime - link.startTime : 0;
      bar = "\u2588".repeat(BAR_WIDTH);
      barColor = C.green;
      statusText = `\u2713 live \u00B7 ${latency}ms`;
      statusColor = C.green;
      break;
    }
    case "failed":
      bar = "\u2717".repeat(BAR_WIDTH);
      barColor = C.red;
      statusText = `\u2717 ${stripAnsi(link.error || "failed")}`;
      statusColor = C.red;
      break;
  }

  const displayName = padEndSafe(link.displayName, maxNameLen);

  return (
    <text>
      <span fg={C.dim}>{`    ${elapsed}  `}</span>
      <span fg={barColor}>{bar}</span>
      <span fg={C.dim}>{"  "}</span>
      <span fg={C.fg}>{displayName}</span>
      <span fg={C.dim}>{"  "}</span>
      <span fg={statusColor}>{statusText}</span>
    </text>
  );
}

// ── Model progress group ───────────────────────────────────────────

function ModelGroup({
  model,
  links,
  animFrame,
  maxNameLen,
  rowWidth,
  isLast,
}: {
  model: string;
  links: ProbeLinkState[];
  animFrame: number;
  maxNameLen: number;
  rowWidth: number;
  isLast: boolean;
}) {
  // Center the model name in a colored header bar that spans the full row width.
  // Use a 2-char left margin so the header aligns with the bar rows below.
  const headerWidth = rowWidth - 2;
  const totalPad = Math.max(0, headerWidth - model.length);
  const leftPad = Math.floor(totalPad / 2);
  const rightPad = totalPad - leftPad;
  const headerText = " ".repeat(leftPad) + model + " ".repeat(rightPad);

  return (
    <box flexDirection="column" marginBottom={isLast ? 0 : 1}>
      {/* Section header — colored bar with centered model name, left-aligned with bars below */}
      <box flexDirection="row">
        <text>{"  "}</text>
        <box backgroundColor="#1e3a5f">
          <text>
            <span fg="#ffffff">
              {headerText}
            </span>
          </text>
        </box>
      </box>
      {links.map((link) => (
        <ProgressBar
          key={link.id}
          link={link}
          animFrame={animFrame}
          maxNameLen={maxNameLen}
        />
      ))}
    </box>
  );
}

// ── Main app ───────────────────────────────────────────────────────

export function ProbeApp({ store }: { store: ProbeStore }) {
  const state = useProbeStore(store);
  const animFrame = useAnimationFrame(true);

  // Group links by model preserving insertion order
  const groups: Array<{ model: string; links: ProbeLinkState[] }> = [];
  for (const link of state.links) {
    let group = groups.find((g) => g.model === link.model);
    if (!group) {
      group = { model: link.model, links: [] };
      groups.push(group);
    }
    group.links.push(link);
  }

  // Shared max name length so bars align across all groups
  const maxNameLen = Math.min(
    25,
    Math.max(...state.links.map((l) => l.displayName.length), 12),
  );

  // Compute fixed row width for the centered model header bar.
  // Layout: "    MM:SS  {bar:20}  {name:N}  {status}"
  // Fixed prefix: 4 + 5 + 2 + 20 + 2 + maxNameLen + 2 = 35 + maxNameLen
  // Use a generous status width (e.g. 25) for the header bar span.
  const rowWidth = 4 + 5 + 2 + BAR_WIDTH + 2 + maxNameLen + 2 + 25;

  return (
    <box flexDirection="column">
      <Banner />
      <box flexDirection="column" paddingY={1}>
        {state.steps.map((step, i) => (
          <StepIndicator key={`${step.name}-${i}`} step={step} />
        ))}
      </box>

      {groups.length > 0 ? (
        <box flexDirection="column">
          {groups.map((g, idx) => (
            <ModelGroup
              key={g.model}
              model={g.model}
              links={g.links}
              animFrame={animFrame}
              maxNameLen={maxNameLen}
              rowWidth={rowWidth}
              isLast={idx === groups.length - 1}
            />
          ))}
        </box>
      ) : null}
    </box>
  );
}
