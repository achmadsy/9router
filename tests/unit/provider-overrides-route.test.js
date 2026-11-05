import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildZcodeCodingPlanDefaultHeaders } from "../../src/lib/zcode/headers.js";
import { diffProviderHeaderRows, mergeProviderHeaders } from "../../open-sse/utils/providerHeaderOverrides.js";

const mocks = vi.hoisted(() => ({ settings: {}, update: vi.fn() }));
vi.mock("@/lib/db/index.js", () => ({
  getSettings: async () => structuredClone(mocks.settings),
  updateSettings: async (patch) => { mocks.update(patch); Object.assign(mocks.settings, structuredClone(patch)); },
}));
const { GET, PUT } = await import("../../src/app/api/providers/[id]/overrides/route.js");
const context = (id = "glm") => ({ params: Promise.resolve({ id }) });
const request = (body) => new Request("http://localhost/api/providers/glm/overrides", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = async (id = "glm") => (await GET(new Request("http://localhost/api/providers/glm/overrides"), context(id))).json();

beforeEach(() => {
  mocks.settings = { providerOverrides: {} };
  mocks.update.mockReset();
});

describe("provider overrides API", () => {
  it("returns actual ZCode defaults, not generic Claude flags or dynamic/auth values", async () => {
    const data = await get();
    expect(data.builtinHeaders).toEqual(buildZcodeCodingPlanDefaultHeaders());
    expect(data.builtinHeaders["anthropic-beta"]).toBe("mid-conversation-system-2026-04-07");
    expect(data.builtinHeaders["User-Agent"]).toBe("ZCode/3.17.2 ai-sdk/provider-utils/4.0.27 runtime/node.js/24");
    expect(data.defaultProfile).toBe("zcode-account-plan");
    expect(Object.keys(data.builtinHeaders).some((name) => /authorization|api-key|device-mid|session-id|request-id|trace-id|query-id|captcha/i.test(name))).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("roundtrips Delete + Save + Refresh, then clears the deletion on Reset + Save", async () => {
    const initial = await get();
    const rows = Object.entries(initial.builtinHeaders).filter(([name]) => name !== "anthropic-beta").map(([name, value]) => ({ name, value }));
    const { override } = diffProviderHeaderRows(initial.builtinHeaders, rows);
    expect((await PUT(request(override), context())).status).toBe(200);
    const reloaded = await get();
    expect(reloaded.headers).toEqual({ "anthropic-beta": null });
    expect(mergeProviderHeaders(reloaded.builtinHeaders, reloaded.headers)["anthropic-beta"]).toBeUndefined();
    expect((await PUT(request({ headers: {} }), context())).status).toBe(200);
    const reset = await get();
    expect(reset.headers).toEqual({});
    expect(mergeProviderHeaders(reset.builtinHeaders, reset.headers)["anthropic-beta"]).toBe("mid-conversation-system-2026-04-07");
  });

  it("keeps clone edits isolated while inheriting the same ZCode defaults", async () => {
    mocks.settings.providerOverrides.glm = { headers: { "User-Agent": "base-custom" } };
    const response = await PUT(request({ headers: { "anthropic-beta": null } }), context("glm-clone-fixture"));
    expect(response.status).toBe(200);
    expect((await get("glm-clone-fixture")).builtinHeaders).toEqual(buildZcodeCodingPlanDefaultHeaders());
    expect((await get("glm-clone-fixture")).headers).toEqual({ "anthropic-beta": null });
    expect((await get()).headers).toEqual({ "User-Agent": "base-custom" });
  });

  it.each(["Authorization", "X-Api-Key", "cookie", "host"])("rejects null deletion of protected %s before any write", async (name) => {
    const response = await PUT(request({ headers: { [name]: null } }), context());
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects duplicate case and malformed JSON without clearing saved settings", async () => {
    mocks.settings.providerOverrides.glm = { headers: { "User-Agent": "keep-me" } };
    expect((await PUT(request({ headers: { "User-Agent": "one", "user-agent": "two" } }), context())).status).toBe(400);
    const malformed = new Request("http://localhost/api/providers/glm/overrides", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{" });
    expect((await PUT(malformed, context())).status).toBe(400);
    expect((await get()).headers).toEqual({ "User-Agent": "keep-me" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
