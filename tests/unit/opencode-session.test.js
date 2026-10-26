import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

vi.mock("../../open-sse/services/opencodeBunClient.js", () => ({
  opencodeBunFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import {
  OPENCODE_SESSION_RE,
  generateSessionId,
  translateSessionId,
  stableSessionId,
} from "../../open-sse/executors/opencode.js";
import {
  generateSessionId as generateZenSessionId,
  translateSessionId as translateZenSessionId,
} from "../../open-sse/executors/opencode-zen.js";

function makeCredentials(overrides = {}) {
  return {
    connectionId: "conn_test",
    rawHeaders: {},
    ...overrides,
  };
}

function prepare(executor, overrides = {}) {
  const credentials = overrides.credentials || makeCredentials();
  const prepared = executor.prepareRequestCredentials({
    body: overrides.body || { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
    credentials,
    providerSessionId: overrides.providerSessionId ?? "conversation-a",
    clientTool: overrides.clientTool ?? "claude",
  });
  return { credentials, prepared };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("OpenCode Free Session ID Format", () => {
  it("generates session IDs matching OpenCode canonical format (ses_ + 12 hex + 14 base62)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateSessionId();
      expect(id).toMatch(OPENCODE_SESSION_RE);
      expect(id).toHaveLength(30);
    }
  });

  it("translates arbitrary sessions into valid OpenCode session format", () => {
    const inputs = [
      "claude:550e8400-e29b-41d4-a716-446655440000",
      "antigravity:conv-abc-123",
      "session-from-codex",
      "12345",
      "",
    ];
    for (const raw of inputs) {
      const translated = translateSessionId(raw, "claude");
      expect(translated).toMatch(OPENCODE_SESSION_RE);
      expect(translated).toHaveLength(30);
    }
  });

  // Upstream decodes the prefix as ~(time * 0x1000 + counter) and answers
  // 403 FreeTierError unless the counter is small; hash-filled prefixes failed.
  it("encodes a small counter in session prefixes so the free-tier gate accepts them", () => {
    const counterOf = (id) => Number(~BigInt(`0x${id.slice(4, 16)}`) & 0xfffn);
    for (const translate of [translateSessionId, translateZenSessionId]) {
      for (const raw of ["claude:550e8400-e29b-41d4-a716-446655440000", "session-from-codex", "", "x".repeat(300)]) {
        const translated = translate(raw, "claude");
        expect(translated).toMatch(OPENCODE_SESSION_RE);
        expect(counterOf(translated)).toBe(1);
        expect(translate(raw, "claude")).toBe(translated);
      }
    }
    expect(counterOf(generateSessionId(1_700_000_000_000))).toBeLessThanOrEqual(16);
    expect(counterOf(generateZenSessionId(1_700_000_000_000))).toBe(1);
  });

  it("preserves already-valid OpenCode sessions without re-hashing", () => {
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    expect(translateSessionId(valid)).toBe(valid);
    expect(translateSessionId(`  ${valid}  `)).toBe(valid);
  });
});

describe("OpenCode Free Executor Session Resolution", () => {
  it("uses request-local session credentials without mutating source credentials", () => {
    const executor = getExecutor("opencode");
    const { credentials, prepared } = prepare(executor);

    expect(executor.constructor.name).toBe("OpenCodeExecutor");
    expect(prepared).not.toBe(credentials);
    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(credentials).not.toHaveProperty("_opencodeSession");
    expect(executor).not.toHaveProperty("_currentSessionId");
  });

  it("preserves valid native x-opencode-session header case-insensitively", () => {
    const executor = getExecutor("opencode");
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "X-OpenCode-Session": ` ${valid} ` } }),
    });

    expect(prepared._opencodeSession).toBe(valid);
  });

  it("translates invalid native x-opencode-session header into a valid session", () => {
    const executor = getExecutor("opencode");
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "x-opencode-session": "invalid-session-uuid" } }),
    });

    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(prepared._opencodeSession).not.toBe("invalid-session-uuid");
  });

  it("translates conversation session deterministically", () => {
    const executor = getExecutor("opencode");
    const first = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;
    const second = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;

    expect(first).toBe(second);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("isolates different conversations and tools", () => {
    const executor = getExecutor("opencode");
    const convA = prepare(executor, { providerSessionId: "conversation-a" }).prepared._opencodeSession;
    const convB = prepare(executor, { providerSessionId: "conversation-b" }).prepared._opencodeSession;
    const toolClaude = prepare(executor, { providerSessionId: "same", clientTool: "claude" }).prepared._opencodeSession;
    const toolCodex = prepare(executor, { providerSessionId: "same", clientTool: "codex" }).prepared._opencodeSession;

    expect(convA).not.toBe(convB);
    expect(toolClaude).not.toBe(toolCodex);
  });

  it("adds the valid session header to fetch requests", async () => {
    const executor = getExecutor("opencode");
    const credentials = makeCredentials();
    const result = await executor.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
      stream: false,
      credentials,
      providerSessionId: "conversation-fetch-test",
      clientTool: "claude",
    });

    expect(result.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBe(result.headers["x-opencode-session"]);
    expect(fetchMock.mock.calls[0][1].headers["Authorization"]).toBe("Bearer public");
    expect(credentials).not.toHaveProperty("_opencodeSession");
  });

  it("falls back to a valid generated session in buildHeaders when called standalone", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({});

    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["Authorization"]).toBe("Bearer public");
  });
  it("handles null or undefined body gracefully in transformRequest", () => {
    const executor = getExecutor("opencode");
    expect(() => executor.transformRequest("muse-spark-1.3-contributor-free", null, false, {})).not.toThrow();
    expect(() => executor.transformRequest("big-pickle", undefined, false, {})).not.toThrow();
  });
});

