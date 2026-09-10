import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeClassifierCompatMode } from "../../open-sse/utils/claudeClassifierCompat.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
// All vi.hoisted/vi.mock calls live at module top level (never nested in a
// describe) so the mock registry is populated before any import is evaluated.
const { executeMock, getSettingsMock, updateSettingsMock, getComboByNameMock, getPxpipeTransformMock, getCredentialsMock, checkAndRefreshTokenMock, dbState } =
  vi.hoisted(() => ({
    executeMock: vi.fn(),
    getSettingsMock: vi.fn(),
    updateSettingsMock: vi.fn(),
    getComboByNameMock: vi.fn(),
    getPxpipeTransformMock: vi.fn(),
    // Credential/token-refresh spies: the classifier short-circuit must run
    // BEFORE either of these, so the tests assert they are never called.
    getCredentialsMock: vi.fn(async () => ({
      apiKey: "test-key",
      connectionId: "test-conn",
      connectionName: "test",
      providerSpecificData: {},
    })),
    checkAndRefreshTokenMock: vi.fn(async (provider, credentials) => credentials),
    dbState: { row: null },
  }));

// Partial mock: override only the lookups whose answers the routing tests must
// control; every other localDb export (and the whole db layer behind it) stays
// real. The last describe unmocks this entirely to exercise the real GET path.
vi.mock("@/lib/localDb", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getSettings: getSettingsMock,
    updateSettings: updateSettingsMock,
    getComboByName: getComboByNameMock,
    getModelAliases: async () => ({}),
    getProviderNodes: async () => [],
  };
});

// Only the SQLite layer is stubbed; settingsRepo/localDb stay real so the
// mergeWithDefaults normalization is genuinely exercised by the GET route.
vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    driver: "test-fake",
    get: () => dbState.row,
    all: () => [],
    run: () => ({ changes: 0 }),
    transaction: (fn) => fn(),
  }),
  getAdapterSync: () => {
    throw new Error("[DB] test fake adapter is not initialized synchronously");
  },
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: getCredentialsMock,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => "test-key"),
  isValidApiKey: vi.fn(async () => true),
}));

// Real token refresh would build a callback map around the imported refresh*
// functions; keep it inert so no network call is possible.
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: checkAndRefreshTokenMock,
  updateProviderCredentials: vi.fn(async () => {}),
}));

