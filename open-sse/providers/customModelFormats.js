// Sync read side of per-model upstream endpoint overrides stored on custom
// models (kv scope "customModels", field `targetFormat`).
//
// getTargetFormat lookup in config/providerModels.js is synchronous per request,
// but custom models live in SQLite (async adapters), so the server pushes an
// async loader here (installCustomModelFormats, instrumentation.js) and the
// hot path reads a cached Map. installCustomModelFormats(force) is re-called
// by the custom-model API routes after every add/delete so edits apply live.

const EMPTY = new Map();

let loader = null;
let cache = EMPTY;
let loading = null;

function key(providerAlias, modelId) {
  return `${String(providerAlias || "")}|${String(modelId || "")}`;
}

export function getCustomModelTargetFormat(providerAlias, modelId) {
  if (!cache.size) return null;
  // Exact id first, then the base id without a thinking suffix "model(level)".
  const hit = cache.get(key(providerAlias, modelId))
    ?? cache.get(key(providerAlias, String(modelId || "").replace(/\([^()]+\)\s*$/, "").trim()));
  return hit || null;
}

async function refresh(force = false) {
  if (!loader) return;
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const models = await loader() || [];
      const next = new Map();
      for (const m of models) {
        if (m?.targetFormat && m?.providerAlias && m?.id) {
          next.set(key(m.providerAlias, m.id), m.targetFormat);
        }
      }
      cache = next;
    } catch {
      // Fail open: keep the previous cache; format overrides are best-effort.
    } finally {
      loading = null;
    }
  })();
  return loading;
}

// Server-only install (mirrors catalogOverride.installCatalogSource): loader
// returns the full custom-model row list.
export async function installCustomModelFormats(load) {
  loader = load;
  await refresh(true);
}

export async function refreshCustomModelFormats() {
  await refresh(true);
}
