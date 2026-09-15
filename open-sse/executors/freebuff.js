import { BaseExecutor } from "./base.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { createHash } from "node:crypto";

/**
 * Freebuff executor — free-mode session admission + chat/completions.
 *
 * Protocol (from CodebuffAI/freebuff):
 *   Session (required for free-mode models):
 *     POST {sessionAdmissionUrl}
 *       headers: Authorization, x-freebuff-model, x-freebuff-wallet-spend-limit
 *       → { status: "active", instanceId, model, expiresAt, ... }
 *     GET/DELETE {sessionUrl} with x-freebuff-instance-id
 *
 *   Inference:
 *     POST {baseUrl}
 *       headers: Authorization
 *       body: OpenAI chat + codebuff_metadata.freebuff_instance_id
 *
 * Gate rejections on chat/completions (FREEBUFF_GATE_CODES):
 *   waiting_room_required  428  ends session → re-admit
 *   session_expired        410  ends session → re-admit
 *   session_superseded     409  ends session → re-admit
 *   session_model_mismatch 409  ends session → re-admit
 *   session_limit_reached  409  keeps session
 *   waiting_room_queued    429  keeps session
 *   model_unavailable      410  keeps session
 *
 * device mid: the account's fingerprintId / instanceId pair lives in
 * providerSpecificData.deviceMid; the live session instance id is injected
 * as freebuff_instance_id on every completion body.
 */

const SESSION_HEADER = "x-freebuff-instance-id";
const MODEL_HEADER = "x-freebuff-model";
const WALLET_LIMIT_HEADER = "x-freebuff-wallet-spend-limit";
// Upstream model-provider.ts sends this on inference + agent-runs (own user id).
// Honored by the server only for the Freebuff Web service account; ignored for
// normal callers, so omitting it when unknown is safe.
const ACTING_USER_HEADER = "x-freebuff-acting-user-id";
const AGENT_RUNS_URL = "https://codebuff.com/api/v1/agent-runs";
const FREEBUFF_SYSTEM_OPENING = "You are Buffy, the strategic coding assistant.";
const NINEROUTER_SELF_AWARENESS =
  "This request is routed by 9Router through the Freebuff provider. Preserve the caller's requested task and response format; do not claim to be the Freebuff CLI application or to have local tools unless those tools were explicitly supplied.";

// Canonical first-party roots from freebuff/common/src/constants/free-agents.ts.
// Model+root pairing is enforced server-side (`free_mode_invalid_agent_model`).
const ROOT_AGENT_BY_MODEL = {
  "z-ai/glm-5.3-flash": "base2-free-glm-5-3-flash",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "upstage/solar-pro4": "base2-free-solar-pro4",
  "meta/muse-spark-1.3-contributor": "base2-free-muse-spark-1-3",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
};

/** Codes that mean the caller's session row is gone — forget and re-admit. */
const ENDS_THE_SESSION = new Set([
  "waiting_room_required",
  "session_expired",
  "session_superseded",
  "session_model_mismatch",
]);

/** codes → http status pairs required to classify a gate rejection. */
const GATE_CODES = {
  waiting_room_required: 428,
  session_expired: 410,
  session_superseded: 409,
  session_model_mismatch: 409,
  session_limit_reached: 409,
  waiting_room_queued: 429,
  model_unavailable: 410,
};

