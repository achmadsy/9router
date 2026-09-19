// Synchronous read side for user-supplied per-model token limits.
// SQLite is async across adapters, so server startup installs a loader and the
// request hot path reads this global cache. globalThis keeps Next route chunks
// and instrumentation chunks on one shared state.

import { resolveProviderAlias } from "../services/model.js";

const EMPTY = new Map();
const STATE_KEY = "__9routerModelCapabilityOverrides__";
const state = (globalThis[STATE_KEY] ??= {
  loader: null,
  cache: EMPTY,
  loading: null,
});

function key(provider, model) {
  return `${String(provider || "")}|${String(model || "")}`;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function sanitizeModelTokenCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const contextWindow = positiveInteger(caps.contextWindow);
  const maxOutput = positiveInteger(caps.maxOutput);
  const clean = {};
  if (contextWindow) clean.contextWindow = contextWindow;
  if (maxOutput) clean.maxOutput = maxOutput;
  return Object.keys(clean).length ? clean : null;
}

export function getModelCapabilityOverride(provider, model) {
  if (!state.cache.size) return null;
  const raw = String(model || "");
  const base = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const withoutSuffix = base.replace(/\([^()]+\)\s*$/, "").trim();
  return state.cache.get(key(provider, raw))
    ?? state.cache.get(key(provider, base))
    ?? state.cache.get(key(provider, withoutSuffix))
    ?? null;
}

async function refresh(force = false) {
  if (!state.loader) return;
  if (state.loading && !force) return state.loading;
  state.loading = (async () => {
    try {
      const entries = await state.loader() || [];
      const next = new Map();
      for (const entry of entries) {
        const caps = sanitizeModelTokenCaps(entry?.caps);
        if (entry?.provider && entry?.model && caps) {
          next.set(key(entry.provider, entry.model), caps);
          next.set(key(resolveProviderAlias(entry.provider), entry.model), caps);
        }
      }
      state.cache = next;
    } catch {
      // Fail open: retain prior metadata when storage is temporarily unavailable.
    } finally {
      state.loading = null;
    }
  })();
  return state.loading;
}

export async function installModelCapabilityOverrides(load) {
  state.loader = load;
  await refresh(true);
}

export async function refreshModelCapabilityOverrides() {
  await refresh(true);
}
