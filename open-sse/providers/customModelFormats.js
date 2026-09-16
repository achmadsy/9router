// Sync read side of per-model upstream endpoint overrides stored on custom
// models (kv scope "customModels", field `targetFormat`).
//
// getTargetFormat lookup in config/providerModels.js is synchronous per request,
// but custom models live in SQLite (async adapters), so the server pushes an
// async loader here (installCustomModelFormats, instrumentation.js) and the
// hot path reads a cached Map. installCustomModelFormats(force) is re-called
// by the custom-model API routes after every add/delete so edits apply live.

const EMPTY = new Map();

// State lives on globalThis: Next/webpack bundles this module into separate
// chunk graphs (instrumentation vs route chunks) as distinct instances, so
// module-level lets would not be shared. globalThis is the one shared heap —
// same pattern as __9router_sentry / __9routerFreebuffState__.
const STATE_KEY = "__9routerCustomModelFormats__";
const state = (globalThis[STATE_KEY] ??= {
  loader: null,
  cache: EMPTY,   // Map<"alias|modelId", targetFormat>
  loading: null,  // in-flight refresh promise
});

function key(providerAlias, modelId) {
  return `${String(providerAlias || "")}|${String(modelId || "")}`;
}

export function getCustomModelTargetFormat(providerAlias, modelId) {
  const cache = state.cache;
  if (!cache.size) return null;
  // Exact id first, then the base id without a thinking suffix "model(level)".
  const hit = cache.get(key(providerAlias, modelId))
    ?? cache.get(key(providerAlias, String(modelId || "").replace(/\([^()]+\)\s*$/, "").trim()));
  return hit || null;
}

async function refresh(force = false) {
  if (!state.loader) return;
  if (state.loading && !force) return state.loading;
  state.loading = (async () => {
    try {
      const models = await state.loader() || [];
      const next = new Map();
      for (const m of models) {
        if (m?.targetFormat && m?.providerAlias && m?.id) {
          next.set(key(m.providerAlias, m.id), m.targetFormat);
        }
      }
      state.cache = next;
    } catch {
      // Fail open: keep the previous cache; format overrides are best-effort.
    } finally {
      state.loading = null;
    }
  })();
  return state.loading;
}

// Server-only install (mirrors catalogOverride.installCatalogSource): loader
// returns the full custom-model row list. A second install (duplicate module
// instance across chunk graphs) just re-points the shared loader.
export async function installCustomModelFormats(load) {
  state.loader = load;
  await refresh(true);
}

export async function refreshCustomModelFormats() {
  await refresh(true);
}
