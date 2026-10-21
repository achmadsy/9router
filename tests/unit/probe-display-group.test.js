import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROBES,
  ORIGINAL_SUITE_GROUPS,
  ORIGINAL_SUITE_IDS,
  PROBE_CATEGORIES,
  getProbeDisplayGroup,
} from "../../src/app/(dashboard)/dashboard/probe/components/probeConstants.js";

// The report mirrors the original BazaarLink page: exact membership and order.
describe("Probe display groups", () => {
  it("exposes exactly the four original categories", () => {
    expect(PROBE_CATEGORIES.map((category) => category.id)).toEqual([
      "identity",
      "submodel",
      "security",
      "integrity",
    ]);
  });

  it("contains the exact original 86 probes with 29/29/16/12 counts", () => {
    expect(ORIGINAL_SUITE_IDS).toHaveLength(86);
    expect(new Set(ORIGINAL_SUITE_IDS).size).toBe(86);
    expect(ORIGINAL_SUITE_GROUPS.identity).toHaveLength(29);
    expect(ORIGINAL_SUITE_GROUPS.submodel).toHaveLength(29);
    expect(ORIGINAL_SUITE_GROUPS.security).toHaveLength(16);
    expect(ORIGINAL_SUITE_GROUPS.integrity).toHaveLength(12);

    const counts = Object.fromEntries(PROBE_CATEGORIES.map((category) => [category.id, 0]));
    for (const probe of DEFAULT_PROBES) counts[getProbeDisplayGroup(probe)] += 1;
    expect(counts).toEqual({ identity: 29, submodel: 29, security: 16, integrity: 12 });
  });

  it("keeps production exceptions in their explicit sections", () => {
    expect(getProbeDisplayGroup({ id: "bedrock_probe", group: "security" })).toBe("security");
    expect(getProbeDisplayGroup({ id: "channel_signature", group: "integrity" })).toBe("security");
    expect(getProbeDisplayGroup({ id: "zh_creator_plain", group: "identity" })).toBe("identity");
    expect(getProbeDisplayGroup({ id: "multimodal_image", group: "multimodal" })).toBe("integrity");
  });

  it("does not assign excluded or unknown probes to a public report section", () => {
    for (const id of [
      "zh_reasoning",
      "infra_probe",
      "identity_leak",
      "pip_index_url_injection",
      "ac5_signature_verify",
      "unknown_probe",
    ]) {
      expect(getProbeDisplayGroup({ id, group: "integrity" })).toBeNull();
    }
  });

  it("uses the exact original suite as the offline fallback", () => {
    expect(DEFAULT_PROBES.map((probe) => probe.id)).toEqual(ORIGINAL_SUITE_IDS);
  });
});
