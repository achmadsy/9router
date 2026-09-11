import { API_KEY_ACCESS_MODE, API_KEY_TARGET_TYPE } from "./constants.js";

/**
 * Policy helpers for per-key model/combo access.
 * A restricted key with no targets is deny-all.
 */

export function isRestricted(row) {
  return row?.accessMode === API_KEY_ACCESS_MODE.RESTRICTED;
}

export function normalizeTargets(targets) {
  const out = [];
  const seen = new Set();
  for (const t of targets || []) {
    if (!t) continue;
    const targetType = typeof t === "string" ? API_KEY_TARGET_TYPE.MODEL : t.targetType;
    const targetId = typeof t === "string" ? t : t.targetId;
    if (!targetId || typeof targetId !== "string") continue;
    if (targetType !== API_KEY_TARGET_TYPE.MODEL && targetType !== API_KEY_TARGET_TYPE.COMBO) continue;
    const k = `${targetType}:${targetId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ targetType, targetId });
  }
  return out;
}

export function buildTargetIdSet(targets) {
  const models = new Set();
  const combos = new Set();
  for (const t of normalizeTargets(targets)) {
    if (t.targetType === API_KEY_TARGET_TYPE.MODEL) models.add(t.targetId);
    else combos.add(t.targetId);
  }
  return { models, combos };
}

/** Expand selected combo targets (name or legacy UUID) to both id forms. Does NOT expand member models. */
function expandComboAliases(combos, allCombos) {
  const out = new Set(combos);
  for (const c of allCombos || []) {
    if (!c?.id && !c?.name) continue;
    if (combos.has(c.id) || combos.has(c.name)) {
      if (c.id) out.add(c.id);
      if (c.name) out.add(c.name);
    }
  }
  return out;
}

/**
 * Authorize an original exposed resource id (model string or combo name).
 * Must be called BEFORE combo expansion, alias resolution, capacity adapters,
 * and account fallback — against the raw id the client sent.
 *
 * options.getCombos — optional async loader of full combo rows (id+name) used
 * only to alias-match selected combo targets. Safe to omit in unit tests.
 */
export async function authorizeResource(row, resource, options = {}) {
  if (!row) return { allowed: false, reason: "no_key" };
  if (!isRestricted(row)) return { allowed: true, reason: "all" };
  const { models, combos } = buildTargetIdSet(row.targets || []);
  const id = typeof resource === "string" ? resource : "";
  if (!id) return { allowed: false, reason: "empty" };

  let comboSet = combos;
  if (combos.size > 0 && typeof options.getCombos === "function") {
    let allCombos = [];
    try {
      allCombos = await options.getCombos();
    } catch {
      allCombos = [];
    }
    comboSet = expandComboAliases(combos, allCombos);
  }

  if (comboSet.has(id)) return { allowed: true, reason: "combo" };
  if (models.has(id)) return { allowed: true, reason: "model" };
  return { allowed: false, reason: "not_allowed" };
}

export async function isModelAllowed(row, modelId, options = {}) {
  const auth = await authorizeResource(row, modelId, options);
  return auth.allowed;
}

/** Default combo loader for authorize/isModelAllowed callers. */
export async function loadCombosForPolicy() {
  try {
    const { getCombos } = await import("@/lib/db/index.js");
    return (await getCombos()) || [];
  } catch {
    return [];
  }
}

/** Filter a catalog of { id, ... } entries down to what the key may see. */
export function filterCatalogByPolicy(row, entries, options = {}) {
  if (!row || !isRestricted(row)) return entries;
  const { models, combos } = buildTargetIdSet(row.targets || []);
  const allCombos = Array.isArray(options.combos) ? options.combos : [];
  const comboSet = expandComboAliases(combos, allCombos);
  return (entries || []).filter((e) => e?.id && (models.has(e.id) || comboSet.has(e.id)));
}

/** OpenAI-style 403 body for a denied model. */
export function modelNotAllowedResponse(modelId) {
  return {
    status: 403,
    body: {
      error: {
        message: `API key does not access model '${modelId}'.`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_allowed",
      },
    },
  };
}

export { API_KEY_ACCESS_MODE, API_KEY_TARGET_TYPE };
