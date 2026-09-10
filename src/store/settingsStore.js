"use client";

import { create } from "zustand";
import { CLIENT_STORE_TTL_MS } from "@/shared/constants/config";

// A read that never settles would pin `loading` true forever, and since the
// dashboard disables its server-backed toggles while a read is in flight, that
// is a page whose controls never become usable and whose retry affordance never
// appears. Bounded, a hung server resolves to an explicit failure.
const SETTINGS_READ_TIMEOUT_MS = 10000;

// Builds the options for one settings request, combining an optional caller
// abort signal with the timeout above. Lives here rather than being inlined so
// the read and the write cannot drift apart on either behaviour.
function requestOptions({ method = "GET", body, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("timed out", "TimeoutError")),
    SETTINGS_READ_TIMEOUT_MS,
  );
  const onCallerAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    init: {
      method,
      signal: controller.signal,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    },
    // Resolves once the caller's listener is detached, so unmounting mid-request
    // does not leave a listener on the caller's signal.
    release: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    },
  };
}

// Settings that pages gate interaction on. `settings === null` is the UNKNOWN
// state, not an empty settings object: it means "the server's settings have not
// been established", so consumers must render nothing confident and keep their
// controls disabled. That is what makes a late, failed or unreadable response
// unable to present a stale value as if it were the server's current one.
//
// Two rules keep that honest:
//   * `settings` is written ONLY from a completed, valid read — never from a
//     PATCH response body, and never optimistically.
//   * a failed read leaves `settings` null rather than the previous snapshot:
//     we cannot confirm the server's state, so we must not assert it.
const useSettingsStore = create((set, get) => ({
  settings: null,
  loading: false,
  error: null,
  lastFetched: 0,

  // Monotonic read counter (closure state, not reactive). Only the newest read
  // may commit, so a slow earlier read cannot resolve last and win.
  _readGeneration: 0,

  invalidate: () => set({ lastFetched: 0 }),

  // Skips network when the cache is fresh; pass {force:true} to bypass the TTL.
  // Callers displaying a security-relevant value MUST pass {force:true}: within
  // the TTL a cached value can disagree with the server.
  fetchSettings: async ({ force = false, signal } = {}) => {
    const { lastFetched, settings } = get();
    if (!force && settings && Date.now() - lastFetched < CLIENT_STORE_TTL_MS) return settings;

    const generation = (get()._readGeneration += 1);
    const commit = (patch) => {
      // Drop any read that a newer one has superseded, or one that failed while
      // still being the newest read (`settings: null` = unknown, not stale).
      if (generation !== get()._readGeneration) return false;
      set(patch);
      return true;
    };

    set({ loading: true, error: null });
    const { init, release } = requestOptions({ signal });
    try {
      const res = await fetch("/api/settings", init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || typeof data !== "object") throw new Error("malformed settings payload");
      const committed = commit({ settings: data, loading: false, lastFetched: Date.now() });
      return committed ? data : get().settings;
    } catch (e) {
      // A caller abort is a deliberate cancellation (usually unmount), not a
      // failed read. Leave the value untouched and only end the in-flight state:
      // the store is shared, so holding `loading` here would leave every other
      // consumer's controls disabled on behalf of a component that is gone.
      // (The timeout is NOT a caller abort — its signal belongs to this request
      // and is not the caller's, so it falls through to the failure branch.)
      if (signal?.aborted) {
        commit({ loading: false });
        return null;
      }
      // Unknown, not stale. Consumers read null and disable their controls.
      commit({ settings: null, error: e?.message || "Failed to fetch settings", loading: false });
      return null;
    } finally {
      release();
    }
  },

  // PATCH then READ BACK. The PATCH response body is not trusted as the new
  // state: the write may land server-side while its response is lost, and a
  // gate that displays the response it asked for is how the UI ends up showing
  // a value the server does not hold. The readback is the only committer.
  patchSettings: async (patch) => {
    set({ loading: true, error: null });
    const { init, release } = requestOptions({ method: "PATCH", body: patch });
    try {
      const res = await fetch("/api/settings", init);
      if (res.status === 400) {
        // Rejected before any write, so the server still holds exactly what the
        // store already has. That value was itself committed from a read, and
        // nothing has invalidated it — dropping it would discard a value we
        // know in exchange for one we do not.
        set({ loading: false, error: "HTTP 400" });
        return get().settings;
      }
      if (!res.ok) {
        // A 5xx may have been emitted after the write landed, so the outcome is
        // genuinely unknown — not "unchanged". Go unknown rather than assert a
        // value that may already have been replaced.
        set({ settings: null, loading: false, error: `HTTP ${res.status}` });
        return null;
      }
      const confirmed = await get().fetchSettings({ force: true });
      return confirmed;
    } catch (e) {
      set({ settings: null, loading: false, error: e?.message || "Failed to update settings" });
      return null;
    } finally {
      release();
    }
  },
}));

export default useSettingsStore;
