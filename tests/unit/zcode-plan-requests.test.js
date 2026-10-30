import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as zcodeHeaders from "../../src/lib/zcode/headers.js";
import { createPlanRequestCoordinator } from "../../src/lib/zcode/planRequests.js";
import { _clearPlanInspectionCacheForTests, cachedPlanInspection, invalidatePlanInspection, planInspectionKey } from "../../src/lib/zcode/planInspections.js";

beforeEach(() => _clearPlanInspectionCacheForTests());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function blockedResponse(retryAfter, status = 429) {
  return new Response("<html>upstream wait</html>", {
    status, headers: retryAfter == null ? {} : { "Retry-After": retryAfter },
  });
}

describe("Plan Management request gate", () => {
  it.each([
    ["90", 90_000],
    ["Sat, 31 Oct 2026 00:02:00 GMT", 120_000],
    [null, 60_000],
    ["invalid", 60_000],
    ["0", 500],
    ["3456000", 3_456_000_000],
  ])("honors Retry-After %s without parsing an error body", (header, duration) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = Date.parse("2026-10-31T00:00:00Z");
    const gate = createPlanRequestCoordinator({ now: () => now });
    expect(() => gate.observeResponse(blockedResponse(header), "https://zcode.z.ai/api/v1/marketing/touch"))
      .toThrow("Plan status unavailable");
    expect(gate.cooldown()).toBe(now + duration);
  });

  it("serializes and spaces requests without retrying them", async () => {
    vi.useFakeTimers();
    const gate = createPlanRequestCoordinator({ intervalMs: 500 });
    const times = [];
    const request = () => { times.push(Date.now()); return times.length; };
    const first = gate.run(request);
    const second = gate.run(request);
    const third = gate.run(request);
    await vi.runAllTimersAsync();
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(times[1] - times[0]).toBe(500);
    expect(times[2] - times[1]).toBe(500);
  });

  it("rejects every queued and new call after a 429 until cooldown ends", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const gate = createPlanRequestCoordinator();
    const fetch = vi.fn(() => gate.observeResponse(blockedResponse("120"), "https://zcode.z.ai/api/v1/marketing/touch"));
    const settled = Promise.allSettled([gate.run(fetch), gate.run(fetch), gate.run(fetch)]);
    await vi.runAllTimersAsync();
    expect((await settled).every((entry) => entry.status === "rejected" && entry.reason.httpStatus === 429)).toBe(true);
    await expect(gate.run(fetch)).rejects.toMatchObject({ httpStatus: 429, requestStarted: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(gate.run(() => "resumed")).resolves.toBe("resumed");
  });

  it("bounds the queue and removes an aborted queued check", async () => {
    const gate = createPlanRequestCoordinator({ intervalMs: 0, maxQueueSize: 1 });
    let release;
    const first = gate.run(() => new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const second = gate.run(() => "must not run", { signal: controller.signal });
    const rejection = expect(second).rejects.toMatchObject({ name: "AbortError" });
    await expect(gate.run(() => "overflow")).rejects.toThrow("queue is busy");
    controller.abort();
    await rejection;
    release("finished");
    await expect(first).resolves.toBe("finished");
  });
});

describe("account-scoped plan inspection reuse", () => {
  it("deduplicates overlapping refreshes and returns independent cached objects", async () => {
    let resolve;
    const loader = vi.fn(() => new Promise((done) => { resolve = done; }));
    const first = cachedPlanInspection("account-one", loader);
    const second = cachedPlanInspection("account-one", loader);
    await Promise.resolve();
    resolve({ inspectionStatus: "complete", offers: [{ planId: "event" }] });
    const [a, b] = await Promise.all([first, second]);
    a.offers[0].planId = "changed";
    expect(b.offers[0].planId).toBe("event");
    const cached = await cachedPlanInspection("account-one", loader);
    expect(cached).toMatchObject({ cached: true, offers: [{ planId: "event" }] });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("keys account, JWT, strict proxy settings and endpoint context separately", () => {
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://user:proxy-password@proxy.test", strictProxy: true };
    const key = planInspectionKey("private-jwt", proxy, "glm:one");
    expect(planInspectionKey("private-jwt", proxy, "glm:two")).not.toBe(key);
    expect(planInspectionKey("new-jwt", proxy, "glm:one")).not.toBe(key);
    expect(planInspectionKey("private-jwt", { ...proxy, strictProxy: false }, "glm:one")).not.toBe(key);
    expect(planInspectionKey("private-jwt", { ...proxy, connectionProxyUrl: "http://other.test" }, "glm:one")).not.toBe(key);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toMatch(/private-jwt|proxy-password/);
  });

  it("separates inspections when the persisted device context changes", () => {
    const readDevice = vi.spyOn(zcodeHeaders, "readZcodeDeviceMid");
    readDevice.mockReturnValue("device-one");
    const before = planInspectionKey("jwt", null, "glm:one");
    readDevice.mockReturnValue("device-two");
    expect(planInspectionKey("jwt", null, "glm:one")).not.toBe(before);
  });

  it("initializes the cache context when no device is readable without changing an existing device", () => {
    const readDevice = vi.spyOn(zcodeHeaders, "readZcodeDeviceMid").mockReturnValue(undefined);
    const ensureDevice = vi.spyOn(zcodeHeaders, "ensureZcodeDeviceMid").mockReturnValue("fallback-device");
    const first = planInspectionKey("jwt", null, "glm:one");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(ensureDevice).toHaveBeenCalledTimes(1);
    readDevice.mockReturnValue("fallback-device");
    expect(planInspectionKey("jwt", null, "glm:one")).toBe(first);
    expect(ensureDevice).toHaveBeenCalledTimes(1);
  });

  it("does not cache an interrupted inspection and lets reopening start a new check", async () => {
    const controller = new AbortController();
    let abortFirst;
    const loader = vi.fn((signal) => new Promise((resolve, reject) => {
      abortFirst = () => reject(new DOMException("cancelled", "AbortError"));
      signal.addEventListener("abort", abortFirst);
    }));
    const first = cachedPlanInspection("one", loader, controller.signal);
    await Promise.resolve();
    const rejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    const reopened = cachedPlanInspection("one", async () => ({ inspectionStatus: "complete", offers: [] }));
    await rejection;
    await expect(reopened).resolves.toMatchObject({ inspectionStatus: "complete", cached: false });
  });

  it("does not launch an inspection cancelled before its loader starts", async () => {
    const controller = new AbortController();
    const loader = vi.fn(async () => ({ inspectionStatus: "complete" }));
    const request = cachedPlanInspection("one", loader, controller.signal);
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(loader).not.toHaveBeenCalled();
  });

  it("expires partial results sooner instead of indefinitely caching a cooldown error", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => ({ inspectionStatus: "partial", error: "upstream unavailable" }));
    await cachedPlanInspection("one", loader);
    expect((await cachedPlanInspection("one", loader)).cached).toBe(true);
    await vi.advanceTimersByTimeAsync(10_001);
    await cachedPlanInspection("one", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("expires complete results and invalidates inspections after a mutation", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => ({ inspectionStatus: "complete" }));
    await cachedPlanInspection("one", loader);
    await vi.advanceTimersByTimeAsync(60_001);
    await cachedPlanInspection("one", loader);
    invalidatePlanInspection("one");
    await cachedPlanInspection("one", loader);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("aborting one reader does not cancel another reader's shared inspection", async () => {
    let resolve;
    let sharedSignal;
    const loader = (signal) => { sharedSignal = signal; return new Promise((done) => { resolve = done; }); };
    const controller = new AbortController();
    const first = cachedPlanInspection("one", loader, controller.signal);
    const second = cachedPlanInspection("one", loader);
    await Promise.resolve();
    const rejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(sharedSignal.aborted).toBe(false);
    resolve({ inspectionStatus: "complete" });
    await expect(second).resolves.toMatchObject({ inspectionStatus: "complete" });
  });

  it("cancels shared work when the last reader leaves", async () => {
    const controller = new AbortController();
    let sharedSignal;
    const loader = (signal) => {
      sharedSignal = signal;
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError"))));
    };
    const request = cachedPlanInspection("one", loader, controller.signal);
    await Promise.resolve();
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(sharedSignal.aborted).toBe(true);
  });

  it("keeps original-plan preparation available without calling an unknown balance inactive", () => {
    const source = readFileSync(new URL("../../src/app/(dashboard)/dashboard/providers/[id]/ZaiPlanManagementModal.js", import.meta.url), "utf8");
    expect(source).toContain("account.originalStartPlanActive === false");
    expect(source).toContain("account.originalStartPlanActive !== true");
    expect(source).toContain("You can still run preparation.");
    expect(source).toContain('account.inspectionStatus === "complete"');
    expect(source).toContain("loadController.current?.abort()");
    expect(source).toContain("cooldown (HTTP 429)");
  });
});
