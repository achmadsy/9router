import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORIGINAL_SUITE_CATEGORY_BY_ID,
  ORIGINAL_SUITE_IDS,
} from "../../src/lib/probe/originalSuite.js";

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

function publicProbe(id) {
  return {
    id,
    label: `Label ${id}`,
    group: ORIGINAL_SUITE_CATEGORY_BY_ID.get(id),
    description: `Description ${id}`,
  };
}

function publicCatalog(extras = []) {
  return [...ORIGINAL_SUITE_IDS.map(publicProbe), ...extras];
}

function catalog(probes = publicCatalog()) {
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

  it("projects the exact ordered 86-probe public catalog and excludes extras", async () => {
    const input = publicCatalog([
      { id: "quality_extra", label: "Extra", group: "quality", description: "Excluded." },
    ]).reverse();
    const drawerProbe = input.find((probe) => probe.id === ORIGINAL_SUITE_IDS[0]);
    Object.assign(drawerProbe, {
      optional: true,
      prompt: "P".repeat(600),
      expected: "E".repeat(400),
      scoring: "feature_extract",
    });
    mocks.getProbeCatalogFromSidecar.mockResolvedValue(catalog(input));

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json();
    expect(data.version).toBe("0.11.0");
    expect(data.probes.map((probe) => probe.id)).toEqual(ORIGINAL_SUITE_IDS);
    expect(data.probes).toHaveLength(86);
    expect(data.probes.some((probe) => probe.id === "quality_extra")).toBe(false);
    expect(data.probes[0].prompt).toBe("P".repeat(500));
    expect(data.probes[0].expected).toBe("E".repeat(300));
    expect(data.probes[0].scoring).toBe("feature_extract");
    expect(data.probes[0].optional).toBe(true);
    expect(mocks.getProbeCatalogFromSidecar).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("rejects a catalog missing any required public probe", async () => {
    mocks.getProbeCatalogFromSidecar.mockResolvedValue(catalog(publicCatalog().slice(1)));
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Probe catalog invalid" });
  });

  it.each([
    ["an empty catalog", []],
    ["duplicate IDs", [...publicCatalog(), publicProbe(ORIGINAL_SUITE_IDS[0])]],
    ["an empty ID", [...publicCatalog(), { id: " ", label: "One", group: "quality", description: "One." }]],
    ["a malformed record", [...publicCatalog(), { id: "one", label: "One", group: "quality" }]],
    ["an oversized field", [...publicCatalog(), { id: "one", label: "x".repeat(257), group: "quality", description: "One." }]],
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
