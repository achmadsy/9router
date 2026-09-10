import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The settings store holds the "unknown" state that the dashboard's server-backed
// toggles are gated on, so it is security-relevant: if it can be made to hold a
// value the server did not report, a control can render a confident position for
// a state that was never read. These tests pin that contract.
//
// The store is plain zustand, so it runs in the default node environment with no
// DOM: `useSettingsStore.getState()` reads and `setState` resets.

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadStore() {
  const mod = await import("../../src/store/settingsStore.js");
  const store = mod.default;
  store.setState({
    settings: null,
    loading: false,
    error: null,
    lastFetched: 0,
    _readGeneration: 0,
  });
  return store;
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("settingsStore unknown state", () => {
  it("starts unknown (null), not with an empty settings object", async () => {
    const store = await loadStore();
    // An empty object would read as "all values false" to a boolean consumer;
    // null is what forces a caller to render nothing confident.
    expect(store.getState().settings).toBeNull();
  });

  it("leaves settings unknown when the read fails, and records the error", async () => {
    const store = await loadStore();
    fetchMock.mockResolvedValue(jsonResponse({ error: "nope" }, 500));

    const result = await store.getState().fetchSettings({ force: true });

    expect(result).toBeNull();
    expect(store.getState().settings).toBeNull();
    expect(store.getState().error).toMatch(/500/);
    expect(store.getState().loading).toBe(false);
  });

  it("discards a previously confirmed value on a later failed read instead of keeping it stale", async () => {
    const store = await loadStore();
    fetchMock.mockResolvedValueOnce(jsonResponse({ rtkEnabled: true }));
    await store.getState().fetchSettings({ force: true });
    expect(store.getState().settings).toEqual({ rtkEnabled: true });

    // A subsequent read that fails means we can no longer confirm the server's
    // state. Holding the old snapshot would present a stale value as current.
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    await store.getState().fetchSettings({ force: true });

    expect(store.getState().settings).toBeNull();
  });

  it("leaves settings unknown when the payload is not an object", async () => {
    const store = await loadStore();
    fetchMock.mockResolvedValue(jsonResponse(null));

    await store.getState().fetchSettings({ force: true });

    expect(store.getState().settings).toBeNull();
    expect(store.getState().error).toMatch(/malformed/i);
  });

  it("leaves settings unknown when the response body is not JSON", async () => {
    const store = await loadStore();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token <");
      },
    });

    await store.getState().fetchSettings({ force: true });

    expect(store.getState().settings).toBeNull();
  });
});

