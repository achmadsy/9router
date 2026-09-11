import { API_KEY_ACCESS_MODE, API_KEY_TARGET_TYPE } from "./constants.js";
import { buildTargetIdSet } from "./policy.js";

/**
 * Project which providers/models a restricted API key can reach, for the
 * Quota Tracker filter. ALL = unrestricted (null scope).
 */

function comboMemberIds(combo) {
  if (!combo) return [];
  const models = combo.models || [];
  return models.map((m) => (typeof m === "string" ? m : m?.id || m?.model)).filter(Boolean);
}

/** Recursively collect member model ids from a combo (visited set prevents cycles). */
export function expandComboMembers(combo, getComboById, visited = new Set()) {
  if (!combo?.id || visited.has(combo.id)) return [];
  visited.add(combo.id);
  const out = [];
  for (const mid of comboMemberIds(combo)) {
    out.push(mid);
    const memberCombo = getComboById ? getComboById(mid) : null;
    if (memberCombo) out.push(...expandComboMembers(memberCombo, getComboById, visited));
  }
  return out;
}

/**
 * Resolve reachable providers/models for a key.
 * Returns null for ALL (unrestricted). Restricted keys with no targets → empty sets (deny-all).
 *
 * Production callers may omit loaders — default to the live combo/custom/alias
 * registries so combo-only policies expand member providers instead of collapsing
 * to an empty scope.
 */
export async function resolveQuotaScope(row, options = {}) {
  if (!row) return null;
  if (row.accessMode === API_KEY_ACCESS_MODE.ALL || !row.accessMode) return null;

  const {
    getCombos: getCombosOption,
    getCustomModels: getCustomModelsOption,
    getModelAliases: getModelAliasesOption,
  } = options;

  let localDb = null;
  try {
    localDb = await import("@/lib/localDb.js");
  } catch {
    localDb = null;
  }

  const loadCombos = getCombosOption || localDb?.getCombos || (async () => []);
  const loadCustomModels = getCustomModelsOption || localDb?.getCustomModels || (async () => []);
  const loadAliases = getModelAliasesOption || localDb?.getModelAliases || (async () => ({}));

  const { models: modelTargets, combos: comboTargets } = buildTargetIdSet(row.targets || []);

  // Exposed model ids reachable: direct models + combo members (recursive).
  const reachableModelIds = new Set(modelTargets);
  let allCombos = [];
  try { allCombos = await loadCombos(); } catch { allCombos = []; }
  const comboById = new Map(allCombos.map((c) => [c.id, c]));
  const comboByName = new Map(allCombos.map((c) => [c.name, c]));

  const reachableCombos = new Set();
  for (const cid of comboTargets) {
    const combo = comboById.get(cid) || comboByName.get(cid);
    if (!combo) continue;
    reachableCombos.add(combo.id);
    reachableCombos.add(combo.name);
    for (const mid of expandComboMembers(combo, (id) => comboById.get(id) || comboByName.get(id))) {
      reachableModelIds.add(mid);
    }
  }

  // Custom models / aliases: expose as `${alias}/${id}` — match either full or bare id.
  let custom = [];
  try { custom = await loadCustomModels(); } catch { custom = []; }
  let aliases = {};
  try { aliases = await loadAliases(); } catch { aliases = {}; }

  // Providers derived from exposed model ids that look like `alias/rest` or bare.
  const providers = new Set();
  for (const mid of reachableModelIds) {
    if (mid.includes("/")) providers.add(mid.split("/")[0]);
  }
  for (const mid of modelTargets) {
    if (mid.includes("/")) providers.add(mid.split("/")[0]);
  }

  return {
    accessMode: API_KEY_ACCESS_MODE.RESTRICTED,
    modelIds: reachableModelIds,
    comboIds: reachableCombos,
    providers,
    customModels: custom,
    aliases,
    isEmpty: reachableModelIds.size === 0 && reachableCombos.size === 0,
  };
}

/** True if a connection's provider is in scope (scope null = unrestricted). */
export function connectionInScope(scope, connection) {
  if (!scope) return true;
  if (!connection) return false;
  if (scope.isEmpty) return false;
  if (scope.providers.has(connection.provider)) return true;
  // A provider is reachable if any of its exposed models is in modelIds.
  const prefix = `${connection.provider}/`;
  for (const mid of scope.modelIds) {
    if (mid.startsWith(prefix) || mid === connection.provider) return true;
  }
  return false;
}
