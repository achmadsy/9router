import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyDashboardAuthToken: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  getConsistentMachineId: vi.fn(),
  getSettings: vi.fn(),
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
});

describe("Probe CSRF / Origin Verification", () => {
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
