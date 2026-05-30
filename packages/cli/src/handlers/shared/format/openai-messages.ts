/**
 * OpenAI message format conversion utilities.
 *
 * Converts Claude/Anthropic message format to OpenAI message format.
 */

/**
 * Convert Claude/Anthropic messages to OpenAI format
 * @param simpleFormat - If true, use simple string content only (for MLX and other basic providers)
 */
export function convertMessagesToOpenAI(
  req: any,
  modelId: string,
  filterIdentityFn?: (s: string) => string,
  simpleFormat = false
): any[] {
  const messages: any[] = [];

  if (req.system) {
    let content = Array.isArray(req.system)
      ? req.system.map((i: any) => i.text || i).join("\n\n")
      : req.system;
    if (filterIdentityFn) content = filterIdentityFn(content);
    messages.push({ role: "system", content });
  }

  // Add instruction for Grok models to use proper tool format
  if (modelId.includes("grok") || modelId.includes("x-ai")) {
    const msg =
      "IMPORTANT: When calling tools, you MUST use the OpenAI tool_calls format with JSON. NEVER use XML format like <xai:function_call>.";
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0].content += `\n\n${msg}`;
    } else {
      messages.unshift({ role: "system", content: msg });
    }
  }

  if (req.messages) {
    for (const msg of req.messages) {
      if (msg.role === "user") processUserMessage(msg, messages, simpleFormat);
      else if (msg.role === "assistant") processAssistantMessage(msg, messages, simpleFormat);
      else if (msg.role === "system") {
        // Inline system messages (Claude Code v2.1.153+): merge into the system prompt
        // or prepend as a user message if no system prompt exists.
        const content = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c: any) => c.text || "").join("\n")
            : "";
        if (content) {
          if (messages.length > 0 && messages[0].role === "system") {
            messages[0].content += "\n\n" + content;
          } else {
            messages.unshift({ role: "system", content });
          }
        }
      }
    }
  }

  return messages;
}

function imageBlockToUrlPart(block: any): any {
  return {
    type: "image_url",
    image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
  };
}

function processUserMessage(msg: any, messages: any[], simpleFormat = false) {
  if (Array.isArray(msg.content)) {
    const textParts: string[] = [];
    const contentParts: any[] = [];
    const toolResults: any[] = [];
    // Images pulled out of tool_result content. OpenAI tool/function messages
    // cannot carry images, so we forward them as a following user message —
    // NOT JSON.stringify'd into the tool output (a screenshot's base64 there
    // becomes ~100k text tokens per image and blows the context window).
    const toolResultImages: any[] = [];
    const seen = new Set<string>();

    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
        if (!simpleFormat) {
          contentParts.push({ type: "text", text: block.text });
        }
      } else if (block.type === "image") {
        if (!simpleFormat) {
          contentParts.push(imageBlockToUrlPart(block));
        }
        // Skip images in simple format - MLX doesn't support vision
      } else if (block.type === "tool_result") {
        if (seen.has(block.tool_use_id)) continue;
        seen.add(block.tool_use_id);

        // Split tool_result content into text (stays in the tool message) and
        // images (forwarded as a user message). String content passes through.
        let resultText: string;
        if (typeof block.content === "string") {
          resultText = block.content;
        } else if (Array.isArray(block.content)) {
          const texts: string[] = [];
          const others: any[] = [];
          for (const inner of block.content) {
            if (inner.type === "text") {
              texts.push(inner.text);
            } else if (inner.type === "image" && inner.source) {
              if (!simpleFormat) toolResultImages.push(imageBlockToUrlPart(inner));
            } else {
              others.push(inner);
            }
          }
          resultText = texts.join("\n");
          if (others.length) resultText += (resultText ? "\n" : "") + JSON.stringify(others);
          // Tool/function messages must be non-empty; point at the forwarded image.
          if (!resultText) {
            resultText = toolResultImages.length ? "[image returned; see following message]" : "";
          }
        } else {
          resultText = JSON.stringify(block.content);
        }

        if (simpleFormat) {
          // In simple format, include tool results as text in user message
          textParts.push(`[Tool Result]: ${resultText}`);
        } else {
          toolResults.push({
            role: "tool",
            content: resultText,
            tool_call_id: block.tool_use_id,
          });
        }
      }
    }

    if (simpleFormat) {
      // Simple format: just concatenate all text
      if (textParts.length) {
        messages.push({ role: "user", content: textParts.join("\n\n") });
      }
    } else {
      if (toolResults.length) messages.push(...toolResults);
      // Images from tool results ride in their own user message, after the tool
      // outputs they came from (OpenAI requires tool messages to directly follow
      // the assistant tool_calls; a user image message may follow).
      if (toolResultImages.length) messages.push({ role: "user", content: toolResultImages });
      if (contentParts.length) messages.push({ role: "user", content: contentParts });
    }
  } else {
    messages.push({ role: "user", content: msg.content });
  }
}

function processAssistantMessage(msg: any, messages: any[], simpleFormat = false) {
  if (Array.isArray(msg.content)) {
    const strings: string[] = [];
    const toolCalls: any[] = [];
    const seen = new Set<string>();
    let reasoningContent = "";
    let hasThinking = false;

    for (const block of msg.content) {
      if (block.type === "text") {
        strings.push(block.text);
      } else if (block.type === "thinking") {
        // Accumulate thinking content to send back as reasoning_content.
        // Track presence regardless of content — Kimi K2.5 requires the field
        // even when the thinking text is empty.
        // Skip in simpleFormat (same as tool calls).
        if (!simpleFormat) {
          hasThinking = true;
          reasoningContent += block.thinking || "";
        }
      } else if (block.type === "tool_use") {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
        if (simpleFormat) {
          // In simple format, include tool calls as text
          strings.push(`[Tool Call: ${block.name}]: ${JSON.stringify(block.input)}`);
        } else {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }
    }

    if (simpleFormat) {
      // Simple format: just string content, no tool_calls
      if (strings.length) {
        messages.push({ role: "assistant", content: strings.join("\n") });
      }
    } else {
      const m: any = { role: "assistant" };
      if (strings.length) m.content = strings.join(" ");
      else if (toolCalls.length) m.content = null;
      if (toolCalls.length) m.tool_calls = toolCalls;
      // Include reasoning_content whenever ANY thinking block was present,
      // even if the concatenated text is empty — Kimi K2.5 rejects turn 2+
      // with HTTP 400 if the field is missing after thinking was active.
      if (hasThinking) m.reasoning_content = reasoningContent;
      if (m.content !== undefined || m.tool_calls) messages.push(m);
    }
  } else {
    messages.push({ role: "assistant", content: msg.content });
  }
}