function connectionKey(credentials) {
  if (credentials?.id) return String(credentials.id);
  if (credentials?.email) return String(credentials.email);
  const token = credentials?.accessToken || credentials?.apiKey;
  if (token) {
    // Never retain plaintext bearer tokens in process-global cache keys/log metadata.
    return `token-${createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
  }
  return "freebuff-default";
}

function oauthConfig() {
  return PROVIDER_OAUTH.freebuff || PROVIDERS.freebuff?.oauth || {};
}

function sessionAdmissionUrl() {
  return (
    oauthConfig().sessionAdmissionUrl ||
    "https://codebuff.com/api/v1/freebuff/session/admission"
  );
}

function sessionUrl() {
  return oauthConfig().sessionUrl || "https://codebuff.com/api/v1/freebuff/session";
}

/** @type {Map<string, { instanceId: string, model: string, expiresAt: number }>} */
const sessionCache = new Map();

function isLive(entry, model, now = Date.now()) {
  if (!entry?.instanceId) return false;
  // ~30s buffer before server expiry.
  if (entry.expiresAt && now + 30_000 >= entry.expiresAt) return false;
  if (model && entry.model && entry.model !== model) return false;
  return true;
}

function dropSession(key) {
  sessionCache.delete(key);
}

function parseErrorGate(bodyText, status) {
  if (!bodyText) return null;
  try {
    const body = JSON.parse(bodyText);
    // Freebuff gate: { error: "<code>", message, ... } (error is a CODE string).
    const code = typeof body?.error === "string" ? body.error : null;
    if (!code || !(code in GATE_CODES)) return null;
    if (GATE_CODES[code] !== status) return null;
    return {
      code,
      endsTheSession: ENDS_THE_SESSION.has(code),
      message: body.message || code,
    };
  } catch {
    return null;
  }
}

function ensureBuffySystemOpening(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return body;
  const messages = body.messages.map((message) => ({ ...message }));
  const first = messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    if (!first.content.trimStart().startsWith(FREEBUFF_SYSTEM_OPENING)) {
      first.content = `${FREEBUFF_SYSTEM_OPENING}\n${NINEROUTER_SELF_AWARENESS}\n\n${first.content}`;
    } else if (!first.content.includes(NINEROUTER_SELF_AWARENESS)) {
      first.content = `${FREEBUFF_SYSTEM_OPENING}\n${NINEROUTER_SELF_AWARENESS}${first.content.trimStart().slice(FREEBUFF_SYSTEM_OPENING.length)}`;
    }
  } else {
    messages.unshift({
      role: "system",
      content: `${FREEBUFF_SYSTEM_OPENING}\n${NINEROUTER_SELF_AWARENESS}`,
    });
  }
  return { ...body, messages };
}

function rootAgentForModel(model) {
  return ROOT_AGENT_BY_MODEL[model] || "base2-free";
}

async function startAgentRun(credentials, model, proxyOptions, signal, log) {
  const token = credentials?.accessToken || credentials?.apiKey;
  const actingUser =
    credentials?.providerSpecificData?.userId || credentials?.userId;
  const response = await proxyAwareFetch(
    AGENT_RUNS_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        // Same convention as inference: honored only for the Web service
        // account, ignored for normal callers.
        ...(actingUser ? { [ACTING_USER_HEADER]: String(actingUser) } : {}),
      },
      body: JSON.stringify({
        action: "START",
        agentId: rootAgentForModel(model),
        ancestorRunIds: [],
      }),
      signal: signal || AbortSignal.timeout(20_000),
    },
    proxyOptions,
  );
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    log?.error?.(
      "FREEBUFF",
      `agent run START failed: HTTP ${response.status} ${text.slice(0, 500)}`,
    );
    throw new Error(`Freebuff agent run START failed: HTTP ${response.status}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Freebuff agent run START returned invalid JSON");
  }
  if (!data?.runId) throw new Error("Freebuff agent run START returned no runId");
  return data.runId;
}

async function finishAgentRun(credentials, runId, status, proxyOptions, log) {
  if (!runId) return;
  const token = credentials?.accessToken || credentials?.apiKey;
  const actingUser =
    credentials?.providerSpecificData?.userId || credentials?.userId;
  try {
    const response = await proxyAwareFetch(
      AGENT_RUNS_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(actingUser ? { [ACTING_USER_HEADER]: String(actingUser) } : {}),
        },
        body: JSON.stringify({
          action: "FINISH",
          runId,
          status,
          totalSteps: 1,
          directCredits: 0,
          totalCredits: 0,
          steps: [],
        }),
        signal: AbortSignal.timeout(20_000),
      },
      proxyOptions,
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log?.warn?.(
        "FREEBUFF",
        `agent run FINISH failed: HTTP ${response.status} ${text.slice(0, 500)}`,
      );
    } else {
      await response.body?.cancel?.().catch?.(() => {});
    }
  } catch (err) {
    log?.warn?.("FREEBUFF", `agent run FINISH network error: ${err?.message || err}`);
  }
}

