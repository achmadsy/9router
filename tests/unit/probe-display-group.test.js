import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROBES,
  PROBE_CATEGORIES,
  getProbeDisplayGroup,
} from "../../src/app/(dashboard)/dashboard/probe/components/probeConstants.js";

// The report mirrors the original BazaarLink page: exactly four sections.
describe("Probe display groups", () => {
  it("exposes exactly the four original categories", () => {
    expect(PROBE_CATEGORIES.map((category) => category.id)).toEqual([
      "identity",
      "submodel",
      "security",
      "integrity",
    ]);
  });

  it("routes channel/infra probes to Security Probes like the original page", () => {
    expect(getProbeDisplayGroup({ id: "infra_probe", group: "security" })).toBe("security");
    expect(getProbeDisplayGroup({ id: "bedrock_probe", group: "security" })).toBe("security");
    expect(getProbeDisplayGroup({ id: "channel_signature", group: "integrity" })).toBe("security");
  });

  it("folds quality/multimodal into Integrity and signature into Security", () => {
    expect(getProbeDisplayGroup({ id: "zh_reasoning", group: "quality" })).toBe("integrity");
    expect(getProbeDisplayGroup({ id: "multimodal_image", group: "integrity" })).toBe("integrity");
    expect(getProbeDisplayGroup({ id: "ac5_signature_verify", group: "signature" })).toBe("security");
    expect(getProbeDisplayGroup({ id: "sse_compliance", group: "integrity" })).toBe("integrity");
    expect(getProbeDisplayGroup({ id: "sub_probe", group: "submodel" })).toBe("submodel");
    expect(getProbeDisplayGroup({ id: "ling_kr_num", group: "identity" })).toBe("identity");
  });

  it("maps the full 97-probe engine catalog into the four sections", () => {
    const makeProbes = (group, count) => Array.from(
      { length: count },
      (_, index) => ({ id: `${group}_${index}`, group })
    );
    const engineCatalog = [
      ...makeProbes("quality", 10),
      ...makeProbes("security", 16),
      { id: "infra_probe", group: "security" },
      { id: "bedrock_probe", group: "security" },
      { id: "channel_signature", group: "security" },
      ...makeProbes("integrity", 10),
      { id: "multimodal_image", group: "integrity" },
      { id: "multimodal_pdf", group: "integrity" },
      ...makeProbes("identity", 26),
      { id: "ac5_signature_verify", group: "signature" },
      ...makeProbes("submodel", 29),
    ];
    const counts = Object.fromEntries(PROBE_CATEGORIES.map((category) => [category.id, 0]));

    for (const probe of engineCatalog) {
      counts[getProbeDisplayGroup(probe)] += 1;
    }

    expect(new Set(engineCatalog.map((probe) => probe.id)).size).toBe(97);
    expect(counts).toEqual({
      identity: 26,
      submodel: 29,
      security: 20,
      integrity: 22,
    });
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(97);
  });

  it("keeps fallback probes inside known display categories", () => {
    const knownGroups = new Set(PROBE_CATEGORIES.map((category) => category.id));
    expect(DEFAULT_PROBES.every((probe) => knownGroups.has(getProbeDisplayGroup(probe)))).toBe(true);
  });
});
