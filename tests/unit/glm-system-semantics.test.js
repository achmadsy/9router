import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/zcode/captcha-service.js", () => ({
  getCaptchaManager: () => ({ fetchCaptchaConfig: async () => ({ enabled: false }) }),
  isCaptchaError: async () => false,
}));
import { translateRequest } from "../../open-sse/translator/index.js";
import { GlmExecutor } from "../../open-sse/executors/glm.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { buildZcodeMainSystemPrompt, injectZcodeSystemPrompt } from "../../src/lib/zcode/systemPrompt.js";

const credentials = {
  connectionId: "system-semantics-fixture",
  providerSpecificData: { zaiPlanMode: "start-plan", zcodeJwtToken: "fixture-login" },
};
const translate = (source, body, provider = "glm") => translateRequest(
  source, "claude", body.model || "GLM-5.3", structuredClone(body), false, structuredClone(credentials), provider,
);
const system = (text, cache_control) => ({ type: "text", text, ...(cache_control ? { cache_control } : {}) });

describe("GLM caller-owned system semantics", () => {
  it("does not synthesize a product identity for a plain OpenAI request", () => {
    const out = translate("openai", { messages: [{ role: "user", content: "hi" }] });
    expect(out.system).toBeUndefined();
    expect(out.messages.map(message => message.role)).toEqual(["user"]);
    expect(JSON.stringify(out)).not.toMatch(/You are (Claude Code|ZCode)/);
  });

  it.each(["glm", "glm-clone-fixture"])("keeps leading caller blocks and cache markers for %s", (provider) => {
    const blocks = [system("Caller identity"), system("Caller policy", { type: "ephemeral" })];
    const out = translate("openai", { messages: [
      { role: "system", content: blocks },
      { role: "developer", content: "Developer policy" },
      { role: "user", content: "hi" },
    ] }, provider);
    expect(out.system).toEqual([...blocks, system("Developer policy")]);
    expect(out.messages.map(message => message.role)).toEqual(["user"]);
  });

  it("keeps later system and developer instructions in conversation order", () => {
    const out = translate("openai", { messages: [
      { role: "system", content: "Initial policy" },
      { role: "user", content: "First question" },
      { role: "system", content: "Runtime reminder" },
      { role: "assistant", content: "First answer" },
      { role: "developer", content: [system("Updated policy", { type: "ephemeral" })] },
      { role: "user", content: "Second question" },
    ] });
    expect(out.system).toEqual([system("Initial policy")]);
    expect(out.messages.map(message => message.role)).toEqual(["user", "system", "assistant", "system", "user"]);
    expect(out.messages[1].content).toEqual([system("Runtime reminder")]);
    expect(out.messages[3].content).toEqual([system("Updated policy", { type: "ephemeral" })]);
  });

  it("normalizes a single caller text block without losing its cache marker", () => {
    const block = system("Caller policy", { type: "ephemeral" });
    const out = translate("openai", { messages: [{ role: "system", content: block }, { role: "user", content: "hi" }] });
    expect(out.system).toEqual([block]);
  });

  it("does not mutate caller system blocks during message normalization", () => {
    const initial = system("Initial", { type: "ephemeral" });
    const first = system("First reminder", { type: "ephemeral" });
    const second = system("Second reminder");
    const body = { system: [initial], messages: [
      { role: "user", content: "hi" }, { role: "system", content: [first] }, { role: "system", content: [second] },
    ] };
    const snapshot = structuredClone(body);
    const out = prepareClaudeRequest(body, "glm");
    expect(initial).toEqual(snapshot.system[0]);
    expect(first).toEqual(snapshot.messages[1].content[0]);
    expect(out.messages[1].content).toEqual([first, second]);
  });

  it("handles an empty system instruction without creating a new prompt", () => {
    const out = translate("openai", { messages: [
      { role: "user", content: "First" }, { role: "system", content: "" }, { role: "user", content: "Second" },
    ] });
    expect(out.system).toBeUndefined();
    expect(out.messages.flatMap(message => message.content).map(block => block.text)).toEqual(["First", "Second"]);
  });

  it("preserves same-format caller system text and cache policy without mutating input", () => {
    const blocks = [system("Prefix"), system("Stable", { type: "ephemeral" }), system("Dynamic", { type: "ephemeral", ttl: "5m" })];
    const body = { system: blocks, messages: [{ role: "user", content: "hi" }, { role: "system", content: system("Reminder", { type: "ephemeral" }) }] };
    const snapshot = structuredClone(body);
    const out = translate("claude", body);
    expect(out.system).toEqual(blocks);
    expect(out.messages[1].content).toEqual([system("Reminder", { type: "ephemeral" })]);
    expect(body).toEqual(snapshot);
  });

  it("keeps valid caller system cache markers ahead of automatic message and tool markers", () => {
    const blocks = Array.from({ length: 3 }, (_, i) => system(`Policy ${i}`, { type: "ephemeral" }));
    const out = translate("claude", { system: blocks, tools: [{ name: "echo", input_schema: { type: "object" } }], messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_fixture", name: "echo", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_fixture", content: "done" }] },
    ] });
    expect(out.system).toEqual(blocks);
    const marked = [...out.system, ...out.tools, ...out.messages.flatMap(message => message.content)].filter(block => block.cache_control);
    expect(marked.length).toBeLessThanOrEqual(4);
  });

  it("retains caller text even when it names a different product", () => {
    const text = "You are Claude Code; this is caller-authored policy.";
    expect(translate("openai", { messages: [{ role: "system", content: text }, { role: "user", content: "hi" }] }).system)
      .toEqual([system(text)]);
  });

  it("preserves JSON response instructions without injecting an identity", () => {
    const out = translate("openai", { response_format: { type: "json_object" }, messages: [{ role: "user", content: "hi" }] });
    expect(out.system).toHaveLength(1);
    expect(out.system[0].text).toContain("valid JSON");
    expect(JSON.stringify(out.system)).not.toMatch(/You are (Claude Code|ZCode)/);
  });

  it("leaves the generic Claude-provider path unchanged", () => {
    const out = translate("openai", { messages: [{ role: "user", content: "hi" }] }, "claude");
    expect(out.system[0].text).toContain("You are Claude Code");
    expect(out.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it.each(["openai", "claude"])("automatically sends the latest default context for a bare %s request", async (source) => {
    const ex = new GlmExecutor();
    ex.fetchUpstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const body = translate(source, { model: "glm-5.3-flash", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] });
    await ex.execute({ model: "glm-5.3-flash", body, credentials, stream: false, glmMaxTokens: 1024 });
    const sent = JSON.parse(ex.fetchUpstream.mock.calls[0][1].body);
    expect(sent.model).toBe("GLM-5.3-Flash");
    expect(sent.system).toEqual(buildZcodeMainSystemPrompt());
  });

  it("does not duplicate caller-supplied native context or insert it on API-key routes", async () => {
    const ex = new GlmExecutor();
    ex.fetchUpstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const supplied = buildZcodeMainSystemPrompt();
    const body = translate("claude", { model: "glm-5.3-flash", system: supplied, messages: [{ role: "user", content: "hi" }] });
    await ex.execute({ model: "glm-5.3-flash", body, credentials, stream: false });
    expect(JSON.parse(ex.fetchUpstream.mock.calls[0][1].body).system).toEqual(supplied);
    const apiKeyCredentials = { apiKey: "fixture-key", providerSpecificData: { zaiPlanMode: "api-key" } };
    const input = { system: [system("Caller policy")], messages: [{ role: "user", content: "hi" }] };
    expect(ex.transformRequest("glm-5.3-flash", input, false, apiKeyCredentials).system).toEqual(input.system);
  });

  it("bounds final cache markers after adding account-plan context", async () => {
    const ex = new GlmExecutor();
    ex.fetchUpstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const body = translate("claude", { tools: [{ name: "echo", input_schema: { type: "object" } }], messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_fixture", name: "echo", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_fixture", content: "done" }] },
    ] });
    await ex.execute({ model: "glm-5.3-flash", body, credentials, stream: false });
    const sent = JSON.parse(ex.fetchUpstream.mock.calls[0][1].body);
    expect(sent.system).toEqual(buildZcodeMainSystemPrompt());
    expect([...sent.system, ...sent.tools, ...sent.messages.flatMap(message => message.content)].filter(block => block.cache_control)).toHaveLength(4);
  });

  it("sends corrected semantics through the real executor with mocked networking", async () => {
    const ex = new GlmExecutor();
    ex.fetchUpstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const body = translate("openai", { model: "glm-5.3", max_tokens: 1024, messages: [
      { role: "system", content: "Caller policy" }, { role: "user", content: "hi" },
      { role: "system", content: "Runtime reminder" },
    ] });
    await ex.execute({ model: "glm-5.3", body, credentials, stream: false, glmMaxTokens: 1024 });
    expect(ex.fetchUpstream).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(ex.fetchUpstream.mock.calls[0][1].body);
    expect(sent.system).toEqual(injectZcodeSystemPrompt({ system: [system("Caller policy")] }).system);
    expect(sent.messages.map(message => message.role)).toEqual(["user", "system"]);
    expect(sent.messages[1].content).toEqual([system("Runtime reminder")]);
    expect(JSON.stringify(sent)).not.toContain("You are Claude Code");
    expect(new Headers(ex.fetchUpstream.mock.calls[0][1].headers).get("x-api-key")).toBe("fixture-login");
  });
});
