import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => new Response(JSON.stringify(body), { status: init?.status || 200 }) },
}));
vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(), generateAuthData: vi.fn(), requestDeviceCode: vi.fn(), pollForToken: vi.fn(),
  exchangeTokens: vi.fn(async () => ({
    accessToken: "fake-new-token", refreshToken: "fake-refresh", email: "same@example.test",
    providerSpecificData: { chatgptAccountId: "workspace-test", chatgptPlanType: "plus" },
  })),
}));
vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));

const oldDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-codex-clone-"));
process.env.DATA_DIR = tempDir;
vi.resetModules();
const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
const { createProviderNode, createProviderConnection, getProviderConnections, getProviderConnectionById } = await import("@/models");

afterAll(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  if (oldDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = oldDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Codex duplicate OAuth SQLite isolation", () => {
  it("persists duplicate login without overwriting same-email original account", async () => {
    const node = await createProviderNode({ id: "codex-clone-sqlite-test", type: "provider-clone", baseProvider: "codex", prefix: "codex-2", name: "Codex 2" });
    const original = await createProviderConnection({
      provider: "codex", authType: "oauth", email: "same@example.test", accessToken: "fake-original-token",
      providerSpecificData: { chatgptAccountId: "workspace-test" },
    });
    const res = await POST(new Request(`http://localhost/api/oauth/codex/exchange?as=${node.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "fake-code", codeVerifier: "fake-verifier", redirectUri: "http://localhost:1455/auth/callback", state: "test-state" }),
    }), { params: Promise.resolve({ provider: "codex", action: "exchange" }) });
    expect(res.status).toBe(200);
    expect(await getProviderConnectionById(original.id)).toEqual(original);
    expect(await getProviderConnections({ provider: "codex" })).toHaveLength(1);
    const duplicates = await getProviderConnections({ provider: node.id });
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({
      provider: node.id, accessToken: "fake-new-token",
      providerSpecificData: { baseProvider: "codex", prefix: "codex-2", chatgptAccountId: "workspace-test", chatgptPlanType: "plus" },
    });
    expect(duplicates[0].id).not.toBe(original.id);
  });
});
