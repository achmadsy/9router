import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), gate: null }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("../../src/lib/zcode/captcha-service.js", () => ({ getCaptchaManager: () => ({}), getZcodeCaptchaPort: () => 0 }));
vi.mock("../../src/lib/zcode/planRequests.js", async (original) => {
  const actual = await original();
  return { ...actual, planRequestCoordinator: {
    run: (...args) => mocks.gate.run(...args), cooldown: () => mocks.gate.cooldown(),
    assertReady: () => mocks.gate.assertReady(), observeResponse: (...args) => mocks.gate.observeResponse(...args),
  } };
});
const { createPlanRequestCoordinator } = await import("../../src/lib/zcode/planRequests.js");
const { getZcodeBalance, invalidateZcodeBalance, balanceKey, _clearZcodeBalancesForTests } = await import("../../src/lib/zcode/balances.js");
const { _clearPlanInspectionCacheForTests } = await import("../../src/lib/zcode/planInspections.js");
const { getGlmUsage } = await import("../../open-sse/services/usage/glm.js");
const { inspectZaiPlans, invalidateZaiPlanInspection } = await import("../../src/lib/zcode/plans.js");
const { aggregateProviderQuotas, parseQuotaData } = await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js");
const jwt = "test-login-jwt";
const scope = "glm:one";
const proxy = { proxyPoolId: "one", connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test", connectionNoProxy: "", strictProxy: true };
const data = (remaining = 5_000_000) => ({
  plans: [{ plan_id: "zcode-v3-start-plan-0817", status: "active" }],
  balances: [{ show_name: "GLM-5.3-Flash", total_units: 5_000_000, used_units: 5_000_000 - remaining, remaining_units: remaining }],
});
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
beforeEach(() => {
  mocks.gate = createPlanRequestCoordinator({ intervalMs: 0 });
  _clearZcodeBalancesForTests();
  _clearPlanInspectionCacheForTests();
  mocks.fetch.mockReset().mockImplementation(async (url) => response({ code: 0, data: url.includes("/balance") ? data() : url.includes("/preview") ? {} : { deliveries: [] } }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const quota = (force = false) => getGlmUsage(null, "glm", proxy, { zcodeJwtToken: jwt }, { force, accountScope: scope });
const plans = () => inspectZaiPlans(jwt, proxy, undefined, { includeCampaigns: true, coordinator: mocks.gate, cacheScope: scope });
const balanceCalls = () => mocks.fetch.mock.calls.filter(([url]) => url.includes("/balance"));

describe("shared ZCode balance snapshots", () => {
  it.each(["quota-first", "plans-first"])("shares a single balance across screens (%s)", async (order) => {
    if (order === "quota-first") { await quota(); await plans(); await quota(); }
    else { await plans(); await quota(); await plans(); }
    expect(balanceCalls()).toHaveLength(1);
    expect((await plans()).balances[0].remaining).toBe(5_000_000);
    expect((await quota()).quotas["Start: GLM-5.3-Flash"].remaining).toBe(5_000_000);
    expect(balanceCalls()[0][2]).toBe(proxy);
  });

  it("a forced quota refresh updates Plan Management even while discovery is cached", async () => {
    await plans();
    mocks.fetch.mockImplementation(async (url) => response({ code: 0, data: url.includes("/balance") ? data(4_000_000) : { deliveries: [] } }));
    await quota(true);
    const inspected = await plans();
    expect(inspected.balances[0].remaining).toBe(4_000_000);
    expect(balanceCalls()).toHaveLength(2);
    expect(mocks.fetch.mock.calls.filter(([url]) => url.includes("/preview"))).toHaveLength(1);
  });

  it("overlapping forced checks deduplicate and clone their results", async () => {
    let resolve;
    mocks.fetch.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const a = getZcodeBalance(jwt, proxy, undefined, { force: true, accountScope: scope });
    const b = getZcodeBalance(jwt, proxy, undefined, { force: true, accountScope: scope });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    resolve(response({ code: 0, data: data() }));
    const [first, second] = await Promise.all([a, b]);
    first.data.balances[0].remaining_units = 0;
    expect(second.data.balances[0].remaining_units).toBe(5_000_000);
    expect(balanceCalls()).toHaveLength(1);
  });

  it("expires at 60 seconds from fetch time rather than page access", async () => {
    vi.useFakeTimers();
    await quota();
    await vi.advanceTimersByTimeAsync(40_000);
    await plans();
    await vi.advanceTimersByTimeAsync(21_000);
    await quota();
    expect(balanceCalls()).toHaveLength(2);
  });

  it("retains stale successful balances after 429 without allowing a forced bypass", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await quota();
    mocks.fetch.mockResolvedValue(new Response("wait", { status: 429, headers: { "Retry-After": "120" } }));
    const stale = await quota(true);
    expect(stale.quotas["Start: GLM-5.3-Flash"].total).toBe(5_000_000);
    expect(stale.balance).toMatchObject({ stale: true, httpStatus: 429 });
    expect(stale.warnings[0]).toContain("cooldown");
    await quota(true);
    await expect(getZcodeBalance(jwt, proxy, undefined, { accountScope: scope, force: true, allowStale: false }))
      .rejects.toMatchObject({ httpStatus: 429 });
    expect(balanceCalls()).toHaveLength(2);
  });

  it("stops checks for other accounts after 429 and reports unknown instead of zero", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.fetch.mockResolvedValue(new Response("wait", { status: 429 }));
    const settled = await Promise.allSettled(Array.from({ length: 26 }, (_, i) => getZcodeBalance(`jwt-${i}`, proxy, undefined, { accountScope: `glm:${i}` })));
    expect(settled.every((item) => item.status === "rejected" && item.reason.httpStatus === 429)).toBe(true);
    expect(balanceCalls()).toHaveLength(1);
  });

  it("invalidates both screen caches after mutation and shares the new snapshot", async () => {
    await plans();
    invalidateZaiPlanInspection(jwt, proxy, scope);
    mocks.fetch.mockImplementation(async (url) => response({ code: 0, data: url.includes("/balance") ? data(3_000_000) : url.includes("/preview") ? {} : { deliveries: [] } }));
    await quota();
    expect((await plans()).balances[0].remaining).toBe(3_000_000);
    expect(balanceCalls()).toHaveLength(2);
  });

  it("never serves stale balances after authentication rejection", async () => {
    await quota();
    mocks.fetch.mockResolvedValue(response({ code: 401 }, 401));
    await expect(getZcodeBalance(jwt, proxy, undefined, { accountScope: scope, force: true })).rejects.toMatchObject({ httpStatus: 401 });
    await expect(getZcodeBalance(jwt, proxy, undefined, { accountScope: scope })).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("does not conceal failed Start Plan checks when Coding Plan succeeds", async () => {
    mocks.fetch.mockImplementation(async (url) => url.includes("/balance") ? response({}, 500)
      : response({ code: 200, data: { level: "lite", limits: [{ type: "TOKENS_LIMIT", percentage: 10 }] } }));
    const usage = await getGlmUsage("api-key", "glm", proxy, { zcodeJwtToken: jwt }, { accountScope: scope });
    expect(usage.quotas.Tokens).toBeTruthy();
    expect(usage.warnings[0]).toContain("balance unavailable");
    expect(usage.balance.status).toBe("unavailable");
  });

  it("paces 26 distinct accounts without overflowing the shared queue", async () => {
    vi.useFakeTimers();
    const gate = createPlanRequestCoordinator({ intervalMs: 500 });
    const dispatched = [];
    mocks.fetch.mockImplementation(async () => { dispatched.push(Date.now()); return response({ code: 0, data: data() }); });
    const requests = Promise.all(Array.from({ length: 26 }, (_, i) => getZcodeBalance(`paced-${i}`, proxy, undefined, { accountScope: `glm:${i}`, coordinator: gate })));
    await vi.runAllTimersAsync();
    expect(await requests).toHaveLength(26);
    expect(dispatched).toHaveLength(26);
    expect(dispatched.every((time, i) => i === 0 || time - dispatched[i - 1] >= 500)).toBe(true);
  });

  it("does not retain secret fields from an upstream envelope", async () => {
    mocks.fetch.mockResolvedValue(response({ code: 0, token: "secret-canary", data: { ...data(), token: "secret-canary" } }));
    const snapshot = await getZcodeBalance(jwt, proxy);
    expect(JSON.stringify(snapshot)).not.toContain("secret-canary");
  });

  it("invalidation prevents an old in-flight result from repopulating the shared cache", async () => {
    let release;
    mocks.fetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = getZcodeBalance(jwt, proxy);
    const rejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    invalidateZcodeBalance(jwt, proxy);
    const second = getZcodeBalance(jwt, proxy);
    release(response({ code: 0, data: data(1) }));
    await rejection;
    expect((await second).data.balances[0].remaining_units).toBe(5_000_000);
    expect((await getZcodeBalance(jwt, proxy)).data.balances[0].remaining_units).toBe(5_000_000);
  });

  it("isolates account and proxy contexts without raw secrets in keys", () => {
    const key = balanceKey(jwt, proxy, scope);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(balanceKey(jwt, proxy, "glm:two")).not.toBe(key);
    expect(balanceKey(jwt, { ...proxy, strictProxy: false }, scope)).not.toBe(key);
    expect(balanceKey("new-jwt", proxy, scope)).not.toBe(key);
  });

  it("aggregates 26 independent 5M grants to 130M without deduplication", async () => {
    const connections = Array.from({ length: 26 }, (_, i) => ({ id: String(i), provider: "glm", isActive: true }));
    const snapshots = {};
    for (const connection of connections) {
      const usage = await getGlmUsage(null, "glm", proxy, { zcodeJwtToken: `jwt-${connection.id}` }, { accountScope: `glm:${connection.id}` });
      snapshots[connection.id] = { quotas: parseQuotaData("glm", usage) };
    }
    expect(aggregateProviderQuotas(connections, snapshots).quotas[0]).toMatchObject({ total: 130_000_000, accountCount: 26 });
    expect(balanceCalls()).toHaveLength(26);
  });

  it("reports partial contributors even when they have other successful quotas", () => {
    const connections = [{ id: "one", provider: "glm" }, { id: "two", provider: "glm" }];
    const result = aggregateProviderQuotas(connections, {
      one: { quotas: [{ name: "Start: Flash", total: 5_000_000, used: 0 }] },
      two: { quotas: [{ name: "Tokens", total: 100, used: 0 }], warnings: ["Start balance unavailable"] },
    });
    expect(result.partialConnections).toHaveLength(1);
    expect(result.quotas.find((row) => row.name === "Start: Flash").accountCount).toBe(1);
  });

  it("an aborted subscriber does not cancel another screen's shared request", async () => {
    const controller = new AbortController();
    let release;
    let sharedSignal;
    mocks.fetch.mockImplementation((_url, options) => { sharedSignal = options.signal; return new Promise((resolve) => { release = resolve; }); });
    const first = getZcodeBalance(jwt, proxy, undefined, { accountScope: scope, signal: controller.signal });
    const second = getZcodeBalance(jwt, proxy, undefined, { accountScope: scope });
    const rejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    controller.abort();
    await rejection;
    expect(sharedSignal.aborted).toBe(false);
    release(response({ code: 0, data: data() }));
    expect((await second).stale).toBe(false);
  });
});
