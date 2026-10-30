import { createHash, randomUUID } from "node:crypto";

/** Only caller-selected metadata is logged, never upstream bodies or credentials. */
export function createStartPlanDiagnostics(credentials) {
  const reference = credentials?.id || credentials?.email || credentials?.providerSpecificData?.zcodeUserId;
  const context = {
    attempt: randomUUID().slice(0, 8),
    account: reference ? createHash("sha256").update(String(reference)).digest("hex").slice(0, 12) : "oauth-new-account",
    ...(credentials?.id ? { connectionId: credentials.id } : {}),
  };
  return {
    event(step, outcome, details = {}) {
      const write = outcome === "failed" ? console.warn : console.info;
      write(`[Start Plan] ${step}: ${outcome}`, { ...context, ...details });
    },
  };
}
