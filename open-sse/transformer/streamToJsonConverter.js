/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 *
 * Mid-stream network failures (undici `TypeError: terminated` on TLS abort) must
 * not discard already-received output: salvage partial items and mark status
 * incomplete instead of throwing away the whole conversion.
 */

const EMPTY_USAGE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

function textOfMessage(item) {
  if (!Array.isArray(item?.content)) return null;
  const part = item.content.find((c) => c?.type === "output_text" || typeof c?.text === "string");
  return typeof part?.text === "string" ? part.text : null;
}

function textOfReasoning(item) {
  if (!Array.isArray(item?.summary)) return null;
  const part = item.summary.find((s) => s?.type === "summary_text" || typeof s?.text === "string");
  return typeof part?.text === "string" ? part.text : null;
}

function argsOfTool(item) {
  if (item?.type === "custom_tool_call") {
    return typeof item.input === "string" ? item.input : null;
  }
  return typeof item?.arguments === "string" ? item.arguments : null;
}

/**
 * Merge two items of the same type.
 * `preferIncomingText=true` → incoming carries the FULL text (done/completed events);
 * otherwise incoming is a delta fragment to append.
 */
function mergeItem(existing, incoming, preferIncomingText = false) {
  if (!incoming) return existing;
  if (!existing) return incoming;
  const type = incoming.type || existing.type;

  if (type === "message") {
    const existingText = textOfMessage(existing) ?? "";
    const incomingText = textOfMessage(incoming);
    if (incomingText == null) return { ...existing, ...incoming };
    const text = preferIncomingText
      ? (incomingText || existingText)
      : existingText + incomingText;
    return {
      ...existing,
      ...incoming,
      content: [{ type: "output_text", text, annotations: [] }],
    };
  }

  if (type === "reasoning") {
    const existingText = textOfReasoning(existing) ?? "";
    const incomingText = textOfReasoning(incoming);
    if (incomingText == null) return { ...existing, ...incoming };
    const text = preferIncomingText
      ? (incomingText || existingText)
      : existingText + incomingText;
    return {
      ...existing,
      ...incoming,
      summary: [{ type: "summary_text", text }],
    };
  }

  if (type === "function_call" || type === "custom_tool_call") {
    const existingArgs = argsOfTool(existing) ?? "";
    const incomingArgs = argsOfTool(incoming);
    // Delta events often omit name/call_id — never let empty strings clobber
    // metadata already learned from output_item.added.
    const merged = { ...existing };
    for (const key of Object.keys(incoming)) {
      const v = incoming[key];
      if (v !== "" && v != null) merged[key] = v;
      else if (!(key in merged)) merged[key] = v;
    }
    if (incomingArgs == null) return merged;
    const next = preferIncomingText
      ? (incomingArgs || existingArgs)
      : existingArgs + incomingArgs;
    return type === "custom_tool_call"
      ? { ...merged, input: next }
      : { ...merged, arguments: next };
  }

  return { ...existing, ...incoming };
}

function putItem(map, index, item, preferIncomingText = false) {
  const existing = map.get(index);
  map.set(index, mergeItem(existing, item, preferIncomingText));
}

/**
 * Fold a partial/delta event into state so a mid-stream abort can salvage text.
 * Returns true when the event was recognized as a partial.
 */
