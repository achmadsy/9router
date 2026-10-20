import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyDashboardAuthToken: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  getConsistentMachineId: vi.fn(),
  getSettings: vi.fn(),
  getSidecarHealth: vi.fn(),
}));

vi.mock("@/lib/probe/sidecarClient.js", () => ({
  getSidecarHealth: mocks.getSidecarHealth,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
  getDashboardAuthSession: mocks.getDashboardAuthSession,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

const { verifyProbeAdminAuth, verifyCsrfOrigin } = await import("../../src/lib/probe/auth.js");
const { GET: healthGet } = await import("../../src/app/api/probe/health/route.js");

describe("Probe Admin Auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConsistentMachineId.mockResolvedValue("test-cli-machine-id");
    mocks.getSettings.mockResolvedValue({ requireLogin: false }); // Explicitly false!
  });

  it("rejects unauthenticated request even when requireLogin=false", async () => {
    const req = new Request("https://router.test/api/probe/health");
    const auth = await verifyProbeAdminAuth(req);
    expect(auth.authorized).toBe(false);

    const res = await healthGet(req);
    expect(res.status).toBe(401);
  });

  it("authorizes request with valid x-9r-cli-token", async () => {
    const req = new Request("https://router.test/api/probe/health", {
      headers: { "x-9r-cli-token": "test-cli-machine-id" },
    });
    const auth = await verifyProbeAdminAuth(req);
    expect(auth.authorized).toBe(true);
    expect(auth.ownerId).toBe("cli:machine");
  });

  it("rejects request with invalid x-9r-cli-token", async () => {
    const req = new Request("https://router.test/api/probe/health", {
      headers: { "x-9r-cli-token": "wrong-token" },
    });
    const auth = await verifyProbeAdminAuth(req);
    expect(auth.authorized).toBe(false);
  });

  it("authorizes request with valid Bearer JWT", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue({
      authenticated: true,
      sub: "admin-user-1",
    });

    const req = new Request("https://router.test/api/probe/health", {
      headers: { authorization: "Bearer valid-jwt-token" },
    });
    const auth = await verifyProbeAdminAuth(req);
    expect(auth.authorized).toBe(true);
    expect(auth.ownerId).toBe("admin-user-1");
  });

  it("authorizes request with valid auth_token cookie", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue({
      authenticated: true,
      sub: "cookie-user-2",
    });

    const req = new Request("https://router.test/api/probe/health", {
      headers: { cookie: "auth_token=valid-cookie-jwt" },
    });
    const auth = await verifyProbeAdminAuth(req);
    expect(auth.authorized).toBe(true);
    expect(auth.ownerId).toBe("cookie-user-2");
  });

  it("rejects invalid or unauthenticated session token", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue(null);

    const req = new Request("https://router.test/api/probe/health", {
      headers: { authorization: "Bearer expired-token" },
    });
    const auth = await verifyProbeAdminAuth(req);
    expect(auth.authorized).toBe(false);
  });

  it.each([
    [{ authenticated: true, saml: true, samlEmail: "sso@saml.example" }, "sso@saml.example"],
    [{ authenticated: true, oidc: true, oidcEmail: "sso@oidc.example" }, "sso@oidc.example"],
    [{ authenticated: true, oidc: true, oidcSub: "oidc-sub-7" }, "oidc-sub-7"],
    [{ authenticated: true }, "admin:session"],
  ])("derives ownerId from session identity %j", async (session, expected) => {
    mocks.getDashboardAuthSession.mockResolvedValue(session);

    const req = new Request("https://router.test/api/probe/health", {
      headers: { authorization: "Bearer valid-jwt-token" },
    });
    const auth = await verifyProbeAdminAuth(req);
    expect(auth.authorized).toBe(true);
    expect(auth.ownerId).toBe(expected);
  });
});

