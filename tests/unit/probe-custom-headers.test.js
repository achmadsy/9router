import { describe, expect, it } from "vitest";
import {
  MAX_PROBE_HEADERS,
  MAX_PROBE_HEADER_NAME_LENGTH,
  MAX_PROBE_HEADER_VALUE_LENGTH,
  MAX_PROBE_HEADERS_BYTES,
  normalizeProbeCustomHeaders,
} from "../../src/lib/probe/customHeaders.js";

describe("Probe custom headers", () => {
  it("accepts row lists and preserves valid User-Agent values", () => {
    expect(normalizeProbeCustomHeaders([
      { name: "User-Agent", value: "Custom Gateway Client/1.0" },
      { name: "X-Tenant", value: "acme" },
      { name: "", value: "" },
    ])).toEqual({
      "User-Agent": "Custom Gateway Client/1.0",
      "X-Tenant": "acme",
    });
  });

  it("accepts object maps", () => {
    expect(normalizeProbeCustomHeaders({ "X-Tenant": "acme" })).toEqual({
      "X-Tenant": "acme",
    });
  });

  it.each([
    ["bad header", "invalid token name"],
    ["X:Header", "invalid punctuation"],
    ["X-Value", "line\nbreak"],
    ["X-Value", "carriage\rreturn"],
    ["X-Value", "tab\tvalue"],
    ["X-Value", `null\u0000value`],
    ["X-Value", `delete\u007Fvalue`],
    ["X-Value", `c1\u0085value`],
  ])("rejects %s with %s", (name, value) => {
    expect(() => normalizeProbeCustomHeaders([{ name, value }])).toThrow();
  });

  it.each([
    "Authorization",
    "Host",
    "Content-Length",
    "Content-Type",
    "Transfer-Encoding",
    "Connection",
    "Keep-Alive",
    "Trailer",
    "Upgrade",
    "TE",
    "Proxy-Authorization",
    "Proxy-Custom",
    "X-9R-CLI-Token",
    "X-Probe-Sidecar-Token",
  ])("blocks protected header %s", (name) => {
    expect(() => normalizeProbeCustomHeaders({ [name]: "unsafe" })).toThrow(/not allowed/);
  });

  it("rejects duplicate names case-insensitively", () => {
    expect(() => normalizeProbeCustomHeaders([
      { name: "X-Tenant", value: "one" },
      { name: "x-tenant", value: "two" },
    ])).toThrow(/Duplicate/);
  });

  it("enforces header count, name, value, and aggregate limits", () => {
    const tooMany = Array.from({ length: MAX_PROBE_HEADERS + 1 }, (_, index) => ({
      name: `X-${index}`,
      value: "value",
    }));
    expect(() => normalizeProbeCustomHeaders(tooMany)).toThrow(/cannot exceed 16 entries/);
    expect(() => normalizeProbeCustomHeaders({
      [`X-${"a".repeat(MAX_PROBE_HEADER_NAME_LENGTH)}`]: "value",
    })).toThrow(/Invalid additional header name/);
    expect(() => normalizeProbeCustomHeaders({
      "X-Large": "a".repeat(MAX_PROBE_HEADER_VALUE_LENGTH + 1),
    })).toThrow(/value is too long/);

    const aggregate = {};
    for (let index = 0; index < MAX_PROBE_HEADERS; index += 1) {
      aggregate[`X-Large-${index}`] = "a".repeat(Math.ceil(MAX_PROBE_HEADERS_BYTES / MAX_PROBE_HEADERS));
    }
    expect(() => normalizeProbeCustomHeaders(aggregate)).toThrow(/cannot exceed 8192 bytes/);
  });

  it("rejects incomplete rows and unsupported containers", () => {
    expect(() => normalizeProbeCustomHeaders([{ name: "X-Tenant", value: undefined }])).toThrow(/requires a name and value/);
    expect(() => normalizeProbeCustomHeaders("X-Tenant: acme")).toThrow(/object or list/);
  });
});