function applyPartialEvent(eventType, data, state) {
  const index = data.output_index ?? 0;

  if (eventType === "response.output_item.added") {
    if (data.item) putItem(state.partialItems, index, data.item, false);
    return true;
  }

  if (eventType === "response.output_text.delta") {
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return true;
    putItem(state.partialItems, index, {
      id: data.item_id || `msg_${state.responseId || "x"}_${index}`,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: delta, annotations: [] }],
    }, false);
    return true;
  }

  if (eventType === "response.output_text.done") {
    const text = typeof data.text === "string" ? data.text : "";
    putItem(state.partialItems, index, {
      id: data.item_id || `msg_${state.responseId || "x"}_${index}`,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    }, true);
    return true;
  }

  if (eventType === "response.reasoning_summary_text.delta") {
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return true;
    putItem(state.partialItems, index, {
      id: data.item_id || `rs_${state.responseId || "x"}_${index}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: delta }],
    }, false);
    return true;
  }

  if (eventType === "response.reasoning_summary_text.done") {
    const text = typeof data.text === "string" ? data.text : "";
    putItem(state.partialItems, index, {
      id: data.item_id || `rs_${state.responseId || "x"}_${index}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text }],
    }, true);
    return true;
  }

  if (
    eventType === "response.function_call_arguments.delta" ||
    eventType === "response.custom_tool_call_input.delta"
  ) {
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return true;
    const isCustom = eventType.startsWith("response.custom");
    putItem(state.partialItems, index, {
      id: data.item_id || `${isCustom ? "ctc" : "fc"}_${state.responseId || "x"}_${index}`,
      type: isCustom ? "custom_tool_call" : "function_call",
      call_id: data.call_id || "",
      name: data.name || "",
      ...(isCustom ? { input: delta } : { arguments: delta }),
    }, false);
    return true;
  }

  if (
    eventType === "response.function_call_arguments.done" ||
    eventType === "response.custom_tool_call_input.done"
  ) {
    // `.done` payload shape varies: `text` (Responses) or `arguments`/`input`.
    const full = typeof data.text === "string" && data.text
      ? data.text
      : typeof data.arguments === "string" && data.arguments
        ? data.arguments
        : typeof data.input === "string" && data.input
          ? data.input
          : "";
    if (!full) return true;
    const isCustom = eventType.startsWith("response.custom");
    putItem(state.partialItems, index, {
      id: data.item_id || `${isCustom ? "ctc" : "fc"}_${state.responseId || "x"}_${index}`,
      type: isCustom ? "custom_tool_call" : "function_call",
      call_id: data.call_id || "",
      name: data.name || "",
      ...(isCustom ? { input: full } : { arguments: full }),
    }, true);
    return true;
  }

  return false;
}

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg || !msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let data;
  try { data = JSON.parse(dataStr); }
  catch { return; }

  if (eventType === "response.created") {
    state.responseId = data.response?.id || state.responseId;
    state.created = data.response?.created_at || state.created;
    return;
  }

  if (eventType === "response.output_item.done") {
    const index = data.output_index ?? 0;
    // done events carry the FULL item — prefer their text over accumulated deltas.
    putItem(state.partialItems, index, data.item, true);
    putItem(state.items, index, data.item, true);
    return;
  }

  if (eventType === "response.completed" || eventType === "response.done") {
    state.status = "completed";
    const usage = data.response?.usage;
    if (usage && typeof usage === "object") {
      state.usage.input_tokens = usage.input_tokens || 0;
      state.usage.output_tokens = usage.output_tokens || 0;
      state.usage.total_tokens = usage.total_tokens || 0;
    }
    if (Array.isArray(data.response?.output)) {
      data.response.output.forEach((item, index) => {
        putItem(state.partialItems, index, item, true);
        putItem(state.items, index, item, true);
      });
    }
    return;
  }

  if (eventType === "response.failed") {
    state.status = "failed";
    state.error = data.response?.error || data.error || null;
    return;
  }

  applyPartialEvent(eventType, data, state);
}

function buildOutput(state) {
  // Indices that only ever saw deltas (stream died before output_item.done).
  for (const [index, partial] of state.partialItems) {
    if (state.items.get(index) == null) {
      state.items.set(index, partial);
    } else {
      // Fill gaps only: done-item text already wins via preferIncomingText on done.
      const existing = state.items.get(index);
      const existingText = textOfMessage(existing) ?? textOfReasoning(existing) ?? argsOfTool(existing);
      const partialText = textOfMessage(partial) ?? textOfReasoning(partial) ?? argsOfTool(partial);
      if (existingText == null && partialText != null) {
        state.items.set(index, mergeItem(existing, partial, true));
      } else if (
        existingText != null && partialText != null &&
        partialText.length > existingText.length &&
        !partialText.startsWith(existingText) &&
        !existingText.startsWith(partialText)
      ) {
        // Divergent buffers (rare) — keep the longer one.
        state.items.set(index, mergeItem(existing, partial, true));
      } else if (existingText != null && partialText != null && partialText.length > existingText.length) {
        state.items.set(index, mergeItem(existing, partial, true));
      }
    }
  }

  const output = [];
  if (state.items.size === 0) return output;
  const maxIndex = Math.max(...state.items.keys());
  for (let i = 0; i <= maxIndex; i++) {
    const item = state.items.get(i);
    if (item) output.push(item);
  }
  return output;
}

function finalize(state) {
  const output = buildOutput(state);
  const hasContent = output.length > 0;
  let status = state.status;
  if (status === "in_progress") {
    status = hasContent ? "incomplete" : "failed";
  }
  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status,
    output,
    usage: state.usage,
    ...(state.error ? { error: state.error } : {}),
  };
}

/**
 * Convert Responses API SSE stream to single JSON response.
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 * @throws {Error} only when the stream cannot be read at all (nothing salvageable)
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return {
      id: `resp_${Date.now()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      output: [],
      usage: { ...EMPTY_USAGE },
    };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_USAGE },
    items: new Map(),
    partialItems: new Map(),
    error: null,
  };

  let readError = null;
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        // undici TypeError: terminated (TLS/socket abort mid-body), AbortError, etc.
        readError = err;
        break;
      }
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";
      for (const msg of messages) processSSEMessage(msg, state);
    }

    if (buffer.trim()) processSSEMessage(buffer, state);
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  const result = finalize(state);

  if (readError) {
    if (result.output.length === 0 && result.status !== "completed") {
      // Nothing salvageable — surface the original network error.
      throw readError;
    }
    result.status = result.status === "completed" ? "completed" : "incomplete";
    result.error = result.error || {
      type: "stream_error",
      code: "stream_disconnected",
      message: readError?.message || String(readError),
    };
  }

  return result;
}
