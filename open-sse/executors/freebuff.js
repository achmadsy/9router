import { BaseExecutor } from "./base.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { createHash, randomUUID } from "node:crypto";

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
const WEBSITE_URL = "https://www.codebuff.com";
// codebuff.com 307-redirects to www. — native fetch drops Authorization on
// cross-host redirects, so hardcode www. Direct Auth keeps the token.
const AGENT_RUNS_URL = "https://www.codebuff.com/api/v1/agent-runs";
const FREEBUFF_SYSTEM_OPENING = "You are Buffy, the strategic coding assistant.";
const NINEROUTER_SELF_AWARENESS =
  "This request is routed by 9Router through the Freebuff provider. Preserve the caller's requested task and response format; do not claim to be the Freebuff CLI application or to have local tools unless those tools were explicitly supplied.";

// Canonical first-party roots from freebuff/common/src/constants/free-agents.ts
// (FREEBUFF_ROOT_AGENT_ID_BY_MODEL). Model+root pairing is enforced server-side
// (`free_mode_invalid_agent_model`); an unmapped model falls back to the bare
// `base2-free` root exactly like upstream's legacy-caller fallback.
const ROOT_AGENT_BY_MODEL = {
  "mimo/mimo-v2.5": "base2-free-mimo",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "openai/gpt-5.6-luna-es": "base2-free-luna-es",
  "upstage/solar-pro4": "base2-free-solar-pro4",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "z-ai/glm-5.2": "base2-free-glm",
  "z-ai/glm-5.3-flash": "base2-free-glm-5-3-flash",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "anthropic/claude-fable-5": "base2-free-fable",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
  "meta/muse-spark-1.3-contributor": "base2-free-muse-spark-1-3",
  "stealth/ox-alpha": "base2-free-ox-alpha",
  "google/gemini-3.8-flash": "base2-free-gemini-3-8-flash",
};

// Child (sub-agent) run agent ids. The backend enforces same-session model
// pairing on subagents too (session_model_mismatch), so each root spawns its
// own-model reviewer — free-agents.ts FREEBUFF_REVIEWER_AGENT_ID_BY_MODEL.
// Unmapped models fall back to code-reviewer-deepseek-flash, which upstream
// allows in every free session.
const REVIEWER_AGENT_BY_MODEL = {
  "mimo/mimo-v2.5": "code-reviewer-mimo",
  "minimax/minimax-m3": "code-reviewer-minimax-m3",
  "openai/gpt-5.6-luna": "code-reviewer-luna",
  "upstage/solar-pro4": "code-reviewer-solar-pro4",
  "deepseek/deepseek-v4-pro": "code-reviewer-deepseek",
  "deepseek/deepseek-v4-flash": "code-reviewer-deepseek-flash",
  "z-ai/glm-5.2": "code-reviewer-glm",
  "z-ai/glm-5.3-flash": "code-reviewer-glm-5-3-flash",
  "anthropic/claude-fable-5": "code-reviewer-fable",
  "stealth/ox-alpha": "code-reviewer-ox-alpha",
  "google/gemini-3.8-flash": "code-reviewer-gemini-3-8-flash",
  "meta/muse-spark-1.2-contributor": "code-reviewer-muse-spark",
  "meta/muse-spark-1.3-contributor": "code-reviewer-muse-spark-1-3",
};
const FALLBACK_REVIEWER_AGENT_ID = "code-reviewer-deepseek-flash";

