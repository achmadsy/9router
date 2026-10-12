import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

function createState() {
  return { toolCalls: new Map(), nextBlockIndex: 0 };
}

function getInputJsonDelta(events) {
  return events.find((event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta")?.delta.partial_json;
}

describe("openaiToClaudeResponse tool argument sanitization", () => {
  it("drops invalid Read pages and clamps numeric bounds", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_read", function: { name: "Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/file.js", offset: -5, limit: 999999999, pages: "" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/file.js",
      offset: 0,
      limit: 2000,
    });
  });

  it("keeps valid PDF pages", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_pdf", function: { name: "proxy_Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/doc.pdf", pages: "1-3" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/doc.pdf",
      pages: "1-3",
    });
  });

  it("uses tool_use when a provider ends a streamed tool call with stop", () => {
    const state = createState();

    const startEvents = openaiToClaudeResponse({
      id: "chatcmpl-test-stop",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_read", function: { name: "Read" } }] } }],
    }, state);

    const finishEvents = openaiToClaudeResponse({
      id: "chatcmpl-test-stop",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "/tmp/file.js" }) } }] },
        finish_reason: "stop",
      }],
    }, state);

    expect(startEvents.find((event) => event.type === "content_block_start")?.content_block).toMatchObject({
      type: "tool_use",
      id: "toolu_read",
      name: "Read",
    });
    expect(finishEvents.map((event) => event.type)).toEqual([
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(JSON.parse(getInputJsonDelta(finishEvents))).toEqual({ file_path: "/tmp/file.js" });
    expect(finishEvents.find((event) => event.type === "message_delta")?.delta.stop_reason).toBe("tool_use");
  });

  it("keeps max_tokens when a streamed tool call is truncated", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-length",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_edit", function: { name: "Edit" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-length",
      model: "test-model",
      choices: [{ delta: {}, finish_reason: "length" }],
    }, state);

    expect(events.find((event) => event.type === "message_delta")?.delta.stop_reason).toBe("max_tokens");
  });
});
