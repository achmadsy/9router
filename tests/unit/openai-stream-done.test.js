import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

async function translate(format, events) {
  const source = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(events)); controller.close();
  } });
  return new Response(source.pipeThrough(createSSETransformStreamWithLogger(format, FORMATS.OPENAI, "glm", null, null, "glm-5.3"))).text();
}

describe("OpenAI client terminal sentinel", () => {
  it("terminates a translated Claude-compatible GLM stream exactly once", async () => {
    const events = [
      { type: "message_start", message: { id: "m", model: "GLM-5.3", usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ].map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join("");
    const text = await translate(FORMATS.CLAUDE, events);
    expect(text).toContain('"content":"hello"');
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(text.trimEnd()).toMatch(/data: \[DONE\]$/);
  });

  it("does not drop or duplicate an existing OpenAI DONE", async () => {
    const text = await translate(FORMATS.OPENAI, `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
});