// --- Wire cadences (upstream constants, freebuff-models.ts / use-gravity-ad.ts) ---
// Liveness beat: GET /session with x-freebuff-heartbeat: 1 every 45s.
const HEARTBEAT_INTERVAL_MS = 45_000;
// Ad auction rotation: POST /api/v1/ads every 60s while a session is live.
const AD_ROTATION_INTERVAL_MS = 60_000;
// Impression ack waits this long after showing — the CLI renders the card
// first; 9router suppresses display but keeps the measured delay shape.
const AD_IMPRESSION_DELAY_MS = 1_000;
// Browser-like UA ad providers require for targeting/bot filtering
// (common/src/util/ad-user-agent.ts, Chrome 151).
const AD_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const AD_SLOT_PLACEMENT_ID = "Single-Ad-Unit-1";
const AD_IMPRESSION_DEDUP_MAX = 500;
const COMPACT_SESSION_HEADER = "x-freebuff-compact-session";
const HEARTBEAT_HEADER = "x-freebuff-heartbeat";
const FREEBUFF_EVENT_ID_HEADER = "X-Freebuff-Event-Id";
// Engaged-time heartbeat: one PRODUCT_ACTIVE_MINUTE per active minute,
// mirrored to POST /api/logs like every CLI analytics event.
const ENGAGEMENT_INTERVAL_MS = 60_000;
const ENGAGEMENT_IDLE_THRESHOLD_MS = 5 * 60_000;
/** Max ads acknowledged per logical session (upstream pauses after 3). */
const MAX_ADS_PER_SESSION = 3;

/** @type {Set<string>} impUrls already acknowledged this process. */
const adImpressionsFired = new Set();

/** @type {Set<string>} instance ids with keepalive/ad/engagement timers running. */
const runLifecycleTimers = new Set();

/**
 * Engagement heartbeat, upstream EngagementTracker semantics: emit one event
 * per 60s tick only while the connection is "active" (activity refreshed by
 * every request through the executor). Mirrored to /api/logs, never PostHog
 * (9router has no PostHog credentials; the server accepts anonymous records).
 */
