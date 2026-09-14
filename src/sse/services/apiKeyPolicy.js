import { getSettings } from "@/lib/localDb";
import { authenticateApiKey } from "@/lib/db/index.js";
import { getApiKeyTokenUsage } from "@/lib/db/repos/usageRepo.js";
import { extractApiKey } from "./auth.js";
import { authorizeResource, loadCombosForPolicy, modelNotAllowedResponse } from "@/lib/apiKeys/policy.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import * as log from "../utils/logger.js";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;
async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

/**
 * Shared API-key request context. Authenticate once; attach metadata+policy only.
 * Returns { apiKey, keyRow, errorResponse } — errorResponse is a Response when denied.
 *
 * Trusted local self-calls (x-9r-cli-token matching machineId) bypass API-key
 * requirement without inventing or storing a plaintext sk-9r secret.
 */
export async function resolveApiKeyContext(request, options = {}) {
  const cliToken = request?.headers?.get?.(CLI_TOKEN_HEADER);
  if (cliToken) {
    const expected = await getCliToken();
    if (expected && cliToken === expected) {
      return { apiKey: null, keyRow: null, errorResponse: null };
    }
  }

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  const requireApiKey = options.requireApiKey ?? settings.requireApiKey;

  if (!apiKey) {
    if (requireApiKey) {
      return {
        apiKey: null,
        keyRow: null,
        errorResponse: Response.json(
          { error: { message: "Missing API key", type: "invalid_request_error", code: "invalid_api_key" } },
          { status: 401 }
        ),
      };
    }
    return { apiKey: null, keyRow: null, errorResponse: null };
  }

  const keyRow = await authenticateApiKey(apiKey);
  if (!keyRow) {
    // Invalid or paused key → 401 regardless of requireApiKey (key was presented).
    return {
      apiKey,
      keyRow: null,
      errorResponse: Response.json(
        { error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } },
        { status: 401 }
      ),
    };
  }

  // Per-key total token limit (input+output; cache rides in the prompt total).
  // Fail-open: if the usage lookup errors, allow the request through.
  if (keyRow.tokenLimit) {
    try {
      const used = await getApiKeyTokenUsage(keyRow.id, keyRow.tokenLimitPeriod);
      if (used.totalTokens >= keyRow.tokenLimit) {
        log.warn("API_KEY", `Token limit exceeded for key ${keyRow.id} (${keyRow.name || "unnamed"}): ${used.totalTokens}/${keyRow.tokenLimit} (${keyRow.tokenLimitPeriod})`);
        return {
          apiKey,
          keyRow,
          errorResponse: Response.json(
            {
              error: {
                message: `API key token limit exceeded (${keyRow.tokenLimitPeriod}): ${used.totalTokens} of ${keyRow.tokenLimit} tokens used`,
                type: "insufficient_quota",
                code: "token_limit_exceeded",
              },
            },
            { status: 429, headers: { "retry-after": retryAfterSeconds(keyRow.tokenLimitPeriod) } }
          ),
        };
      }
    } catch (e) {
      log.warn("API_KEY", `Token limit check failed (allowing request): ${e?.message || e}`);
    }
  }

  return { apiKey, keyRow, errorResponse: null };
}

/** Seconds until the limit window resets (daily → next local midnight, monthly → next month, forever → null). */
function retryAfterSeconds(period) {
  if (period === "daily" || period === "monthly") {
    const now = new Date();
    const reset = new Date(now);
    if (period === "daily") reset.setDate(now.getDate() + 1);
    else reset.setMonth(now.getMonth() + 1);
    reset.setHours(0, 0, 0, 0);
    return String(Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1000)));
  }
  return "0";
}

/**
 * Authorize the ORIGINAL exposed resource (model string or combo name) BEFORE
 * combo expansion / alias resolution / capacity adapters / account fallback.
 * Returns null if allowed, or a 403 Response.
 */
export async function authorizeOriginalResource(keyRow, resource, options = {}) {
  if (!keyRow) return null; // local mode (no key) — no policy
  const auth = await authorizeResource(keyRow, resource, {
    getCombos: options.getCombos || loadCombosForPolicy,
  });
  if (auth.allowed) return null;
  const { status, body } = modelNotAllowedResponse(resource);
  log.warn("API_KEY", `Denied model '${resource}' for key ${keyRow.id} (${keyRow.name || "unnamed"})`);
  return Response.json(body, { status });
}
