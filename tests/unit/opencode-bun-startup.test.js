import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";

const source = readFileSync(new URL("../../custom-server.js", import.meta.url), "utf8");
function boot({ env = {}, bun = true, helper = true } = {}) {
  const process = Object.assign(new EventEmitter(), { env: { ...env }, argv: ["node", "custom-server.js"] });
  const timers = [];
  const child = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn() });
  const spawn = vi.fn(() => child);
  let snapshotAtNext;
  let server;
  const http = { createServer: () => {
    server = Object.assign(new EventEmitter(), { emit: EventEmitter.prototype.emit });
    return server;
  } };
  const main = {};
  const require = (name) => {
    if (name === "http") return http;
    if (name === "path") return path;
    if (name === "fs") return { existsSync: (p) => p.endsWith("opencodeBunTransport.js") ? helper : p.endsWith("/bun") ? bun : p.endsWith("server.js") };
    if (name === "crypto") return crypto;
    if (name === "url") return { pathToFileURL: () => { throw new Error("unexpected background import"); } };
    if (name === "async_hooks") return { AsyncLocalStorage: class { run(_, fn) { return fn(); } } };
    if (name === "child_process") return { spawn };
    if (name === "./inference-access-log.cjs") return { purgeExpiredSafely() {}, flushPending() {} };
    if (name === "/app/server.js") {
      snapshotAtNext = { ...process.env };
      http.createServer(() => {});
      return {};
    }
    throw new Error(`Unexpected require ${name}`);
  };
  require.main = main;
  vm.runInNewContext(source, {
    require, module: main, __dirname: "/app", process, Buffer, URL,
    globalThis: { __9router_request_als: {} },
    console: { log() {}, warn() {}, error: vi.fn() },
    setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
    clearTimeout() {}, clearInterval() {}, setInterval: () => ({ unref() {} }),
  });
  return { env: process.env, snapshotAtNext, server, child, spawn, timers };
}

describe("OpenCode Bun startup eligibility", () => {
  it("configures the managed helper before Next imports, not after a health check", () => {
    const result = boot();
    expect(result.snapshotAtNext.OPENCODE_BUN_TRANSPORT_MODE).toBe("managed");
    expect(result.snapshotAtNext.OPENCODE_BUN_TRANSPORT_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshotAtNext.OPENCODE_BUN_TRANSPORT_URL).toBe("http://127.0.0.1:20131/fetch");
    expect(result.spawn).not.toHaveBeenCalled();
  });
  it.each([{ bun: false }, { helper: false }])("keeps wreq when managed files are missing: %j", (options) => {
    expect(boot(options).snapshotAtNext.OPENCODE_BUN_TRANSPORT_MODE).toBe("unavailable");
  });
  it("honors disable even if token and helper URL are supplied", () => {
    const result = boot({ env: { OPENCODE_BUN_TRANSPORT_DISABLED: "1", OPENCODE_BUN_TRANSPORT_TOKEN: "operator", OPENCODE_BUN_TRANSPORT_URL: "http://127.0.0.1:29999/fetch" } });
    expect(result.snapshotAtNext.OPENCODE_BUN_TRANSPORT_MODE).toBe("disabled");
  });
  it("keeps explicit loopback helper configuration when Bun is not installed", () => {
    const result = boot({ bun: false, env: { OPENCODE_BUN_TRANSPORT_TOKEN: "operator", OPENCODE_BUN_TRANSPORT_URL: "http://127.0.0.1:29999/fetch" } });
    expect(result.snapshotAtNext.OPENCODE_BUN_TRANSPORT_MODE).toBe("external");
    expect(result.snapshotAtNext.OPENCODE_BUN_TRANSPORT_TOKEN).toBe("operator");
  });
  it("does not change transport eligibility after helper startup failure", () => {
    const result = boot();
    // Exercise only the supervisor portion of the listening callback; stop
    // before unrelated token refresh / access-log scheduling.
    const listeners = result.server.listeners("listening");
    expect(() => listeners[0]()).toThrow(/unexpected background import/);
    expect(result.spawn).toHaveBeenCalledOnce();
    result.child.emit("error", new Error("private spawn detail"));
    result.child.emit("close", -2, null);
    expect(result.env.OPENCODE_BUN_TRANSPORT_MODE).toBe("managed");
    expect(result.timers).toHaveLength(1);
  });
});
