import { API_KEY_ACCESS_MODE, API_KEY_TARGET_TYPE } from "./constants.js";

/**
 * Strict input validation for /api/keys create/update.
 * Unknown accessMode or target types are rejected (400) rather than silently coerced.
 */

export function validateAccessMode(accessMode) {
  if (accessMode === undefined || accessMode === null) return null; // omitted
  if (accessMode === API_KEY_ACCESS_MODE.ALL) return API_KEY_ACCESS_MODE.ALL;
  if (accessMode === API_KEY_ACCESS_MODE.RESTRICTED) return API_KEY_ACCESS_MODE.RESTRICTED;
  return "invalid";
}

export function validateTargets(targets) {
  if (targets === undefined || targets === null) return null; // omitted
  if (!Array.isArray(targets)) return "invalid";
  for (const t of targets) {
    if (!t) return "invalid";
    const targetType = typeof t === "string" ? API_KEY_TARGET_TYPE.MODEL : t?.targetType;
    const targetId = typeof t === "string" ? t : t?.targetId;
    if (targetType !== API_KEY_TARGET_TYPE.MODEL && targetType !== API_KEY_TARGET_TYPE.COMBO) return "invalid";
    if (!targetId || typeof targetId !== "string") return "invalid";
  }
  return targets;
}

/** Returns { accessMode?, targets? } or { error: "..." } for a 400 response. */
export function parsePolicyInput(body = {}) {
  const out = {};
  if (body.accessMode !== undefined) {
    const mode = validateAccessMode(body.accessMode);
    if (mode === "invalid") {
      return { error: `Invalid accessMode: use "${API_KEY_ACCESS_MODE.ALL}" or "${API_KEY_ACCESS_MODE.RESTRICTED}"` };
    }
    out.accessMode = mode;
  }
  if (body.targets !== undefined) {
    const targets = validateTargets(body.targets);
    if (targets === "invalid") {
      return { error: "Invalid targets: each target must have targetType 'model' | 'combo' and a non-empty targetId" };
    }
    out.targets = targets;
  }
  return out;
}
