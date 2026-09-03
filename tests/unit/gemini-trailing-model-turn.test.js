import { describe, it, expect } from "vitest";
import { openaiToGeminiRequest, openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { geminiToOpenAIRequest } from "../../open-sse/translator/request/gemini-to-openai.js";

// Gemini-family upstreams (Gemini API, Cloud Code Assist, Antigravity) require
// contents to alternate user/model and to NEVER end with a "model" turn.
// "Requests ending model turn are not supported." (HTTP 400 INVALID_ARGUMENT)

describe("gemini contents never end with a model turn", () => {
  it("drops trailing assistant prefill text", () => {
    const out = openaiToGeminiRequest("gemini-3.8-flash-high", {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "prefill draft" },
      ],
    }, false);

    expect(out.contents.length).toBeGreaterThan(0);
    expect(out.contents.at(-1).role).toBe("user");
    expect(JSON.stringify(out.contents)).not.toContain("prefill draft");
  });

  it("drops trailing assistant tool_calls that have no responses", () => {
    const out = openaiToGeminiRequest("gemini-3.8-flash-high", {
      messages: [
        { role: "user", content: "list files" },
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
      ],
    }, false);

    expect(out.contents.length).toBeGreaterThan(0);
    expect(out.contents.at(-1).role).toBe("user");
  });

  it("keeps answered tool calls but drops the trailing orphaned call", () => {
    const out = openaiToGeminiRequest("gemini-3.8-flash-high", {
      messages: [
        { role: "user", content: "look around" },
        { role: "assistant", tool_calls: [
          { id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: "call_1", content: "file1" },
        { role: "assistant", tool_calls: [
          { id: "call_2", type: "function", function: { name: "cat", arguments: "{}" } },
        ] },
      ],
    }, false);

    expect(out.contents.at(-1).role).toBe("user");
    // The answered call and its response survive
    const serialized = JSON.stringify(out.contents);
    expect(serialized).toContain("call_1");
    // The orphaned call is not emitted without its response
    expect(serialized).not.toContain("call_2");
  });

  it("drops orphaned tool_calls mid-history but keeps following user turn", () => {
    const out = openaiToGeminiRequest("gemini-3.8-flash-high", {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", tool_calls: [{ id: "call_x", type: "function", function: { name: "noop", arguments: "{}" } }] },
        { role: "user", content: "actually stop" },
      ],
    }, false);

    expect(out.contents.at(-1).role).toBe("user");
    expect(JSON.stringify(out.contents)).not.toContain("noop");
    expect(JSON.stringify(out.contents)).toContain("actually stop");
  });

  it("guards the antigravity envelope after a compression round-trip", () => {
    // Simulate Headroom output where the last message is an assistant turn
    // (e.g. compressed prefill or unanswered tool call) — the rebuilt
    // Antigravity envelope must not end with a model turn.
    const out = openaiToAntigravityRequest("gemini-3.8-flash-high", {
      messages: [
        { role: "user", content: "continue" },
        { role: "assistant", content: "draft text" },
      ],
    }, false, { projectId: "proj-1", connectionId: "conn-1" });

    expect(Array.isArray(out.request.contents)).toBe(true);
    expect(out.request.contents.at(-1).role).toBe("user");
  });
});

describe("gemini-to-openai multi functionResponse turns", () => {
  it("preserves every functionResponse in a turn, not just the first", () => {
    const geminiBody = {
      contents: [
        { role: "user", parts: [{ text: "check weather and time" }] },
        { role: "model", parts: [
          { functionCall: { id: "call_1", name: "weather", args: {} } },
          { functionCall: { id: "call_2", name: "time", args: {} } },
        ] },
        { role: "user", parts: [
          { functionResponse: { id: "call_1", name: "weather", response: { result: "sunny" } } },
          { functionResponse: { id: "call_2", name: "time", response: { result: "12:00" } } },
        ] },
      ],
    };

    const out = geminiToOpenAIRequest("gemini-3.8-flash-high", geminiBody, false);
    const toolMessages = out.messages.filter(m => m.role === "tool");

    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].tool_call_id).toBe("call_1");
    expect(toolMessages[0].content).toContain("sunny");
    expect(toolMessages[1].tool_call_id).toBe("call_2");
    expect(toolMessages[1].content).toContain("12:00");
  });

  it("keeps assistant tool_calls paired with all responses after round-trip", () => {
    const geminiBody = {
      contents: [
        { role: "user", parts: [{ text: "check weather and time" }] },
        { role: "model", parts: [
          { functionCall: { id: "call_1", name: "weather", args: {} } },
          { functionCall: { id: "call_2", name: "time", args: {} } },
        ] },
        { role: "user", parts: [
          { functionResponse: { id: "call_1", name: "weather", response: { result: "sunny" } } },
          { functionResponse: { id: "call_2", name: "time", response: { result: "12:00" } } },
        ] },
      ],
    };

    const oai = geminiToOpenAIRequest("gemini-3.8-flash-high", geminiBody, false);
    const back = openaiToGeminiRequest("gemini-3.8-flash-high", oai, false);

    expect(back.contents.at(-1).role).toBe("user");
    const serialized = JSON.stringify(back.contents);
    expect(serialized).toContain("call_1");
    expect(serialized).toContain("call_2");
    expect(serialized).toContain("sunny");
    expect(serialized).toContain("12:00");
  });
});