function finishRunWithStream(response, finish) {
  if (!response?.body) {
    void finish(response?.ok ? "completed" : "failed");
    return response;
  }
  const reader = response.body.getReader();
  let settled = false;
  const settle = async (status) => {
    if (settled) return;
    settled = true;
    await finish(status);
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          void settle(response.ok ? "completed" : "failed");
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (err) {
        controller.error(err);
        void settle("failed");
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await settle("cancelled");
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", PROVIDERS.freebuff || PROVIDERS.fb);
  }

  buildHeaders(credentials, stream = true, extra = {}) {
    const headers = {
      "Content-Type": "application/json",
      // Upstream inference sends `ai-sdk/openai-compatible/${VERSION}/codebuff`
      // where VERSION is build-injected. Keep its recognizable prefix and
      // identify this client truthfully instead of spoofing a release version.
      "user-agent": "ai-sdk/openai-compatible/9router/freebuff-codebuff",
      ...this.config?.headers,
      ...extra,
    };
    const token = credentials?.accessToken || credentials?.apiKey;
    if (token) headers.Authorization = `Bearer ${token}`;
    // Forward own user id only when known. Server honors this solely for the
    // Freebuff Web service account; for normal callers it is ignored.
    const actingUser =
      credentials?.providerSpecificData?.userId || credentials?.userId;
    if (actingUser) headers[ACTING_USER_HEADER] = String(actingUser);
    // No Accept header: upstream postJsonToApi sends none on inference.
    void stream;
    return headers;
  }

  /**
   * Ensure a live free-mode session for this account+model.
   * Returns { instanceId } or null when the server does not require admission.
   */
  async ensureSession({ credentials, model, log, proxyOptions = null, signal = null }) {
    const key = connectionKey(credentials);
    const cached = sessionCache.get(key);
    if (isLive(cached, model)) {
      return { instanceId: cached.instanceId, cached: true };
    }

    // Stale or model mismatch — best-effort end so the next admission is clean.
    // Upstream sends ONLY Authorization + instance header here (no
    // Content-Type: no body; no Accept/user-agent/acting-user).
    const sessionToken = credentials?.accessToken || credentials?.apiKey;
    if (cached?.instanceId) {
      try {
        await proxyAwareFetch(
          sessionUrl(),
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${sessionToken}`,
              [SESSION_HEADER]: cached.instanceId,
            },
            signal: signal || AbortSignal.timeout(10_000),
          },
          proxyOptions,
        );
      } catch {
        // ignore — admission will supersede
      }
      dropSession(key);
    }

    // Exact upstream wire: Authorization + model + wallet limit. Nothing else.
    const headers = {
      Authorization: `Bearer ${sessionToken}`,
      ...(model ? { [MODEL_HEADER]: model } : {}),
      [WALLET_LIMIT_HEADER]: "0",
    };

    let response;
    try {
      response = await proxyAwareFetch(
        sessionAdmissionUrl(),
        {
          method: "POST",
          headers,
          signal: signal || AbortSignal.timeout(20_000),
        },
        proxyOptions,
      );
    } catch (err) {
      log?.error?.(
        "FREEBUFF",
        `session admission network error: ${err?.message || err}`,
      );
      throw new Error(
        `Freebuff session admission network error: ${err?.message || err}`,
      );
    }

    const text = await response.text().catch(() => "");
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    // Dedicated admission route intentionally fails closed on old servers.
    if (response.status === 404 || response.status === 405) {
      const err = new Error(
        "Freebuff session admission unsupported. Re-auth or retry after upstream update.",
      );
      err.freebuffAdmission = "session_admission_unsupported";
      throw err;
    }

    // Terminal refusals that should surface to the caller.
    // Keyword notes for Sentry issue-matching: rate / limit / quota / token_refresh / re-auth / invalid
    if (!response.ok && response.status !== 409 && response.status !== 429) {
      const msg =
        body?.message || body?.error || `session admission HTTP ${response.status}`;
      log?.warn?.(
        "FREEBUFF",
        `session admission failed (invalid token or limit): HTTP ${response.status} ${msg}`,
      );
      // Auth problems need re-auth; chat call still fails with real upstream body.
      if (response.status === 401 || response.status === 403) {
        log?.warn?.("FREEBUFF", `re-auth required: freebuff token_refresh / re-auth needed`);
        const err = new Error(msg);
        err.freebuffAuth = true;
        err.freebuffReauth = true;
        throw err;
      }
      return null;
    }

    // rate_limited / spend_limited / ip_capped / model_locked / etc.
    if (body?.status && body.status !== "active" && body.status !== "none") {
      const msg =
        body.message ||
        body.status +
          (body.model ? ` (${body.model})` : "") +
          (body.availableHours ? ` — ${body.availableHours}` : "");
      log?.warn?.("FREEBUFF", `session admission status=${body.status}: ${msg}`);
      // model_unavailable / rate_limited / spend_limited: hard stop for this request.
      if (
        body.status === "rate_limited" ||
        body.status === "spend_limited" ||
        body.status === "model_unavailable" ||
        body.status === "model_locked" ||
        body.status === "banned" ||
        body.status === "country_blocked" ||
        body.status === "ip_capped"
      ) {
        const err = new Error(
          `Freebuff ${body.status}: ${msg}`.trim(),
        );
        err.freebuffAdmission = body.status;
        err.retryAfterMs = body.retryAfterMs;
        throw err;
      }
      return null;
    }

    // Instance id is server-minted. Never invent one: chat gate validates it
    // against the active session row.
    const activeInstanceId = body?.instanceId || null;

    if (activeInstanceId) {
      const expiresAt = body?.expiresAt
        ? Date.parse(body.expiresAt)
        : Date.now() + 50 * 60 * 1000;
      sessionCache.set(key, {
        instanceId: activeInstanceId,
        model: body?.model || model,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 50 * 60 * 1000,
      });
      log?.debug?.(
        "FREEBUFF",
        `session active instance=${activeInstanceId} model=${body?.model || model}`,
      );
      return { instanceId: activeInstanceId, cached: false };
    }

    const err = new Error(
      `Freebuff session admission returned no active instance (${body?.status || response.status})`,
    );
    err.freebuffAdmission = body?.status || "missing_instance";
    throw err;
  }

  /**
   * Merge official Freebuff/Codebuff metadata into OpenAI body.
   * Server gates require cost_mode=free + freebuff_instance_id. run_id/client_id
   * mirror SDK defaults and keep accounting/prompt-cache identities stable.
   */
  injectSessionMetadata(body, instanceId, credentials, runId) {
    if (!instanceId) return body;
    if (!runId) {
      throw new Error("Freebuff completion requires a registered agent run ID");
    }
    const next = ensureBuffySystemOpening(body);
    const existing = next.codebuff_metadata || {};
    const connection = connectionKey(credentials);
    next.codebuff_metadata = {
      ...existing,
      freebuff_instance_id: instanceId,
      cost_mode: "free",
      run_id: runId,
      client_id:
        existing.client_id ||
        credentials?.providerSpecificData?.deviceMid ||
        credentials?.providerSpecificData?.fingerprintId ||
        `9router-${String(connection).slice(0, 40)}`,
      llm_step_number: existing.llm_step_number || "1",
    };
    return next;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const key = connectionKey(credentials);
    let attempt = 0;
    let lastResponse = null;
    let lastUrl = this.buildUrl(model, stream);
    let lastHeaders = null;
    let lastBody = body;

    while (attempt < 2) {
      attempt += 1;

      // 1) Ensure session (skip when already mid-retry with known instance).
      let instanceId = sessionCache.get(key)?.instanceId;
      if (!isLive(sessionCache.get(key), model)) {
        try {
          const session = await this.ensureSession({
            credentials,
            model,
            log,
            proxyOptions,
            signal,
          });
          instanceId = session?.instanceId || null;
        } catch (err) {
          // Admission refusal (rate limit / unavailable / auth).
          throw err;
        }
      }

      // 2) Register the first-party free-mode root agent run. The completion
      // gate resolves run_id against this row and validates agent+model pairing.
      const runId = await startAgentRun(
        credentials,
        model,
        proxyOptions,
        signal,
        log,
      );

      // 3) Build body with server-minted run/session IDs and Buffy marker.
      lastBody = this.injectSessionMetadata(body, instanceId, credentials, runId);

      // 4) POST chat/completions
      lastUrl = this.buildUrl(model, stream);
      // Official completion client sends only Authorization + user-agent.
      // Session identity belongs in `codebuff_metadata.freebuff_instance_id`,
      // not a completion header.
      lastHeaders = this.buildHeaders(credentials, stream);

      log?.debug?.(
        "FREEBUFF",
        `→ ${lastUrl} model=${model} stream=${!!stream} instance=${instanceId || "none"} run=${runId} body=${JSON.stringify(lastBody).length}B`,
      );

      try {
        lastResponse = await proxyAwareFetch(
          lastUrl,
          {
            method: "POST",
            headers: lastHeaders,
            body: JSON.stringify(lastBody),
            signal,
          },
          proxyOptions,
        );
      } catch (err) {
        await finishAgentRun(credentials, runId, "failed", proxyOptions, log);
        throw err;
      }

      // 5) Gate rejection? Drop session and retry once after re-admit.
      if (lastResponse.status >= 400 && lastResponse.status < 500) {
        const text = await lastResponse.text().catch(() => "");
        const gate = parseErrorGate(text, lastResponse.status);
        if (gate?.endsTheSession && attempt < 2) {
          log?.warn?.(
            "FREEBUFF",
            `gate ${gate.code} (${lastResponse.status}) — re-admitting session`,
          );
          await finishAgentRun(credentials, runId, "failed", proxyOptions, log);
          dropSession(key);
          continue;
        }
        // Not a gate (or non-rewritable): return the original response body
        // via a reconstructed Response so the caller still streams the error.
        const reconstructed = new Response(text, {
          status: lastResponse.status,
          statusText: lastResponse.statusText,
          headers: lastResponse.headers,
        });
        return {
          response: finishRunWithStream(reconstructed, (status) =>
            finishAgentRun(credentials, runId, status, proxyOptions, log),
          ),
          url: lastUrl,
          headers: lastHeaders,
          transformedBody: lastBody,
        };
      }

      return {
        response: finishRunWithStream(lastResponse, (status) =>
          finishAgentRun(credentials, runId, status, proxyOptions, log),
        ),
        url: lastUrl,
        headers: lastHeaders,
        transformedBody: lastBody,
      };
    }

    // Unreachable, but keep a valid return for the loop shape.
    return {
      response: lastResponse,
      url: lastUrl,
      headers: lastHeaders,
      transformedBody: lastBody,
    };
  }
}

export const __test__ = {
  sessionCache,
  dropSession,
  isLive,
  parseErrorGate,
  ENDS_THE_SESSION,
  GATE_CODES,
  SESSION_HEADER,
  MODEL_HEADER,
  WALLET_LIMIT_HEADER,
  ACTING_USER_HEADER,
};

export default FreebuffExecutor;
