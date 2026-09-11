// #1998 — Headroom compression treated a Codex (openai-responses) body.input
// array as OpenAI messages: it sent Responses items to /v1/compress and then
// assigned the returned OpenAI messages back to body.input, violating the
// Responses format contract. body.input must stay Responses-shaped.
//
// #2132 — Full openai-responses → OpenAI → compress → Responses round-trip was
// unsafe once tool/reasoning items appeared: call_ids, encrypted reasoning
// blobs and apply_patch-style tool arguments could be rewritten or dropped.
// Blanket-skip was too coarse — pure message text is compressible; structural
// items stay in body.input and never leave this process.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

describe("compressWithHeadroom openai-responses format (#1998 / #2132)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps body.input in Responses format after compressing an openai-responses request", async () => {
    // Headroom always returns compressed OpenAI-style messages.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "compressed text" }],
        tokens_before: 100,
        tokens_after: 90,
        tokens_saved: 10,
      }),
    }));

    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a long original message ".repeat(20) }],
        },
      ],
    };

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
    });

    expect(data).not.toBeNull();
    // body.input must remain Responses items (type:"message" + content array),
    // NOT the raw OpenAI messages ({ role, content: "<string>" }) the bug produced.
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(Array.isArray(body.input[0].content)).toBe(true);
    expect(typeof body.input[0].content).not.toBe("string");
    expect(body.input[0].content[0].text).toBe("compressed text");
  });

  it("compresses message text while leaving tool/reasoning items intact (#2132)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "compressed tool history" }],
        tokens_saved: 10,
      }),
    }));

    const callId = "call_apply_patch_123";
    const encrypted = "opaque-encrypted-reasoning-blob";
    const functionCall = {
      type: "function_call",
      call_id: callId,
      name: "apply_patch",
      arguments: "*** Begin Patch\n*** End Patch",
    };
    const functionOutput = {
      type: "function_call_output",
      call_id: callId,
      output: "ok",
    };
    const reasoning = {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Need a plan" }],
      encrypted_content: encrypted,
    };
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "investigate bug " + "x".repeat(80) }],
        },
        structuredClone(functionCall),
        structuredClone(functionOutput),
        structuredClone(reasoning),
      ],
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
      ],
    };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    // Message text IS compressible — proxy must be called with only that text.
    expect(data).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.messages).toEqual([
      { role: "user", content: "investigate bug " + "x".repeat(80) },
    ]);
    // Structural items never leave the body; only the message text is rewritten.
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(body.input[0].content[0].text).toBe("compressed tool history");
    expect(body.input.slice(1)).toEqual([functionCall, functionOutput, reasoning]);
    expect(diagnostics.reason).toBeUndefined();
  });

  it("skips (no proxy call) when input has only tool/reasoning items and no message text", async () => {
    global.fetch = vi.fn();
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "call_x",
          name: "shell",
          arguments: '{"cmd":"ls"}',
        },
        {
          type: "function_call_output",
          call_id: "call_x",
          output: "file.txt",
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thinking" }],
          encrypted_content: "blob",
        },
      ],
    };
    const original = structuredClone(body);
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(body).toEqual(original);
    expect(diagnostics.reason).toMatch(/no compressible message text/);
  });

  it("compresses role-only items (no type field) treated as messages", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "short" }],
        tokens_saved: 5,
      }),
    }));

    const body = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "a very long user prompt".repeat(10) }] },
      ],
    };

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
    });

    expect(data).not.toBeNull();
    expect(body.input[0].content[0].text).toBe("short");
    expect(body.input[0]).not.toHaveProperty("type");
  });

  it("fails open and leaves body untouched when proxy message count mismatches", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [
          { role: "user", content: "a" },
          { role: "user", content: "b" },
        ],
        tokens_saved: 3,
      }),
    }));

    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "only one message" }],
        },
      ],
    };
    const original = structuredClone(body);
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).toBeNull();
    expect(body).toEqual(original);
    expect(diagnostics.reason).toMatch(/openai-responses message count/);
  });

  it("compresses string-form body.input and writes back in place", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "compressed string" }],
        tokens_saved: 40,
      }),
    }));

    const body = { input: "a long compressible prompt ".repeat(20) };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.messages).toEqual([
      { role: "user", content: "a long compressible prompt ".repeat(20) },
    ]);
    expect(body.input).toBe("compressed string");
    expect(diagnostics.reason).toBeUndefined();
  });

  it("fails open and leaves string-form body.input unchanged on proxy error", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("proxy down");
    });

    const body = { input: "long compressible string" };
    const original = structuredClone(body);
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).toBeNull();
    expect(body).toEqual(original);
    expect(diagnostics.reason).toMatch(/request failed/);
  });

  it("fails open when proxy returns bad shape for string-form input", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        // Wrong role — applyResponsesHeadroomMessages must reject before mutating.
        messages: [{ role: "assistant", content: "rewritten" }],
        tokens_saved: 5,
      }),
    }));

    const body = { input: "long compressible string" };
    const original = structuredClone(body);
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).toBeNull();
    expect(body).toEqual(original);
    expect(diagnostics.reason).toMatch(/openai-responses message order/);
  });
});
