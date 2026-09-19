import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { convertResponsesStreamToJson } = await import(
  "../../open-sse/transformer/streamToJsonConverter.js"
);
const { handleForcedSSEToJson } = await import(
  "../../open-sse/handlers/chatCore/sseToJsonHandler.js"
);

const encoder = new TextEncoder();

/** SSE body that yields `chunks` then dies with TypeError: terminated (undici TLS abort). */
function dyingSseBody(chunks, errorMessage = "terminated") {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
        return;
      }
      controller.error(new TypeError(errorMessage));
    },
  });
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responsesCtx(bodyStream) {
  return {
    providerResponse: new Response(bodyStream, {
      headers: { "content-type": "text/event-stream" },
    }),
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    provider: "opencode",
    model: "muse-spark-1.3-contributor-free",
    body: { model: "muse-spark-1.3-contributor-free", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/responses" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    log: { line: vi.fn() },
  };
}

function chatCtx(bodyStream) {
  return {
    providerResponse: new Response(bodyStream, {
      headers: { "content-type": "text/event-stream" },
    }),
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    provider: "opencode",
    model: "muse-spark-1.3-contributor-free",
    body: { model: "muse-spark-1.3-contributor-free", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    log: { line: vi.fn() },
  };
}

describe("convertResponsesStreamToJson mid-stream TLS abort salvage", () => {
  it("salvages output_text deltas when stream dies before output_item.done", async () => {
    const chunks = [
      sseEvent("response.created", {
        type: "response.created",
        response: { id: "resp_partial", created_at: 1700000000 },
      }),
      sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      }),
      sseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        delta: "Hello ",
      }),
      sseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        delta: "world",
      }),
    ];

    const result = await convertResponsesStreamToJson(dyingSseBody(chunks));

    expect(result.status).toBe("incomplete");
    expect(result.id).toBe("resp_partial");
    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe("message");
    expect(result.output[0].content[0].text).toBe("Hello world");
    expect(result.error?.code).toBe("stream_disconnected");
    expect(result.error?.message).toContain("terminated");
  });

  it("keeps completed status when abort happens after response.completed", async () => {
    const chunks = [
      sseEvent("response.created", {
        type: "response.created",
        response: { id: "resp_ok", created_at: 1700000000 },
      }),
      sseEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done", annotations: [] }],
        },
      }),
      sseEvent("response.completed", {
        type: "response.completed",
        response: {
          id: "resp_ok",
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      }),
    ];

    const result = await convertResponsesStreamToJson(dyingSseBody(chunks));
    expect(result.status).toBe("completed");
    expect(result.usage.total_tokens).toBe(5);
    expect(result.output[0].content[0].text).toBe("done");
  });

  it("throws only when nothing was received", async () => {
    await expect(
      convertResponsesStreamToJson(dyingSseBody([], "terminated")),
    ).rejects.toThrow(/terminated/);
  });

  it("does not double-append when output_item.done follows deltas", async () => {
    const chunks = [
      sseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        delta: "Hello ",
      }),
      sseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        delta: "world",
      }),
      sseEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello world", annotations: [] }],
        },
      }),
      sseEvent("response.completed", {
        type: "response.completed",
        response: { id: "resp_x", status: "completed" },
      }),
    ];

    const result = await convertResponsesStreamToJson(
      new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.output[0].content[0].text).toBe("Hello world");
  });

  it("salvages function_call argument deltas", async () => {
    const chunks = [
      sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "shell",
          arguments: "",
        },
      }),
      sseEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 0,
        delta: '{"cmd":',
      }),
      sseEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 0,
        delta: '"ls"}',
      }),
    ];

    const result = await convertResponsesStreamToJson(dyingSseBody(chunks));
    expect(result.status).toBe("incomplete");
    expect(result.output[0].type).toBe("function_call");
    expect(result.output[0].arguments).toBe('{"cmd":"ls"}');
    expect(result.output[0].name).toBe("shell");
  });
});

describe("handleForcedSSEToJson mid-stream TLS abort", () => {
  it("returns salvaged Responses JSON instead of 502 when deltas arrived", async () => {
    const chunks = [
      sseEvent("response.created", {
        type: "response.created",
        response: { id: "resp_partial", created_at: 1700000000 },
      }),
      sseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        delta: "partial answer",
      }),
    ];

    const result = await handleForcedSSEToJson(responsesCtx(dyingSseBody(chunks)));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    expect(json.status).toBe("incomplete");
    const msg = (json.output || []).find((o) => o.type === "message");
    expect(msg?.content?.[0]?.text).toBe("partial answer");
  });

  it("returns 502 with real error detail when nothing salvageable", async () => {
    const result = await handleForcedSSEToJson(responsesCtx(dyingSseBody([])));
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(String(result.error || "")).toMatch(/terminated|Failed to convert/i);
  });

  it("salvages Chat Completions deltas when body read aborts mid-stream", async () => {
    const chunks = [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "muse-spark-1.3-contributor-free",
        choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "muse-spark-1.3-contributor-free",
        choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }],
      })}\n\n`,
      // no [DONE] — stream dies here
    ];

    const result = await handleForcedSSEToJson(chatCtx(dyingSseBody(chunks)));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hello world");
  });
});
