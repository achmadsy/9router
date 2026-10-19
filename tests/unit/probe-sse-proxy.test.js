import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyProbeAdminAuth: vi.fn(),
  verifyCsrfOrigin: vi.fn(() => true),
  getProbeProfileSecrets: vi.fn(),
  runProbeOnSidecar: vi.fn(),
  cancelProbeOnSidecar: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/probe/auth.js", () => ({
  verifyProbeAdminAuth: mocks.verifyProbeAdminAuth,
  verifyCsrfOrigin: mocks.verifyCsrfOrigin,
}));

vi.mock("@/lib/db/repos/probeProfilesRepo.js", () => ({
  getProbeProfileSecrets: mocks.getProbeProfileSecrets,
}));

vi.mock("@/lib/probe/sidecarClient.js", () => ({
  runProbeOnSidecar: mocks.runProbeOnSidecar,
  cancelProbeOnSidecar: mocks.cancelProbeOnSidecar,
  getSidecarHealth: vi.fn(async () => ({ reachable: true, status: 200 })),
}));

const { POST: runPost, GET: runGet } = await import(
  "../../src/app/api/probe/run/route.js"
);
const { POST: cancelPost } = await import(
  "../../src/app/api/probe/cancel/route.js"
);
const {
  __testResetActiveRun,
  startActiveRun,
  cancelActiveRun,
} = await import("../../src/lib/probe/activeRun.js");
const {
  createBoundedSseStream,
  boundErrorMessage,
  MAX_ERROR_CHARS,
} = await import("../../src/lib/probe/sseProxy.js");

function createMockSseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Probe Run & One Active Run Enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testResetActiveRun();
    mocks.verifyProbeAdminAuth.mockResolvedValue({
      authorized: true,
      ownerId: "admin-1",
    });
  });

  it("starts a run successfully and rejects concurrent second run with 409", async () => {
    mocks.runProbeOnSidecar.mockResolvedValue(
      createMockSseResponse(["event: message\ndata: {\"step\":\"started\"}\n\n"])
    );

    const body = {
      target: { provider: "openai", model: "gpt-4o" },
      judge: { provider: "anthropic", model: "claude-3-5-sonnet" },
    };

    const req1 = new Request("https://router.test/api/probe/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const res1 = await runPost(req1);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toBe("text/event-stream");
    const activeRunId = res1.headers.get("x-probe-run-id");
    expect(activeRunId).toMatch(/^prun_/);

    // Verify GET /api/probe/run reports active run
    const statusRes = await runGet(new Request("https://router.test/api/probe/run"));
    const statusData = await statusRes.json();
    expect(statusData.active).toBe(true);
    expect(statusData.run.runId).toBe(activeRunId);

    // Second concurrent run must be rejected with 409 Conflict
    const req2 = new Request("https://router.test/api/probe/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const res2 = await runPost(req2);
    expect(res2.status).toBe(409);
    const errBody = await res2.json();
    expect(errBody.error).toMatch(/already in progress/i);
    expect(errBody.activeRunId).toBe(activeRunId);
  });
});

