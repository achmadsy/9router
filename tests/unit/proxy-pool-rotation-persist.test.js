// Round-robin proxy-pool cursor must survive module reload (process restart).
// Cursor lives in SQLite kv scope `proxyPoolRotation`; RAM is only a cache.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const poolIds = ["pool-a", "pool-b", "pool-c"];
let PROVIDER = "proxy-rot";

let dataDir;
let pickCounter = 0;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "proxy-rot-"));
  process.env.DATA_DIR = dataDir;
  // Fresh DB adapter per test — global survives vi.resetModules otherwise.
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  PROVIDER = `proxy-rot-${++pickCounter}`;
});

afterEach(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.DATA_DIR;
});

async function loadModule() {
  // Fresh module graph = new RAM cache, same DATA_DIR file = "restart"
  vi.resetModules();
  return await import("@/lib/network/connectionProxy.js");
}

describe("proxy pool rotation cursor persistence", () => {
  it("resumes round-robin after module reload", async () => {
    const first = await loadModule();
    const a = await first.pickProxyPoolId(poolIds, "round-robin", PROVIDER);
    const b = await first.pickProxyPoolId(poolIds, "round-robin", PROVIDER);
    expect(a).toBe("pool-a");
    expect(b).toBe("pool-b");

    // Simulate restart: drop RAM, keep DATA_DIR
    const second = await loadModule();
    // Next pick should continue at pool-c, not restart at pool-a
    const c = await second.pickProxyPoolId(poolIds, "round-robin", PROVIDER);
    expect(c).toBe("pool-c");
    const a2 = await second.pickProxyPoolId(poolIds, "round-robin", PROVIDER);
    expect(a2).toBe("pool-a");
  });

  it("round-robin is independent per provider", async () => {
    const mod = await loadModule();
    await mod.pickProxyPoolId(poolIds, "round-robin", `${PROVIDER}-1`);
    await mod.pickProxyPoolId(poolIds, "round-robin", `${PROVIDER}-1`);
    const first = await mod.pickProxyPoolId(poolIds, "round-robin", `${PROVIDER}-2`);
    expect(first).toBe("pool-a");
  });

  it("clearProxyPoolRotationCache does not wipe persisted cursor", async () => {
    const mod = await loadModule();
    expect(await mod.pickProxyPoolId(poolIds, "round-robin", PROVIDER)).toBe("pool-a");
    expect(await mod.pickProxyPoolId(poolIds, "round-robin", PROVIDER)).toBe("pool-b");
    mod.clearProxyPoolRotationCache();
    // Reload hits kv only — should still be at pool-c
    const after = await loadModule();
    const next = await after.pickProxyPoolId(poolIds, "round-robin", PROVIDER);
    expect(next).toBe("pool-c");
  });
});
