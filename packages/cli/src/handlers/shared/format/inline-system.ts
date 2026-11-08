/**
 * Inline `role: "system"` messages in messages[] — Anthropic-transport wire.
 *
 * Claude Code v2.1.153+ injects system messages inline, and there are TWO kinds
 * that must not be treated alike:
 *
 *  - index 0 — our own injection (e.g. the conservative-mode fallback notice).
 *    A genuine system instruction: it belongs in the top-level system field.
 *
 *  - index > 0 — Claude Code's mid-turn injections, which include THE USER'S OWN
 *    MESSAGE typed while the turn was still running:
 *
 *        <system-reminder>
 *        The user sent a new message while you were working:
 *        <their message>
 *        ...Address the message above as you continue this turn.
 *        </system-reminder>
 *
 *    For these the POSITION is the payload — CC places them deliberately
 *    alongside the tool result the model is about to read. Hoisting them into
 *    the system prompt buries the steer at the head of a multi-hundred-KB body
 *    and it is silently lost. Measured on po-2024 (2026-08-28): a steer landing
 *    at message 114/141 went unaddressed for 52 messages, until the user
 *    re-asked 7 minutes later.
 *
 * Z.AI/MiniMax/Kimi accept no role but user/assistant, which is why these
 * messages cannot simply be forwarded as-is. Converting them in place to
 * role:"user" satisfies that constraint while preserving the position — and it
 * is exactly how Claude Code emits every OTHER system-reminder natively.
 */
export function resolveInlineSystemMessages(
  messages: any[],
  system: unknown
): { messages: any[]; system: unknown; inlined: number } {
  const hoistedTexts: string[] = [];
  let inlined = 0;
  const rebuilt: any[] = [];

  messages.forEach((msg: any, idx: number) => {
    if (msg?.role !== "system") {
      rebuilt.push(msg);
      return;
    }
    const text =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((c: any) => c.text || "").join("\n")
          : "";
    if (!text) return;

    if (idx === 0) {
      hoistedTexts.push(text);
      return;
    }

    inlined++;
    const prev = rebuilt[rebuilt.length - 1];
    if (prev && prev.role === "user") {
      // Coalesce, so the wire never carries two consecutive user turns.
      const prevBlocks = Array.isArray(prev.content)
        ? prev.content
        : [{ type: "text", text: String(prev.content) }];
      rebuilt[rebuilt.length - 1] = { ...prev, content: [...prevBlocks, { type: "text", text }] };
    } else {
      rebuilt.push({ role: "user", content: [{ type: "text", text }] });
    }
  });

  let nextSystem = system;
  if (hoistedTexts.length > 0) {
    const merged = hoistedTexts.join("\n\n");
    if (system) {
      const existing = Array.isArray(system)
        ? system.map((s: any) => s.text || s).join("\n\n")
        : String(system);
      nextSystem = existing + "\n\n" + merged;
    } else {
      nextSystem = merged;
    }
  }

  return { messages: rebuilt, system: nextSystem, inlined };
}