describe("Probe Health Route Response Shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConsistentMachineId.mockResolvedValue("test-cli-machine-id");
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
  });

  it("reports ok without leaking sidecar internals", async () => {
    mocks.getSidecarHealth.mockResolvedValue({
      reachable: true,
      status: 200,
      versionBanner: "LLMprobe engine v2.7.1 (custom build)",
      sidecarUrl: "http://probe-sidecar:7842",
    });

    const req = new Request("https://router.test/api/probe/health", {
      headers: { "x-9r-cli-token": "test-cli-machine-id" },
    });
    const res = await healthGet(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      sidecar: { reachable: true, status: 200 },
    });
    expect(JSON.stringify(body)).not.toContain("sidecarUrl");
    expect(JSON.stringify(body)).not.toContain("versionBanner");
  });

  it("reports degraded when the sidecar is unreachable", async () => {
    mocks.getSidecarHealth.mockResolvedValue({
      reachable: false,
      status: 0,
    });

    const req = new Request("https://router.test/api/probe/health", {
      headers: { "x-9r-cli-token": "test-cli-machine-id" },
    });
    const res = await healthGet(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.sidecar.reachable).toBe(false);
  });
});

describe("Probe CSRF / Origin Verification", () => {
  beforeEach(() => {
    delete process.env.BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });

  it("allows requests from same host", () => {
    const req = new Request("https://localhost:20128/api/probe/run", {
      method: "POST",
      headers: {
        host: "localhost:20128",
        origin: "https://localhost:20128",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(true);
  });

  it("blocks cross-origin requests", () => {
    const req = new Request("https://localhost:20128/api/probe/run", {
      method: "POST",
      headers: {
        host: "localhost:20128",
        origin: "https://attacker.example.com",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(false);
  });

  it("allows non-browser CLI requests without origin", () => {
    const req = new Request("https://localhost:20128/api/probe/run", {
      method: "POST",
      headers: {
        host: "localhost:20128",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(true);
  });

  it("blocks same-host-but-different-port origins", () => {
    const req = new Request("https://localhost:20128/api/probe/run", {
      method: "POST",
      headers: {
        host: "localhost:20128",
        origin: "https://localhost:9999",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(false);
  });

  it("blocks same-host origins whose scheme differs from the request", () => {
    const req = new Request("http://router.example/api/probe/run", {
      method: "POST",
      headers: {
        host: "router.example",
        origin: "https://router.example",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(false);
  });

  it("uses trusted forwarded scheme for exact origin comparison", () => {
    const req = new Request("http://router.internal/api/probe/run", {
      method: "POST",
      headers: {
        host: "router.example",
        origin: "https://router.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(true);
  });

  it("allows an exact configured base origin", () => {
    process.env.BASE_URL = "https://router.example:8443/dashboard";
    const req = new Request("http://router.internal/api/probe/run", {
      method: "POST",
      headers: {
        host: "router.internal",
        origin: "https://router.example:8443",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(true);
  });

  it("blocks a configured host with a different port", () => {
    process.env.BASE_URL = "https://router.example:8443";
    const req = new Request("http://router.internal/api/probe/run", {
      method: "POST",
      headers: {
        host: "router.internal",
        origin: "https://router.example:9443",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(false);
  });

  it("blocks a configured host with a different scheme", () => {
    process.env.BASE_URL = "https://router.example:8443";
    const req = new Request("http://router.internal/api/probe/run", {
      method: "POST",
      headers: {
        host: "router.internal",
        origin: "http://router.example:8443",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(false);
  });

  it("allows loopback origins with hostname variation on the same scheme and port", () => {
    const req = new Request("http://localhost:20128/api/probe/run", {
      method: "POST",
      headers: {
        host: "localhost:20128",
        origin: "http://127.0.0.1:20128",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(true);
  });

  it("blocks loopback hostname variations with a different scheme", () => {
    const req = new Request("http://localhost:20128/api/probe/run", {
      method: "POST",
      headers: {
        host: "localhost:20128",
        origin: "https://127.0.0.1:20128",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(false);
  });

  it("blocks cross-site Sec-Fetch-Site requests even without origin", () => {
    const req = new Request("https://localhost:20128/api/probe/run", {
      method: "POST",
      headers: {
        host: "localhost:20128",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(verifyCsrfOrigin(req)).toBe(false);
  });
});
