import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROBES,
  PROBE_CATEGORIES,
  getProbeDisplayGroup,
} from "../../src/app/(dashboard)/dashboard/probe/components/probeConstants.js";

describe("Probe display groups", () => {
  it("matches BazaarLink display-only identity overrides", () => {
    expect(getProbeDisplayGroup({ id: "infra_probe", group: "security" })).toBe("identity");
    expect(getProbeDisplayGroup({ id: "bedrock_probe", group: "security" })).toBe("identity");
    expect(getProbeDisplayGroup({ id: "channel_signature", group: "integrity" })).toBe("identity");
  });

  it("preserves all other engine groups", () => {
    expect(getProbeDisplayGroup({ id: "quality_probe", group: "quality" })).toBe("quality");
    expect(getProbeDisplayGroup({ id: "sub_probe", group: "submodel" })).toBe("submodel");
  });

  it("keeps fallback probes inside known display categories", () => {
    const knownGroups = new Set(PROBE_CATEGORIES.map((category) => category.id));
    expect(DEFAULT_PROBES.every((probe) => knownGroups.has(getProbeDisplayGroup(probe)))).toBe(true);
  });
});
