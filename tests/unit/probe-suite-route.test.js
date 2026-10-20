import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyProbeAdminAuth: vi.fn(),
  getProbeCatalogFromSidecar: vi.fn(),
}));

vi.mock("@/lib/probe/auth.js", () => ({
  verifyProbeAdminAuth: mocks.verifyProbeAdminAuth,
}));
vi.mock("@/lib/probe/sidecarClient.js", () => ({
  getProbeCatalogFromSidecar: mocks.getProbeCatalogFromSidecar,
}));

const { GET } = await import("../../src/app/api/probe/suite/route.js");

function request() {
  return new Request("https://router.test/api/probe/suite");
}

function catalog(probes = [{
  id: "quality_probe",
  label: "Quality Probe",
  group: "quality",
  description: "Checks response quality.",
  isNew: true,
  prompt: "must not escape",
  scoring: { mode: "secret" },
}]) {
  return {
    ok: true,
    status: 200,
    data: { version: "0.11.0", probes },
  };
}

describe("Probe suite route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyProbeAdminAuth.mockResolvedValue({ authorized: true, ownerId: "admin" });
    mocks.getProbeCatalogFromSidecar.mockResolvedValue(catalog());
  });

  it("requires Probe admin authentication", async () => {
    mocks.verifyProbeAdminAuth.mockResolvedValue({ authorized: false, ownerId: null });
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(mocks.getProbeCatalogFromSidecar).not.toHaveBeenCalled();
  });

  it("returns an ordered display-only catalog with no-store caching", async () => {
    mocks.getProbeCatalogFromSidecar.mockResolvedValue(catalog([
      {
        id: "first",
        label: "First",
        group: "quality",
        description: "First probe.",
        optional: true,
        prompt: "hidden prompt",
      },
      {
        id: "second",
        label: "Second",
        group: "identity",
        description: "Second probe.",
        neutral: true,
        scoring: { mode: "hidden" },
      },
    ]));

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      version: "0.11.0",
      probes: [
        {
          id: "first",
          label: "First",
          group: "quality",
          description: "First probe.",
          optional: true,
        },
        {
          id: "second",
          label: "Second",
          group: "identity",
          description: "Second probe.",
          neutral: true,
        },
      ],
    });
    expect(mocks.getProbeCatalogFromSidecar).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it.each([
    ["an empty catalog", []],
    ["duplicate IDs", [
      { id: "same", label: "One", group: "quality", description: "One." },
      { id: "same", label: "Two", group: "identity", description: "Two." },
    ]],
    ["an empty ID", [
      { id: " ", label: "One", group: "quality", description: "One." },
    ]],
    ["a malformed record", [
      { id: "one", label: "One", group: "quality" },
    ]],
    ["an oversized field", [
      { id: "one", label: "x".repeat(257), group: "quality", description: "One." },
    ]],
  ])("rejects %s", async (_name, probes) => {
    mocks.getProbeCatalogFromSidecar.mockResolvedValue(catalog(probes));
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Probe catalog invalid" });
  });

  it("rejects catalogs above the record cap", async () => {
    const probes = Array.from({ length: 257 }, (_, index) => ({
      id: `probe-${index}`,
      label: `Probe ${index}`,
      group: "quality",
      description: "Probe description.",
    }));
    mocks.getProbeCatalogFromSidecar.mockResolvedValue(catalog(probes));
    expect((await GET(request())).status).toBe(502);
  });

  it("normalizes sidecar HTTP errors without relaying details", async () => {
    mocks.getProbeCatalogFromSidecar.mockResolvedValue({
      ok: false,
      status: 401,
      data: { error: "token secret at http://llmprobe-engine:3001" },
    });
    const response = await GET(request());
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("Probe catalog unavailable");
    expect(text).not.toContain("token secret");
    expect(text).not.toContain("llmprobe-engine");
  });

  it("normalizes transport errors without relaying details", async () => {
    mocks.getProbeCatalogFromSidecar.mockRejectedValue(
      new Error("Bearer private-token failed at http://llmprobe-engine:3001")
    );
    const response = await GET(request());
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("Probe catalog unavailable");
    expect(text).not.toContain("private-token");
    expect(text).not.toContain("llmprobe-engine");
  });
});