describe("OpenCode Free User-Agent Validation", () => {
  it("defaults User-Agent to the v2 CLI form for non-opencode downstream clients", () => {
    const executor = getExecutor("opencode");
    const headersNoUa = executor.buildHeaders({});
    expect(headersNoUa["User-Agent"]).toBe("opencode/latest/2.1.2/cli");

    const headersClaude = executor.buildHeaders({ rawHeaders: { "user-agent": "Claude-Code/1.0" } });
    expect(headersClaude["User-Agent"]).toBe("opencode/latest/2.1.2/cli");
  });

  it("replaces v1-style opencode User-Agents, which upstream now rejects with 403", () => {
    const executor = getExecutor("opencode");
    for (const ua of ["opencode", "opencode/1.15.0", "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14"]) {
      expect(executor.buildHeaders({ rawHeaders: { "user-agent": ua } })["User-Agent"]).toBe("opencode/latest/2.1.2/cli");
    }
  });

  it("preserves a v2 opencode downstream User-Agent", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/latest/2.0.29/desktop" } });
    expect(headers["User-Agent"]).toBe("opencode/latest/2.0.29/desktop");
  });

  it("sends the v2 session headers and never x-opencode-request", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({
      rawHeaders: { "x-opencode-request": "msg_0ae8d9cd3001swxaFbM248jcIF" },
    });
    const session = headers["x-opencode-session"];
    expect(session).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(session);
    expect(headers["x-session-affinity"]).toBe(session);
    expect(headers["x-session-id"]).toBe(session);
    expect(headers["x-opencode-client"]).toBe("cli");
    expect("x-opencode-request" in headers).toBe(false);
  });

  // Native 2.1.2 sends a stable 40-hex project id per device, not a word.
  it("derives a stable 40-hex x-opencode-project per connection identity", () => {
    const executor = getExecutor("opencode");
    const a = executor.buildHeaders({ rawHeaders: {} });
    const b = executor.buildHeaders({ rawHeaders: {} });
    expect(a["x-opencode-project"]).toMatch(/^[0-9a-f]{40}$/);
    expect(b["x-opencode-project"]).toBe(a["x-opencode-project"]);

    const other = executor.buildHeaders({ connectionId: "other", rawHeaders: {} });
    expect(other["x-opencode-project"]).toMatch(/^[0-9a-f]{40}$/);
    expect(other["x-opencode-project"]).not.toBe(a["x-opencode-project"]);

    const passed = executor.buildHeaders({ rawHeaders: { "x-opencode-project": "d53a3b191b8fc0ffb99e6717016927e50c7a11bc" } });
    expect(passed["x-opencode-project"]).toBe("d53a3b191b8fc0ffb99e6717016927e50c7a11bc");
  });

  it("mints native-shaped W3C trace headers on every request", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({});

    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers.b3).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/);
    const next = executor.buildHeaders({});
    expect(next.traceparent).not.toBe(headers.traceparent);
    expect(next.b3).not.toBe(headers.b3);
  });

  it("sends Accept */* like the native CLI and adds chat-lane stream_options", () => {
    const executor = getExecutor("opencode");
    expect(executor.buildHeaders({})["Accept"]).toBe("*/*");

    const body = executor.transformRequest(
      "big-pickle",
      { messages: [{ role: "user", content: "hi" }] },
      true,
      {},
    );
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });

    // Caller-provided stream_options wins; Responses lane never receives it.
    const custom = executor.transformRequest(
      "big-pickle",
      { messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: false } },
      true,
      {},
    );
    expect(custom.stream_options).toEqual({ include_usage: false });
  });

  it("wraps foreign client system instructions in the public OpenCode harness", () => {
    const executor = getExecutor("opencode");
    const body = executor.transformRequest(
      "glm-5.3-flash-free",
      {
        messages: [
          { role: "system", content: "You are Claude Code." },
          { role: "user", content: "hi" },
        ],
        max_tokens: 4096,
      },
      true,
      { rawHeaders: { "user-agent": "claude-code/2.1.0" } },
    );

    expect(body.messages[0].content).toMatch(/^You are an AI agent running in OpenCode/);
    expect(body.messages[0].content).toContain("You are Claude Code.");
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(4096);
  });

  it("wraps plain OpenAI-compatible requests even when OpenCode is the caller", () => {
    const executor = getExecutor("opencode");
    const body = executor.transformRequest(
      "glm-5.3-flash-free",
      {
        messages: [
          { role: "system", content: "You are OpenCode using a custom provider." },
          { role: "user", content: "hi" },
        ],
      },
      true,
      { rawHeaders: { "user-agent": "opencode/latest/2.1.2/cli" } },
    );

    expect(body.messages[0].content).toMatch(/^You are an AI agent running in OpenCode/);
    expect(body.messages[0].content).toContain("You are OpenCode using a custom provider.");
    expect(body.messages[0].content).toContain("# Your Model");
    expect(body.messages[0].content).toContain("# Code Mode");
    expect(body.messages[0].content).toContain("<available_skills>");
    expect(body.messages[0].content).toContain("<env>");
  });

  it("does not duplicate a complete native OpenCode envelope", () => {
    const executor = getExecutor("opencode");
    const nativeSystem = [
      "You are an AI agent running in OpenCode, a coding agent harness.",
      "# Your Model",
      "# Code Mode",
      "<available_skills>",
      "<env>",
    ].join("\n\n");
    const body = executor.transformRequest(
      "glm-5.3-flash-free",
      { messages: [{ role: "system", content: nativeSystem }, { role: "user", content: "hi" }] },
      true,
      { rawHeaders: { "user-agent": "opencode/latest/2.1.2/cli" } },
    );

    expect(body.messages[0].content).toContain(nativeSystem);
    expect(body.messages[0].content.match(/You are an AI agent running in OpenCode/g)).toHaveLength(1);
    expect(body.messages[0].content.match(/# Your Model/g)).toHaveLength(1);
    expect(body.messages[0].content.match(/# Code Mode/g)).toHaveLength(1);
  });
});


describe("OpenCode Stable Session Reuse (429 follow-up)", () => {
  function anonymousCredentials(auth) {
    return makeCredentials({ connectionId: undefined, rawHeaders: { authorization: `Bearer ${auth}` } });
  }

  it("reuses one stable upstream session instead of minting a new one per request", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const first = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });
    const second = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });

    expect(first._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(second._opencodeSession).toBe(first._opencodeSession);
  });

  it("isolates stable sessions by downstream identity", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const forKey = (auth) => executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials(auth),
      providerSessionId: null,
      clientTool: "claude",
    })._opencodeSession;

    expect(forKey("user-A")).not.toBe(forKey("user-B"));
    expect(forKey("user-A")).toMatch(OPENCODE_SESSION_RE);
  });

  it("exposes the stable session helper directly", () => {
    const first = stableSessionId({ connectionId: "direct-conn" });
    expect(stableSessionId({ connectionId: "direct-conn" })).toBe(first);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("keeps the standalone buildHeaders session stable across calls", () => {
    const executor = getExecutor("opencode");
    const first = executor.buildHeaders({})["x-opencode-session"];
    const second = executor.buildHeaders({})["x-opencode-session"];
    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(second).toBe(first);
  });

  it("applies the read/shell free-tier fingerprint on Chat Completions", () => {
    const executor = getExecutor("opencode");

    const chatNoTools = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(chatNoTools.stream).toBe(true);
    // tool_choice "none" is answered with 403 FreeTierError upstream.
    expect(chatNoTools.tool_choice).toBeUndefined();
    expect(chatNoTools.tools.map((t) => t.function?.name)).toEqual(["read", "shell"]);
    expect(chatNoTools.messages[0].role).toBe("system");
    expect(chatNoTools.messages[0].content).toContain("- tools.caller.read(");
    expect(chatNoTools.messages[0].content).toContain("- tools.caller.shell(");
    expect(chatNoTools.messages[0].content).not.toContain("No Code Mode tools are currently available");
    expect(chatNoTools.messages[0].content).not.toContain("placeholders that do nothing");

    const chatWithTools = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "Bash", description: "Claude Code tool" } },
        { type: "function", function: { name: "Read", description: "Claude Code tool" } },
      ],
      tool_choice: "auto",
    });
    expect(chatWithTools.tool_choice).toBe("auto");
    expect(chatWithTools.tools.map((t) => t.function?.name)).toEqual(["Bash", "Read", "read", "shell"]);

    const chatClash = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", description: "existing" } }],
    });
    expect(chatClash.tools.map((t) => t.function?.name)).toEqual(["read_client", "read", "shell"]);
    expect(chatClash.tools[0].function.description).toBe("existing");
  });

  it("cloaks Muse Responses requests even when the client already supplies tools", () => {
    const executor = getExecutor("opencode");
    const transformed = executor.transformRequest("muse-spark-1.3-contributor-free(xhigh)", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{
        type: "function",
        name: "zcode_search",
        description: "client-provided tool",
        parameters: { type: "object", properties: {} },
      }],
      tool_choice: "auto",
      reasoning_effort: "xhigh",
    }, true, {});

    expect(transformed.stream).toBe(true);
    expect(transformed.reasoning?.effort).toBe("xhigh");
    expect(transformed.tools.map((tool) => tool.name)).toEqual(["zcode_search", "read", "shell"]);
    expect(transformed.instructions).toMatch(/Do not call the `read` or `shell` tools/);
  });

  it("declares forceStream on the opencode transport so chatCore serves SSE upstream", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(PROVIDERS.opencode?.forceStream).toBe(true);
  });
});

