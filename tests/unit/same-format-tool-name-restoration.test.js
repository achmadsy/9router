import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { buildTransformStream } from "../../open-sse/handlers/chatCore/streamingHandler.js";

async function runStream(transform, text) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

  const reader = stream.pipeThrough(transform).getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function build(options = {}) {
  return buildTransformStream({
    provider: "opencode",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    userAgent: "opencode/2.1.2",
    reqLogger: null,
    toolNameMap: null,
    customToolNames: null,
    model: "glm-5.3-flash-free",
    connectionId: "test",
    body: { messages: [] },
    onStreamComplete: null,
    apiKey: null,
    credentials: null,
    ...options,
  });
}

describe("same-format streaming tool-name restoration", () => {
  it("restores request-local aliases before streaming them to the caller", async () => {
    const chunk = {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call-1",
            type: "function",
            function: { name: "shell_client", arguments: "{\"command\":\"echo ok\"}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
    };

    const output = await runStream(
      build({ toolNameMap: new Map([["shell_client", "shell"]]) }),
      `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
    );

    expect(output).toContain('"name":"shell"');
    expect(output).not.toContain("shell_client");
  });

  it("buffers and translates adapted arguments before same-format delivery", async () => {
    const chunks = [{
      id: "chatcmpl-args",
      object: "chat.completion.chunk",
      created: 1,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: '{"pa' } }] }, finish_reason: null }],
    }, {
      id: "chatcmpl-args",
      object: "chat.completion.chunk",
      created: 1,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/tmp/a"}' } }] }, finish_reason: null }],
    }, {
      id: "chatcmpl-args",
      object: "chat.completion.chunk",
      created: 1,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }];
    const map = new Map([["read", {
      nativeName: "read",
      callerName: "Read",
      arguments: { path: "file_path", offset: "offset", limit: "limit" },
      required: ["file_path"],
      properties: { file_path: { type: "string" } },
    }]]);
    const input = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const output = await runStream(build({ toolNameMap: map }), input);

    expect(output).toContain('"name":"Read"');
    expect(output).toContain('\\"file_path\\":\\"/tmp/a\\"');
    expect(output).not.toContain('\\"path\\":\\"/tmp/a\\"');
  });

  it("keeps the normal same-format passthrough behavior without aliases", async () => {
    const chunk = {
      id: "chatcmpl-2",
      object: "chat.completion.chunk",
      created: 1,
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    };

    const output = await runStream(
      build(),
      `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
    );

    expect(output).toContain('"content":"ok"');
    expect(output).toContain("data: [DONE]");
  });
});