describe("Probe Cancel Ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testResetActiveRun();
  });

  it("enforces cancel ownership: non-owner gets 403, owner gets 200", async () => {
    const abortCtrl = new AbortController();
    startActiveRun({
      runId: "prun_12345",
      ownerId: "user-alpha",
      abortController: abortCtrl,
    });

    // User Beta tries to cancel -> 403 Forbidden
    mocks.verifyProbeAdminAuth.mockResolvedValue({
      authorized: true,
      ownerId: "user-beta",
    });

    const cancelReq1 = new Request("https://router.test/api/probe/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "prun_12345" }),
    });

    const res1 = await cancelPost(cancelReq1);
    expect(res1.status).toBe(403);
    const err1 = await res1.json();
    expect(err1.error).toMatch(/not the owner/i);
    expect(abortCtrl.signal.aborted).toBe(false);

    // User Alpha (owner) cancels -> 200 OK
    mocks.verifyProbeAdminAuth.mockResolvedValue({
      authorized: true,
      ownerId: "user-alpha",
    });

    const cancelReq2 = new Request("https://router.test/api/probe/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "prun_12345" }),
    });

    const res2 = await cancelPost(cancelReq2);
    expect(res2.status).toBe(200);
    const okData = await res2.json();
    expect(okData.cancelled).toBe(true);
    expect(okData.runId).toBe("prun_12345");
    expect(abortCtrl.signal.aborted).toBe(true);
  });

  it("allows CLI machine token to cancel any run", async () => {
    const abortCtrl = new AbortController();
    startActiveRun({
      runId: "prun_cli_test",
      ownerId: "user-session-9",
      abortController: abortCtrl,
    });

    mocks.verifyProbeAdminAuth.mockResolvedValue({
      authorized: true,
      ownerId: "cli:machine",
    });

    const cancelReq = new Request("https://router.test/api/probe/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "prun_cli_test" }),
    });

    const res = await cancelPost(cancelReq);
    expect(res.status).toBe(200);
    expect(abortCtrl.signal.aborted).toBe(true);
  });

  it("returns 404 when cancelling with no active run", async () => {
    mocks.verifyProbeAdminAuth.mockResolvedValue({
      authorized: true,
      ownerId: "admin",
    });

    const cancelReq = new Request("https://router.test/api/probe/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "prun_nonexistent" }),
    });

    const res = await cancelPost(cancelReq);
    expect(res.status).toBe(404);
  });

  it("returns 400 when cancelling with wrong runId", async () => {
    startActiveRun({
      runId: "prun_active",
      ownerId: "admin",
      abortController: new AbortController(),
    });

    mocks.verifyProbeAdminAuth.mockResolvedValue({
      authorized: true,
      ownerId: "admin",
    });

    const cancelReq = new Request("https://router.test/api/probe/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "prun_different" }),
    });

    const res = await cancelPost(cancelReq);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/run id mismatch/i);
  });
});

describe("Probe Bounded SSE Proxy & Errors", () => {
  it("bounds error messages to MAX_ERROR_CHARS", () => {
    const longMsg = "A".repeat(1000);
    const bounded = boundErrorMessage(longMsg);
    expect(bounded.length).toBeLessThanOrEqual(MAX_ERROR_CHARS + 20);
    expect(bounded).toContain("[truncated]");

    const shortMsg = "Connection timeout";
    expect(boundErrorMessage(shortMsg)).toBe("Connection timeout");
  });

  it("bounds single SSE event size to 64KB and terminates stream", async () => {
    const runId = "prun_bound_test";
    const transform = createBoundedSseStream(runId);
    const oversized = "X".repeat(70 * 1024); // 70 KB single event

    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${oversized}\n\n`));
        controller.close();
      },
    });

    const reader = readable.pipeThrough(transform).getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }

    expect(output).toContain("Single SSE event size exceeded 64KB limit");
  });
});

describe("Early SSRF Validation on Target/Judge Endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testResetActiveRun();
    mocks.verifyProbeAdminAuth.mockResolvedValue({
      authorized: true,
      ownerId: "admin",
    });
  });

  it.each([
    ["file:///etc/passwd", "invalid scheme"],
    ["ftp://example.com/api", "invalid scheme"],
    ["https://user:pass@example.com/api", "credentials not allowed"],
    ["http://127.0.0.1:8080/v1", "internal host"],
    ["http://localhost:3000", "internal host"],
    ["http://service.internal/v1", "internal host"],
    ["http://probe.lan/v1", "internal host"],
    ["http://metadata.google.internal/v1", "internal host"],
    ["http://example.com:22/v1", "restricted port"],
    ["http://example.com:0/v1", "invalid port"],
  ])("rejects SSRF endpoint %s", async (endpoint, expectedReason) => {
    const req = new Request("https://router.test/api/probe/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { provider: "custom", endpoint },
        judge: { provider: "openai", model: "gpt-4o" },
      }),
    });

    const res = await runPost(req);
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.error).toContain(expectedReason);
  });
});