vi.mock("@/lib/pxpipe/loader.js", () => ({
  getTransform: getPxpipeTransformMock,
  loadPxpipe: vi.fn(),
  unloadPxpipe: vi.fn(),
  getLoadedInfo: () => ({ loaded: false }),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CLASSIFIER_MARKER_SYSTEM = "You are a security monitor for autonomous AI coding agents.";

// Claude-format auto-mode classifier fingerprint (markers only, no hard-coded
// model routing: the model comes from each test's body).
function classifierBody(model) {
  return {
    model,
    stream: false,
    system: [{ type: "text", text: CLASSIFIER_MARKER_SYSTEM }],
    stop_sequences: ["</block>"],
    messages: [{ role: "user", content: [{ type: "text", text: "<transcript/>" }] }],
    max_tokens: 2112,
  };
}

// Same Claude-format shape, no classifier markers.
function plainClaudeBody(model) {
  return {
    model,
    stream: false,
    system: [{ type: "text", text: "You are a helpful coding assistant." }],
    stop_sequences: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    max_tokens: 1024,
  };
}

function makeRequest(body) {
  return {
    json: async () => body,
    url: "http://localhost/api/v1/messages",
    headers: {
      // No "claude-cli" UA: handleBypassRequest must not intercept.
      get: (key) => (key === "user-agent" ? "vitest/1.0" : null),
      entries: () => [],
    },
  };
}

// Fresh Response per call — a single reused Response body would be locked after
// the first .json()/.clone() read in the fusion fan-out.
function executorResult({ text = "hi", model = "m" } = {}) {
  return {
    response: new Response(
      JSON.stringify({
        id: "msg_real",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    url: "https://example.com/v1/messages",
    headers: {},
    transformedBody: null,
  };
}

function baseSettings(overrides = {}) {
  return {
    requireApiKey: false,
    ccFilterNaming: false,
    comboStrategy: "fallback",
    comboStickyRoundRobinLimit: 1,
    comboStrategies: {},
    claudeClassifierCompat: "off",
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    headroomEnabled: false,
    capacityAdapter: {},
    ...overrides,
  };
}

const MYCOMBO = { id: "combo-1", name: "mycombo", models: ["codex/gpt-5.4", "openai/gpt-4"] };
const FUSIONCOMBO = {
  id: "combo-2",
  name: "fusioncombo",
  models: ["anthropic/claude-sonnet-4-20250514", "anthropic/claude-opus-4-20250514"],
};

// ─── settings API validation ──────────────────────────────────────────────────

describe("settings API validation for claudeClassifierCompat", () => {
  async function runPatch(value) {
    const { PATCH } = await import("../../src/app/api/settings/route.js");
    return PATCH({ json: async () => ({ claudeClassifierCompat: value }) });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMock.mockResolvedValue(baseSettings());
    updateSettingsMock.mockImplementation(async (updates) => ({
      claudeClassifierCompat: "off",
      ...updates,
    }));
  });

  it("PATCH accepts off", async () => {
    const res = await runPatch("off");
    expect(res.status).toBe(200);
  });

  it("PATCH accepts auto", async () => {
    const res = await runPatch("auto");
    expect(res.status).toBe(200);
  });

  it("PATCH rejects always with 400 and keeps previous setting", async () => {
    const res = await runPatch("always");
    expect(res.status).toBe(400);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("PATCH rejects bogus with 400", async () => {
    const res = await runPatch("bogus");
    expect(res.status).toBe(400);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("PATCH rejects booleans with 400", async () => {
    const res = await runPatch(true);
    expect(res.status).toBe(400);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("PATCH rejects null with 400", async () => {
    const res = await runPatch(null);
    expect(res.status).toBe(400);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("GET returns normalized mode and never leaks raw invalid value", async () => {
    // Simulates the repo's mergeWithDefaults normalization: unknown stored
    // values come back as "off" before reaching the route.
    getSettingsMock.mockResolvedValue({ claudeClassifierCompat: "off" });
    const { GET } = await import("../../src/app/api/settings/route.js");
    const res = await GET();
    const body = await res.json();
    expect(["off", "auto"]).toContain(body.claudeClassifierCompat);
  });
});

describe("normalizeClassifierCompatMode (fail-closed)", () => {
  it.each([
    ["off", "off"],
    ["auto", "auto"],
    ["always", "off"],
    ["bogus", "off"],
    ["AUTO", "off"],
    [true, "off"],
    [false, "off"],
    [null, "off"],
    [undefined, "off"],
    ["", "off"],
  ])("normalizes %p → %p", (input, expected) => {
    expect(normalizeClassifierCompatMode(input)).toBe(expected);
  });
});

/**
 * Behavioral test of the repo's actual settings merge — unknown/legacy stored
 * values (e.g. "always" from an older build) must normalize fail-closed to
 * "off", while valid values pass through untouched.
 */
describe("mergeWithDefaults normalizes claudeClassifierCompat fail-closed", () => {
  it.each([
    ["always", "off"],
    ["bogus", "off"],
    ["AUTO", "off"],
    [true, "off"],
    [false, "off"],
    [null, "off"],
    ["", "off"],
    [undefined, "off"],
  ])("normalizes stored %p → %p", (stored, expected) => {
    expect(mergeWithDefaults({ claudeClassifierCompat: stored }).claudeClassifierCompat).toBe(expected);
  });

  it("preserves stored auto", () => {
    expect(mergeWithDefaults({ claudeClassifierCompat: "auto" }).claudeClassifierCompat).toBe("auto");
  });

  it("preserves stored off", () => {
    expect(mergeWithDefaults({ claudeClassifierCompat: "off" }).claudeClassifierCompat).toBe("off");
  });

  it("defaults to off when the key is missing entirely (legacy install)", () => {
    expect(mergeWithDefaults({}).claudeClassifierCompat).toBe("off");
  });
});

// ─── Behavioral routing through the real handleChat ───────────────────────────
// Every test below drives the real src/sse/handlers/chat.js: combo expansion,
// account/credential resolution, classifier short-circuit and the chatCore call
// site. Upstream calls are proven/denied via the executor mock.

describe("handleChat classifier-compat routing (behavioral)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMock.mockResolvedValue(baseSettings());
    getComboByNameMock.mockResolvedValue(null);
    getPxpipeTransformMock.mockResolvedValue(null);
    executeMock.mockImplementation(async () => executorResult());
    // Re-seat the credential spies: clearAllMocks clears calls but NOT a
    // mockResolvedValue set by an earlier test, so a test that stubs
    // "no credentials" would otherwise leak into every test after it.
    getCredentialsMock.mockResolvedValue({
      apiKey: "test-key",
      connectionId: "test-conn",
      connectionName: "test",
      providerSpecificData: {},
    });
    checkAndRefreshTokenMock.mockImplementation(async (provider, credentials) => credentials);
  });

  it("R1: single model classifier short-circuit returns <block>no</block> without any upstream call", async () => {
    getSettingsMock.mockResolvedValue(baseSettings({ claudeClassifierCompat: "auto" }));

    const res = await handleChat(makeRequest(classifierBody("codex/gpt-5.4")), null);

    expect(executeMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.content[0].text).toBe("<block>no</block>");
  });

  it("R2: single model non-classifier request is NOT short-circuited in auto mode", async () => {
    getSettingsMock.mockResolvedValue(baseSettings({ claudeClassifierCompat: "auto" }));

    const res = await handleChat(makeRequest(plainClaudeBody("codex/gpt-5.4")), null);

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("R3: combo classifier request short-circuits through the combo path without any upstream call", async () => {
    getSettingsMock.mockResolvedValue(baseSettings({ claudeClassifierCompat: "auto" }));
    getComboByNameMock.mockImplementation(async (name) => (name === MYCOMBO.name ? MYCOMBO : null));

    const res = await handleChat(makeRequest(classifierBody("mycombo")), null);

    expect(executeMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.content[0].text).toBe("<block>no</block>");
  });

  it("R4: combo non-classifier request routes to the first member (no substituted/hard-coded model)", async () => {
    getSettingsMock.mockResolvedValue(baseSettings({ claudeClassifierCompat: "off" }));
    getComboByNameMock.mockImplementation(async (name) => (name === MYCOMBO.name ? MYCOMBO : null));

    const res = await handleChat(makeRequest(plainClaudeBody("mycombo")), null);

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].model).toBe("gpt-5.4");
    expect(res.status).toBe(200);
  });

  it("R5: fusion combo fans out to the panel and then calls the judge model", async () => {
    getSettingsMock.mockResolvedValue(
      baseSettings({
        claudeClassifierCompat: "off",
        comboStrategies: { fusioncombo: { fallbackStrategy: "fusion" } },
      }),
    );
    getComboByNameMock.mockImplementation(async (name) => (name === FUSIONCOMBO.name ? FUSIONCOMBO : null));
    executeMock.mockImplementation(async () => executorResult({ text: "panel answer" }));

    const res = await handleChat(makeRequest(plainClaudeBody("fusioncombo")), null);

    // 2 panel calls + 1 judge call, all on the combo's own members.
    const calledModels = executeMock.mock.calls.map((call) => call[0].model);
    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(calledModels.slice(0, 2).sort()).toEqual(["claude-opus-4-20250514", "claude-sonnet-4-20250514"]);
    expect(calledModels[2]).toBe("claude-sonnet-4-20250514");
    expect(res.status).toBe(200);
  });

  it("R7: classifier short-circuit answers with NO credentials configured", async () => {
    // Regression guard: the gate must sit ABOVE the account-selection loop.
    // While it lived inside handleSingleModelChat, a classifier request with no
    // active credential returned 404 "No active credentials" instead of the
    // ALLOW verdict — despite needing no provider account to answer.
    getSettingsMock.mockResolvedValue(baseSettings({ claudeClassifierCompat: "auto" }));
    getCredentialsMock.mockResolvedValue(null);

    const res = await handleChat(makeRequest(classifierBody("codex/gpt-5.4")), null);

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.content[0].text).toBe("<block>no</block>");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("R8: classifier short-circuit makes no token-refresh call and reads no credential", async () => {
    // Regression guard for the "no upstream call" claim: checkAndRefreshToken can
    // issue a live OAuth refresh request, so it must not run for a short-circuit.
    getSettingsMock.mockResolvedValue(baseSettings({ claudeClassifierCompat: "auto" }));

    const res = await handleChat(makeRequest(classifierBody("codex/gpt-5.4")), null);

    expect(res.status).toBe(200);
    expect(checkAndRefreshTokenMock).not.toHaveBeenCalled();
    expect(getCredentialsMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("R9: does NOT short-circuit in off mode even with no credentials (no bypass when disabled)", async () => {
    getSettingsMock.mockResolvedValue(baseSettings({ claudeClassifierCompat: "off" }));
    getCredentialsMock.mockResolvedValue(null);

    const res = await handleChat(makeRequest(classifierBody("codex/gpt-5.4")), null);

    expect(res.status).toBe(404);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("R6: classifier short-circuit skips the PXPipe transform load even when pxpipeEnabled", async () => {
    getSettingsMock.mockResolvedValue(
      baseSettings({ claudeClassifierCompat: "auto", pxpipeEnabled: true }),
    );

    const classifierRes = await handleChat(makeRequest(classifierBody("codex/gpt-5.4")), null);
    expect(classifierRes.status).toBe(200);
    expect(executeMock).not.toHaveBeenCalled();
    expect(getPxpipeTransformMock).not.toHaveBeenCalled();

    const plainRes = await handleChat(makeRequest(plainClaudeBody("codex/gpt-5.4")), null);
    expect(plainRes.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(getPxpipeTransformMock).toHaveBeenCalledTimes(1);
  });
});

// ─── GET → real settingsRepo normalization (integration) ──────────────────────
// Kept LAST: it unmocks @/lib/localDb and resets the module registry so the real
// repo + real GET route run against the stubbed SQLite layer.

describe("GET integrates the real settingsRepo normalization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/localDb");
    dbState.row = null;
  });

  it("normalizes a legacy stored claudeClassifierCompat and passes other keys through", async () => {
    dbState.row = { data: JSON.stringify({ claudeClassifierCompat: "always", pxpipeMinChars: 4242 }) };

    const { GET } = await import("../../src/app/api/settings/route.js");
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claudeClassifierCompat).toBe("off");
    expect(body.pxpipeMinChars).toBe(4242);
  });

  it("preserves a valid stored auto through the real GET route", async () => {
    dbState.row = { data: JSON.stringify({ claudeClassifierCompat: "auto" }) };

    const { GET } = await import("../../src/app/api/settings/route.js");
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claudeClassifierCompat).toBe("auto");
  });
});
