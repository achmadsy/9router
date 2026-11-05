import { describe, expect, it } from "vitest";
import {
  applyProviderHeaderOverrides, diffProviderHeaderRows, mergeProviderHeaders,
  normalizeProviderHeaderOverride,
} from "../../open-sse/utils/providerHeaderOverrides.js";

const defaults = { "anthropic-version": "2023-06-01", "anthropic-beta": "native-beta", "User-Agent": "ZCode/current" };
const rowsOf = (headers) => Object.entries(headers).map(([name, value]) => ({ name, value }));

describe("provider Custom Headers diff and reload", () => {
  it("persists deletion across save, JSON storage, and refresh", () => {
    const rows = rowsOf(defaults).filter(({ name }) => name !== "anthropic-beta");
    const result = diffProviderHeaderRows(defaults, rows);
    expect(result).toEqual({ override: { headers: { "anthropic-beta": null } } });
    const stored = JSON.parse(JSON.stringify(result.override));
    const reloaded = mergeProviderHeaders(defaults, stored.headers);
    expect(reloaded).toEqual({ "anthropic-version": "2023-06-01", "User-Agent": "ZCode/current" });
    expect(diffProviderHeaderRows(defaults, rowsOf(reloaded))).toEqual(result);
  });

  it("deletes all defaults and restores them with Reset + Save", () => {
    const removed = diffProviderHeaderRows(defaults, []);
    expect(mergeProviderHeaders(defaults, removed.override.headers)).toEqual({});
    const reset = diffProviderHeaderRows(defaults, rowsOf(defaults));
    expect(reset).toEqual({ override: null });
    expect(mergeProviderHeaders(defaults, reset.override?.headers)).toEqual(defaults);
  });

  it("diffs names case-insensitively so unchanged defaults follow future updates", () => {
    const rows = rowsOf(defaults).map((row) => ({ ...row, name: row.name.toUpperCase() }));
    expect(diffProviderHeaderRows(defaults, rows)).toEqual({ override: null });
    const edited = diffProviderHeaderRows(defaults, [{ name: "Anthropic-Version", value: "custom-version" }, ...rowsOf(defaults).slice(1)]);
    expect(edited).toEqual({ override: { headers: { "Anthropic-Version": "custom-version" } } });
    expect(mergeProviderHeaders(defaults, edited.override.headers)).toEqual({ "anthropic-beta": "native-beta", "User-Agent": "ZCode/current", "Anthropic-Version": "custom-version" });
  });

  it("treats clearing a default value as a deletion and removing an added row as no override", () => {
    const rows = rowsOf(defaults).map((row) => row.name === "User-Agent" ? { ...row, value: "" } : row);
    expect(diffProviderHeaderRows(defaults, rows)).toEqual({ override: { headers: { "User-Agent": null } } });
    expect(diffProviderHeaderRows(defaults, rowsOf(defaults))).toEqual({ override: null });
  });

  it("allows more than twenty untouched defaults without freezing them as overrides", () => {
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`X-Default-${i}`, String(i)]));
    expect(diffProviderHeaderRows(many, rowsOf(many))).toEqual({ override: null });
  });

  it("replaces duplicate casing and does not serialize null as a wire value", () => {
    const headers = { "Anthropic-Beta": "stale", "anthropic-beta": "also-stale", Authorization: "Bearer fixture", "x-api-key": "fixture" };
    expect(applyProviderHeaderOverrides(headers, { "ANTHROPIC-BETA": null })).toBe(headers);
    const wire = new Headers(headers);
    expect(wire.has("anthropic-beta")).toBe(false);
    expect(wire.get("authorization")).toBe("Bearer fixture");
    expect(wire.get("x-api-key")).toBe("fixture");
  });
});

describe("provider Custom Headers validation", () => {
  it.each(["Authorization", "PROXY-Authorization", "X-API-Key", "x-goog-api-key", "api-key", "cookie", "Host", "content-length", "content-type", "connection", "transfer-encoding"])("rejects editing AND deleting protected %s", (name) => {
    for (const value of [null, "fixture"]) {
      expect(normalizeProviderHeaderOverride({ headers: { [name]: value } }).error).toContain("cannot be overridden");
    }
  });

  it.each([null, [], "wrong-shape", { headers: [] }, { headers: 1 }, { headers: { "Bad Name": null } }, { headers: { "X-Extra": "value\r\ninjected: yes" } }, { headers: { "X-Extra": "x".repeat(8193) } }, { headers: { "X-Extra": 1 } }, { headers: { "X-Extra": {} } }])("rejects malformed payload %j", (body) => {
    expect(normalizeProviderHeaderOverride(body).error).toBeTruthy();
  });

  it("rejects duplicate names case-insensitively in API and UI input", () => {
    expect(normalizeProviderHeaderOverride({ headers: { "User-Agent": "one", "user-agent": null } }).error).toContain("Duplicate");
    expect(diffProviderHeaderRows(defaults, [{ name: "User-Agent", value: "one" }, { name: "user-agent", value: "two" }]).error).toContain("Duplicate");
  });

  it("counts deletions toward the override limit", () => {
    const headers = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-Extra-${i}`, null]));
    expect(normalizeProviderHeaderOverride({ headers }).error).toContain("Too many");
  });

  it("retains legacy empty-string inheritance and supports empty-map reset", () => {
    expect(normalizeProviderHeaderOverride({ headers: { "User-Agent": "" } })).toEqual({ override: null });
    expect(normalizeProviderHeaderOverride({ headers: {} })).toEqual({ override: null });
  });
});
