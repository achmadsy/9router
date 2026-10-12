// Repro for: Claude Code hangs 180s on codex reasoning-only turns ("response stopped arriving").
// Path: Claude Code (source=claude) -> 9router -> codex (target=openai-responses),
// stream translated OPENAI_RESPONSES -> CLAUDE via two-hop pivot in translateResponse.
import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

async function runTransform(input) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES, // targetFormat: codex provider speaks Responses
      FORMATS.CLAUDE,           // sourceFormat: Claude Code client
      "codex",
      null,
      null,
      "gpt-5.6-sol-xhigh",
    ),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

const resEvent = (event, data) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

function baseStream(events) {
  return events.map(([e, d]) => resEvent(e, d)).join("") + "data: [DONE]\n\n";
}

describe("Responses -> Claude streaming termination (reasoning-only turn)", () => {
  it("emits full Claude terminal sequence on response.completed with reasoning-only output", async () => {
    const output = await runTransform(baseStream([
      ["response.created", { response: { id: "resp_t", status: "in_progress" } }],
      ["response.reasoning_summary_text.delta", { delta: "thinking..." }],
      ["response.reasoning_summary_text.done", { text: "thinking..." }],
      ["response.output_item.done", { item: { type: "reasoning" } }],
      ["response.completed", { response: { id: "resp_t", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } }],
    ]));

    expect(output).toContain("event: message_start");
    expect(output).toContain("event: content_block_delta");
    expect(output).toContain("thinking_delta");
    // Terminal sequence must be present:
    expect(output).toContain("content_block_stop");
    expect(output).toContain('"stop_reason":"end_turn"');
    expect(output).toContain("event: message_stop");
  });

  it("emits tool_use stop metadata for a Muse-style Responses function call", async () => {
    const output = await runTransform(baseStream([
      ["response.created", { response: { id: "resp_tool", status: "in_progress" } }],
      ["response.output_item.added", {
        output_index: 0,
        item: { id: "fc_read", type: "function_call", call_id: "toolu_read", name: "Read", arguments: "" },
      }],
      ["response.function_call_arguments.delta", {
        item_id: "fc_read",
        output_index: 0,
        delta: JSON.stringify({ file_path: "/tmp/file.js" }),
      }],
      ["response.output_item.done", {
        output_index: 0,
        item: { id: "fc_read", type: "function_call", call_id: "toolu_read", name: "Read" },
      }],
      ["response.completed", {
        response: { id: "resp_tool", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
      }],
    ]));

    expect(output).toContain('"type":"tool_use"');
    expect(output).toContain('"id":"toolu_read"');
    expect(output).toContain('"name":"Read"');
    expect(output).toContain('"type":"input_json_delta"');
    expect(output).toContain('"stop_reason":"tool_use"');
    expect(output).toContain("event: message_stop");
  });

  it("emits Claude terminal sequence when stream EOFs without [DONE]", async () => {
    const output = await runTransform(resEvent("response.created", { response: { id: "resp_t", status: "in_progress" } })
      + resEvent("response.reasoning_summary_text.delta", { delta: "thinking..." })
      + resEvent("response.completed", { response: { id: "resp_t", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } }));

    expect(output).toContain("event: message_stop");
  });

  it("emits Claude terminal sequence on response.incomplete (max_output_tokens exhausted mid-reasoning)", async () => {
    const output = await runTransform(baseStream([
      ["response.created", { response: { id: "resp_t", status: "in_progress" } }],
      ["response.reasoning_summary_text.delta", { delta: "thinking..." }],
      ["response.incomplete", { response: { id: "resp_t", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }],
    ]));

    expect(output).toContain("event: message_stop");
  });
});
