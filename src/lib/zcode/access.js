export const ZAI_PLAN_MODES = Object.freeze({
  START: "start-plan",
  INDIVIDUAL: "individual-coding-plan",
  TEAM: "team-coding-plan",
  API_KEY: "api-key",
});

export function validateZaiPlanMode(value) {
  if (!Object.values(ZAI_PLAN_MODES).includes(value)) {
    throw Object.assign(new Error("Invalid Z.AI inference plan"), { status: 400 });
  }
  return value;
}

/** Normalize the older generic CLI credential layout without changing storage. */
export function normalizeZaiCredentials(credentials = {}) {
  const psd = credentials.providerSpecificData || {};
  if (psd.authMethod !== "cli_poll") return credentials;
  return {
    ...credentials,
    apiKey: credentials.apiKey || credentials.accessToken,
    accessToken: psd.zaiBusinessToken || null,
  };
}

export function resolveZaiPlanMode(credentials = {}) {
  const psd = credentials.providerSpecificData || {};
  if (psd.zaiPlanMode) return validateZaiPlanMode(psd.zaiPlanMode);
  if (psd.useCodingPlan === true) return ZAI_PLAN_MODES.START;
  if (psd.zcodeJwtToken && psd.authMethod !== "cli_poll" && psd.useCodingPlan !== false) {
    return ZAI_PLAN_MODES.START;
  }
  return ZAI_PLAN_MODES.API_KEY;
}

export function isZaiStartPlan(credentials) {
  return resolveZaiPlanMode(credentials) === ZAI_PLAN_MODES.START;
}

export function isZaiAccountCodingPlan(credentials) {
  return [ZAI_PLAN_MODES.INDIVIDUAL, ZAI_PLAN_MODES.TEAM].includes(resolveZaiPlanMode(credentials));
}