describe("settingsStore read commit rules", () => {
  it("commits a successful read and stamps lastFetched", async () => {
    const store = await loadStore();
    fetchMock.mockResolvedValue(jsonResponse({ rtkEnabled: true, cavemanEnabled: true }));

    const data = await store.getState().fetchSettings({ force: true });

    expect(data).toEqual({ rtkEnabled: true, cavemanEnabled: true });
    expect(store.getState().settings).toEqual({ rtkEnabled: true, cavemanEnabled: true });
    expect(store.getState().lastFetched).toBeGreaterThan(0);
  });

  it("returns the fresh cache without a network call, and force bypasses it", async () => {
    const store = await loadStore();
    fetchMock.mockResolvedValue(jsonResponse({ rtkEnabled: false }));

    await store.getState().fetchSettings({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cached = await store.getState().fetchSettings();
    expect(cached).toEqual({ rtkEnabled: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await store.getState().fetchSettings({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not serve an unknown value from the cache", async () => {
    const store = await loadStore();
    fetchMock.mockResolvedValue(jsonResponse({ rtkEnabled: true }));

    // settings is null, so there is nothing to serve even with a fresh stamp.
    store.setState({ lastFetched: Date.now() });
    await store.getState().fetchSettings();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getState().settings).toEqual({ rtkEnabled: true });
  });

  it("lets only the newest read commit when an older read resolves last", async () => {
    const store = await loadStore();
    const older = deferred();
    const newer = deferred();
    fetchMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const first = store.getState().fetchSettings({ force: true });
    const second = store.getState().fetchSettings({ force: true });

    newer.resolve(jsonResponse({ rtkEnabled: true }));
    await second;
    older.resolve(jsonResponse({ rtkEnabled: false }));
    await first;

    // The stale snapshot must not overwrite the newer one.
    expect(store.getState().settings).toEqual({ rtkEnabled: true });
  });

  it("does not let a stale failure wipe a newer successful read", async () => {
    const store = await loadStore();
    const older = deferred();
    const newer = deferred();
    fetchMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const first = store.getState().fetchSettings({ force: true });
    const second = store.getState().fetchSettings({ force: true });

    newer.resolve(jsonResponse({ rtkEnabled: true }));
    await second;
    older.reject(new Error("network down"));
    await first;

    // Unknown is the right answer for the read that failed, but that read is no
    // longer the newest — it must not reset a value the server did report.
    expect(store.getState().settings).toEqual({ rtkEnabled: true });
    expect(store.getState().error).toBeNull();
  });
});

describe("settingsStore patchSettings reads back", () => {
  it("commits the SERVER's value from the readback, not the requested value", async () => {
    const store = await loadStore();
    // The PATCH response claims the write landed...
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ claudeClassifierCompat: "auto" }))
      // ...but the readback is what the server actually holds.
      .mockResolvedValueOnce(jsonResponse({ claudeClassifierCompat: "off" }));

    const confirmed = await store.getState().patchSettings({ claudeClassifierCompat: "auto" });

    expect(confirmed).toEqual({ claudeClassifierCompat: "off" });
    expect(store.getState().settings).toEqual({ claudeClassifierCompat: "off" });

    const [patchCall, readbackCall] = fetchMock.mock.calls;
    expect(patchCall[1].method).toBe("PATCH");
    expect(readbackCall[1].method).toBe("GET"); // the readback is a plain GET
    expect(readbackCall[1].body).toBeUndefined();
  });

  it("keeps the known value on a rejected write, since nothing was written", async () => {
    const store = await loadStore();
    fetchMock.mockResolvedValueOnce(jsonResponse({ rtkEnabled: true }));
    await store.getState().fetchSettings({ force: true });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad" }, 400));
    const confirmed = await store.getState().patchSettings({ rtkEnabled: false });

    // A 400 is rejected before any write, so the server still holds what the
    // store already shows. The value stays confirmed; only the error reports it.
    expect(confirmed).toEqual({ rtkEnabled: true });
    expect(store.getState().settings).toEqual({ rtkEnabled: true });
    expect(store.getState().error).toMatch(/400/);
    expect(store.getState().loading).toBe(false);
    // No readback for a rejection: the response is definitive.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("goes unknown on a 5xx write, which may have landed anyway", async () => {
    const store = await loadStore();
    fetchMock.mockResolvedValueOnce(jsonResponse({ rtkEnabled: true }));
    await store.getState().fetchSettings({ force: true });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "gateway" }, 502));
    const confirmed = await store.getState().patchSettings({ rtkEnabled: false });

    expect(confirmed).toBeNull();
    expect(store.getState().settings).toBeNull();
  });

  it("ends the in-flight state when the caller aborts, without asserting a value", async () => {
    const store = await loadStore();
    fetchMock.mockResolvedValueOnce(jsonResponse({ rtkEnabled: true }));
    await store.getState().fetchSettings({ force: true });

    // Reverse the earlier assertion on purpose -- next response is a rejection.
    const abort = new DOMException("aborted", "AbortError");
    fetchMock.mockRejectedValueOnce(abort);
    const controller = new AbortController();
    const pending = store.getState().fetchSettings({ force: true, signal: controller.signal });
    controller.abort();

    const result = await pending;

    // A cancelled read is not a failed read: the store is shared, so nulling
    // the value would disable every other consumer's controls because one
    // component unmounted.
    expect(result).toBeNull();
    expect(store.getState().settings).toEqual({ rtkEnabled: true });
    expect(store.getState().loading).toBe(false);
    expect(store.getState().error).toBeNull();
  });

  it("treats a timeout as a failure, not as a caller cancellation", async () => {
    const store = await loadStore();
    // A fetch that only ever settles when its signal aborts — i.e. a hung
    // server. AbortController.abort(reason) rejects with that reason.
    fetchMock.mockImplementationOnce(
      (input, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    );

    // The store's own 10s deadline is what fires here. No caller signal is
    // passed, so the "caller aborted" branch must not swallow the timeout — if
    // it did, a hung server would leave `loading` true and every toggle
    // disabled forever with no retry control able to appear.
    vi.useFakeTimers();
    try {
      const pending = store.getState().fetchSettings({ force: true });
      await vi.advanceTimersByTimeAsync(10001);
      const result = await pending;

      expect(result).toBeNull();
      expect(store.getState().settings).toBeNull();
      expect(store.getState().loading).toBe(false);
      expect(store.getState().error).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });


  it("goes unknown when the write itself throws", async () => {
    const store = await loadStore();
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    const confirmed = await store.getState().patchSettings({ rtkEnabled: true });

    expect(confirmed).toBeNull();
    expect(store.getState().settings).toBeNull();
    expect(store.getState().error).toMatch(/offline/);
    expect(store.getState().loading).toBe(false);
  });

  it("goes unknown when the readback fails even though the write returned 200", async () => {
    const store = await loadStore();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ rtkEnabled: true }))
      .mockResolvedValueOnce(jsonResponse({}, 502));

    const confirmed = await store.getState().patchSettings({ rtkEnabled: true });

    expect(confirmed).toBeNull();
    expect(store.getState().settings).toBeNull();
  });
});