function startEngagementHeartbeat({ token, proxyOptions, log, isActive }) {
  const engagementSessionId = randomUUID();
  let lastActivity = Date.now();
  let stopped = false;
  const touch = () => {
    lastActivity = Date.now();
  };
  const timer = setInterval(async () => {
    if (stopped) return;
    if (Date.now() - lastActivity >= ENGAGEMENT_IDLE_THRESHOLD_MS) return;
    if (isActive && !isActive()) return;
    try {
      const response = await proxyAwareFetch(
        `${WEBSITE_URL}/api/logs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            records: [
              {
                level: "info",
                event: "product_active_minute",
                message: "product_active_minute",
                surface: "cli",
                // Stable per connection, not per event — upstream emits one
                // id per CLI sitting (createEngagementSessionId), so a single
                // sitting's minutes group under one id.
                engagement_session_id: engagementSessionId,
                data: { surface: "cli" },
              },
            ],
          }),
          signal: AbortSignal.timeout(5_000),
        },
        proxyOptions,
      );
      await response.body?.cancel?.().catch?.(() => {});
    } catch (err) {
      log?.debug?.(
        "FREEBUFF",
        `engagement heartbeat failed (non-fatal): ${err?.message || err}`,
      );
    }
  }, ENGAGEMENT_INTERVAL_MS);
  timer.unref?.();
  return { touch, stop: () => { stopped = true; clearInterval(timer); } };
}

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
    "https://www.codebuff.com/api/v1/freebuff/session/admission"
  );
}

function sessionUrl() {
  return oauthConfig().sessionUrl || "https://www.codebuff.com/api/v1/freebuff/session";
}

/** @type {Map<string, { instanceId: string, model: string, expiresAt: number }>} */
const sessionCache = new Map();

/** @type {Map<string, string>} connection key → stable chat-session id for ad auctions. */
const adSessionIds = new Map();

/** @type {Map<string, { count: number }>} runId → llm_step_number counter. */
const runStepCounters = new Map();
const MAX_STEP_COUNTER_RUNS = 1_000;

function isLive(entry, model, now = Date.now()) {
  if (!entry?.instanceId) return false;
  // ~30s buffer before server expiry.
  if (entry.expiresAt && now + 30_000 >= entry.expiresAt) return false;
  if (model && entry.model && entry.model !== model) return false;
  return true;
}

function dropSession(key) {
  sessionCache.delete(key);
  // A dropped session means re-admission on a possibly different account or
  // model; the ad chat-session id follows the login the way the native
  // chatSessionId follows a conversation, so reset it here too.
  adSessionIds.delete(key);
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

function reviewerAgentForModel(model) {
  return REVIEWER_AGENT_BY_MODEL[model] || FALLBACK_REVIEWER_AGENT_ID;
}

/**
 * POST /api/v1/agent-runs action=START.
 * `ancestorRunIds` makes this a CHILD run: upstream passes
 * `[...parentAncestors, parentRunId]`, which is what the backend reads to
 * place the run in the hierarchy (root run → sub-agent run → …).
 */
async function startAgentRun(
  credentials,
  model,
  proxyOptions,
  signal,
  log,
  { agentId, ancestorRunIds = [] } = {},
) {
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
        agentId: agentId || rootAgentForModel(model),
        ancestorRunIds,
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

async function finishAgentRun(
  credentials,
  runId,
  status,
  proxyOptions,
  log,
  { totalSteps = 1, directCredits = 0, totalCredits = 0, errorMessage, steps = [] } = {},
) {
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
          totalSteps,
          directCredits,
          totalCredits,
          // Upstream truncates to 5000 chars; a stack trace must not flood the ledger.
          errorMessage:
            errorMessage === undefined
              ? undefined
              : String(errorMessage).slice(0, 5000),
          steps,
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

/**
 * One `addAgentStep` equivalent: upstream records a ledger row per LLM step
 * with its credits, the child runs it spawned, and the answering message id.
 * 9router cannot know per-step token costs (the gateway meters sessions), so
 * credits stay unset exactly like upstream's optional field.
 */
function makeAgentStep({ stepNumber, childRunIds = [], messageId = null, startTime }) {
  return {
    id: randomUUID(),
    stepNumber,
    childRunIds,
    messageId,
    status: "completed",
    startTime: (startTime || new Date()).toISOString(),
  };
}

/**
 * Spawn the reviewer sub-agent run the root is expected to produce, wired per
 * upstream spawn-agent-utils: ancestorRunIds = [...rootAncestors, rootRunId],
 * and the parent's FINISH steps reference the child's runId via childRunIds.
 * Fire-and-forget at the inference boundary — the completion gate only needs
 * the root run to exist and resolve; the child run exists so the hierarchy
 * view and the parent's step rows mirror a native turn.
 */
async function spawnChildAgentRun(
  credentials,
  model,
  rootRunId,
  proxyOptions,
  log,
) {
  try {
    const childRunId = await startAgentRun(
      credentials,
      model,
      proxyOptions,
      null,
      log,
      {
        agentId: reviewerAgentForModel(model),
        // Upstream: [...parentAgentState.ancestorRunIds, parentAgentState.runId]
        ancestorRunIds: [rootRunId],
      },
    );
    log?.debug?.(
      "FREEBUFF",
      `child agent run started parent=${rootRunId} child=${childRunId}`,
    );
    return childRunId;
  } catch (err) {
    // A failed child spawn must never fail the user's completion.
    log?.warn?.(
      "FREEBUFF",
      `child agent run spawn failed (non-fatal): ${err?.message || err}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session keepalive + ads telemetry (native wire, display suppressed)
// ---------------------------------------------------------------------------

/** Periodic compact GET /session beat. Marks the row's last_seen so a live
 *  9router connection is never swept for going quiet, exactly like the CLI's
 *  30s poll (compact omits quota blocks already snapshotted at admission). */
function startSessionHeartbeat(credentials, instanceId, proxyOptions, log) {
  const token = credentials?.accessToken || credentials?.apiKey;
  const timer = setInterval(async () => {
    try {
      const response = await proxyAwareFetch(
        sessionUrl(),
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            [SESSION_HEADER]: instanceId,
            [COMPACT_SESSION_HEADER]: "1",
            [HEARTBEAT_HEADER]: "1",
          },
          signal: AbortSignal.timeout(20_000),
        },
        proxyOptions,
      );
      await response.body?.cancel?.().catch?.(() => {});
    } catch (err) {
      log?.debug?.("FREEBUFF", `session heartbeat failed: ${err?.message || err}`);
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

/**
 * Native ad auction: POST /api/v1/ads with the exact upstream body — session
 * message context, device info, browser-like UA, surface cli_chat, the CLI
 * placement ids. The response is never rendered: 9router has no ad rail, so
 * cards are dropped on receipt (suppression at the last responsible moment —
 * upstream's billing-relevant calls all still happen).
 */
async function fetchAdNatively({ credentials, instanceId, adSessionId, body, proxyOptions, log }) {
  const token = credentials?.accessToken || credentials?.apiKey;
  const history = Array.isArray(body?.messages) ? body.messages : [];
  const adMessages = history
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .slice(-12)
    .map((m) => ({
      role: m.role,
      content:
        m.role === "user" && typeof m.content === "string"
          ? `<user_message>${m.content}</user_message>`
          : typeof m.content === "string"
            ? m.content
            : "",
    }))
    .filter((m) => m.content);

  try {
    const response = await proxyAwareFetch(
      `${WEBSITE_URL}/api/v1/ads`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": AD_USER_AGENT,
        },
        body: JSON.stringify({
          provider: "gravity",
          messages: adMessages,
          // Native sends useChatStore().chatSessionId (the chat thread id,
          // stable per conversation) — NOT the freebuff instance id.
          sessionId: adSessionId,
          device: { os: "linux", timezone: "UTC", locale: "en-US" },
          surface: "cli_chat",
          placementId: AD_SLOT_PLACEMENT_ID,
          userAgent: AD_USER_AGENT,
        }),
        signal: AbortSignal.timeout(20_000),
      },
      proxyOptions,
    );
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {});
      return null;
    }
    const data = await response.json().catch(() => null);
    return Array.isArray(data?.ads) && data.ads.length > 0 ? data.ads : null;
  } catch (err) {
    log?.debug?.("FREEBUFF", `ad fetch failed (non-fatal): ${err?.message || err}`);
    return null;
  }
}

/**
 * Native impression ack for a served ad. 9router suppresses the DISPLAY but
 * keeps the exact wire the native client fires: POST /api/v1/ads/impression
 * with impUrl, mode, browser-like UA and OS, one X-Freebuff-Event-Id per
 * logical event. Fired after the measured render delay, best-effort.
 */
async function recordAdImpressionNatively(ad, credentials, proxyOptions, log) {
  const token = credentials?.accessToken || credentials?.apiKey;
  const impUrl = ad?.impUrl;
  if (!impUrl || !token) return;
  const clientEventId = randomUUID();
  try {
    const response = await proxyAwareFetch(
      `${WEBSITE_URL}/api/v1/ads/impression`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": AD_USER_AGENT,
          [FREEBUFF_EVENT_ID_HEADER]: clientEventId,
        },
        body: JSON.stringify({
          impUrl,
          // Native body carries the CLI's agentMode, which on Freebuff is
          // always 'LITE' (chat-store.ts:208) — not the cost_mode string.
          mode: "LITE",
          userAgent: AD_USER_AGENT,
          os: "linux",
          clientEventId,
        }),
        signal: AbortSignal.timeout(20_000),
      },
      proxyOptions,
    );
    await response.body?.cancel?.().catch?.(() => {});
  } catch (err) {
    log?.debug?.("FREEBUFF", `ad impression failed (non-fatal): ${err?.message || err}`);
  }
}

/** Run the ad cycle for a live session: auction now, acknowledge the first
 *  creative after the render delay, re-auction every 60s. Returns a stop fn.
 *  Ads shown: none — every payload is discarded after the wire call. */
function startAdCycle({ credentials, instanceId, adSessionId, body, proxyOptions, log }) {
  let stopped = false;
  const timers = [];
  const runOnce = async () => {
    if (stopped) return;
    const ads = await fetchAdNatively({ credentials, instanceId, adSessionId, body, proxyOptions, log });
    if (stopped || !ads?.length) return;
    const first = ads[0];
    if (first?.impUrl && !adImpressionsFired.has(first.impUrl)) {
      adImpressionsFired.add(first.impUrl);
      if (adImpressionsFired.size > AD_IMPRESSION_DEDUP_MAX) {
        // Bound the set; oldest insertions are the least likely to recur.
        adImpressionsFired.delete(adImpressionsFired.values().next().value);
      }
      const t = setTimeout(
        () => void recordAdImpressionNatively(first, credentials, proxyOptions, log),
        AD_IMPRESSION_DELAY_MS,
      );
      t.unref?.();
      timers.push(t);
    }
  };
  void runOnce();
  const rotation = setInterval(() => void runOnce(), AD_ROTATION_INTERVAL_MS);
  rotation.unref?.();
  timers.push(rotation);
  return () => {
    stopped = true;
    for (const t of timers) clearInterval(t);
  };
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
      // (sdk/src/impl/model-provider.ts) where VERSION is the llm-providers
      // package version build-injected; 1.0.0 matches the published package.
      "user-agent": "ai-sdk/openai-compatible/1.0.0/codebuff",
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
   * Merge order is upstream-load-bearing (sdk/src/impl/llm.ts
   * getProviderOptions): caller keys first, reserved identifiers overwrite.
   */
  injectSessionMetadata(body, instanceId, credentials, runId) {
    if (!instanceId) return body;
    if (!runId) {
      throw new Error("Freebuff completion requires a registered agent run ID");
    }
    const next = ensureBuffySystemOpening(body);
    const existing = next.codebuff_metadata || {};
    const connection = connectionKey(credentials);
    // Per-run step counter: upstream increments llm_step_number for every LLM
    // call inside one run (run-agent-step.ts llmStepNumber++); each 9router
    // request is one step of its freshly-registered run.
    const stepCounters = runStepCounters.get(runId) ?? { count: 0 };
    stepCounters.count += 1;
    runStepCounters.set(runId, stepCounters);
    if (runStepCounters.size > MAX_STEP_COUNTER_RUNS) {
      // Bound the map; runs are short-lived and evicted on FINISH anyway.
      runStepCounters.delete(runStepCounters.keys().next().value);
    }
    next.codebuff_metadata = {
      ...existing,
      freebuff_instance_id: instanceId,
      cost_mode: "free",
      run_id: runId,
      client_id:
        existing.client_id ||
        credentials?.providerSpecificData?.deviceMid ||
        credentials?.providerSpecificData?.fingerprintId ||
        // Native clientSessionId is a random base36 run id (run.ts:838), so
        // this last-resort fallback is shape-matched, not brand-prefixed.
        Math.random().toString(36).substring(2, 15),
      llm_step_number: String(stepCounters.count),
    };
    return next;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const key = connectionKey(credentials);
    // Ad-session identity: upstream sends useChatStore().chatSessionId —
    // stable per conversation thread, distinct from the freebuff instance id.
    let adSessionId = adSessionIds.get(key);
    if (!adSessionId) {
      adSessionId = randomUUID();
      adSessionIds.set(key, adSessionId);
    }
    let attempt = 0;
    let lastResponse = null;
    let lastUrl = this.buildUrl(model, stream);
    let lastHeaders = null;
    let lastBody = body;

    while (attempt < 2) {
      attempt += 1;

      // 1) Ensure session (skip when already mid-retry with known instance).
      let instanceId = sessionCache.get(key)?.instanceId;
      let sessionWasCached = true;
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
          sessionWasCached = Boolean(session?.cached);
        } catch (err) {
          // Admission refusal (rate limit / unavailable / auth).
          throw err;
        }
      }

      // Native client behavior per live session: keepalive beat + ad cycle.
      // Both are started once per session instance and torn down with the run.
      let heartbeat = null;
      let engagement = null;
      let stopAds = null;
      if (instanceId && !runLifecycleTimers.has(instanceId)) {
        runLifecycleTimers.add(instanceId);
        heartbeat = startSessionHeartbeat(credentials, instanceId, proxyOptions, log);
        engagement = startEngagementHeartbeat({
          token: credentials?.accessToken || credentials?.apiKey,
          proxyOptions,
          log,
        });
        stopAds = startAdCycle({
          credentials,
          instanceId,
          adSessionId,
          body,
          proxyOptions,
          log,
        });
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

      // 3) Spawn the reviewer child run (native hierarchy: root → sub-agent).
      // Non-fatal: hierarchy only mirrors a native turn; a failed spawn must
      // not break the user's completion.
      const childRunId = await spawnChildAgentRun(
        credentials,
        model,
        runId,
        proxyOptions,
        log,
      );

      // 4) Build body with server-minted run/session IDs and Buffy marker.
      lastBody = this.injectSessionMetadata(body, instanceId, credentials, runId);

      // 5) POST chat/completions
      lastUrl = this.buildUrl(model, stream);
      // Official completion client sends only Authorization + user-agent.
      // Session identity belongs in `codebuff_metadata.freebuff_instance_id`,
      // not a completion header.
      lastHeaders = this.buildHeaders(credentials, stream);

      log?.debug?.(
        "FREEBUFF",
        `→ ${lastUrl} model=${model} stream=${!!stream} instance=${instanceId || "none"} run=${runId}${childRunId ? ` child=${childRunId}` : ""} body=${JSON.stringify(lastBody).length}B`,
      );

      const stepStartTime = new Date();
      const rootSteps = [makeAgentStep({
        stepNumber: 1,
        childRunIds: childRunId ? [childRunId] : [],
        messageId: null,
        startTime: stepStartTime,
      })];
      const finishAll = async (status) => {
        engagement?.stop();
        if (childRunId) {
          // Child finishes first, like upstream (subagent loop completes
          // before the parent's final addAgentStep/finishAgentRun).
          await finishAgentRun(credentials, childRunId, status, proxyOptions, log, {
            totalSteps: 1,
            steps: [makeAgentStep({
              stepNumber: 1,
              childRunIds: [],
              messageId: null,
              startTime: stepStartTime,
            })],
          });
        }
        await finishAgentRun(credentials, runId, status, proxyOptions, log, {
          totalSteps: 1,
          steps: rootSteps,
        });
        runStepCounters.delete(runId);
        if (heartbeat) clearInterval(heartbeat);
        if (stopAds) stopAds();
        if (instanceId && !isLive(sessionCache.get(key), model)) {
          runLifecycleTimers.delete(instanceId);
        }
      };

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
        await finishAll("failed");
        throw err;
      }

      // 6) Gate rejection? Drop session and retry once after re-admit.
      if (lastResponse.status >= 400 && lastResponse.status < 500) {
        const text = await lastResponse.text().catch(() => "");
        const gate = parseErrorGate(text, lastResponse.status);
        if (gate?.endsTheSession && attempt < 2) {
          log?.warn?.(
            "FREEBUFF",
            `gate ${gate.code} (${lastResponse.status}) — re-admitting session`,
          );
          await finishAll("failed");
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
          response: finishRunWithStream(reconstructed, finishAll),
          url: lastUrl,
          headers: lastHeaders,
          transformedBody: lastBody,
        };
      }

      return {
        response: finishRunWithStream(lastResponse, finishAll),
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
  ROOT_AGENT_BY_MODEL,
  REVIEWER_AGENT_BY_MODEL,
  makeAgentStep,
  reviewerAgentForModel,
  rootAgentForModel,
};

export default FreebuffExecutor;