describe("OpenCode 429 FreeUsageLimitError session rotation", () => {
  const freeLimitBody = JSON.stringify({
    error: { message: "Free Usage Limit Reached", code: "FreeUsageLimitError" },
  });
  const okBody = JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] });

  function runExecutor() {
    const executor = getExecutor("opencode");
    return executor.execute({
      model: "nemotron-3-ultra-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: makeCredentials(),
      providerSessionId: null,
      clientTool: "claude",
    });
  }

  const sessionOf = (call) => call[1].headers["x-opencode-session"];

  it("rotates to a fresh session and retries when the free-limit 429 hits", async () => {
    fetchMock.mockResolvedValueOnce(new Response(freeLimitBody, { status: 429, headers: { "content-type": "application/json" } }));
    fetchMock.mockResolvedValueOnce(new Response(okBody, { status: 200, headers: { "content-type": "application/json" } }));

    const result = await runExecutor();
    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sessionOf(fetchMock.mock.calls[0])).toMatch(OPENCODE_SESSION_RE);
    expect(sessionOf(fetchMock.mock.calls[1])).toMatch(OPENCODE_SESSION_RE);
    expect(sessionOf(fetchMock.mock.calls[1])).not.toBe(sessionOf(fetchMock.mock.calls[0]));
  });

  it("does not retry a 429 that is not a FreeUsageLimitError", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }));

    const result = await runExecutor();
    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops after the configured two rotations and returns the 429", async () => {
    for (let i = 0; i < 3; i++) {
      fetchMock.mockResolvedValueOnce(new Response(freeLimitBody, { status: 429, headers: { "content-type": "application/json" } }));
    }

    const result = await runExecutor();
    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sessions = fetchMock.mock.calls.map(sessionOf);
    expect(new Set(sessions).size).toBe(3);
  });

  // Live-verified: when the shared free pool is drained until the daily 00:00 UTC
  // reset, upstream answers fresh sessions with retry-after of hours. Rotation
  // cannot fix that — veto it so each attempt costs one round trip.
  it("skips rotation when Retry-After points at a pool reset hours away", async () => {
    fetchMock.mockResolvedValueOnce(new Response(freeLimitBody, {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "41138" },
    }));

    const result = await runExecutor();
    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

});

describe("translateSessionId produces a canonical inverted-timestamp session", () => {
  // Zen rejects a ses_ whose 12 hex prefix is not ~(Date.now()*4096+n) with 403 FreeTierError.
  const MASK = 0xffffffffffffn;
  // The 12 hex chars are the low 48 bits of ~(ms * 4096 + counter); compare in that space.
  const decodedUnits = (id) => MASK - BigInt("0x" + id.slice(4, 16));

  it("encodes a recent timestamp, not hash bits", () => {
    const id = translateSessionId("claude:550e8400-e29b-41d4-a716-446655440000", "claude");
    expect(id).toMatch(OPENCODE_SESSION_RE);
    const nowUnits = (BigInt(Date.now()) * 0x1000n) & MASK;
    const diffMs = Number((decodedUnits(id) - nowUnits) / 0x1000n);
    expect(Math.abs(diffMs)).toBeLessThan(60_000);
  });

  it("is stable for the same downstream session and differs across sessions", () => {
    const a1 = translateSessionId("conv-a", "claude");
    expect(translateSessionId("conv-a", "claude")).toBe(a1);
    expect(translateSessionId("conv-b", "claude")).not.toBe(a1);
    expect(translateSessionId("conv-a", "codex")).not.toBe(a1);
  });
});
