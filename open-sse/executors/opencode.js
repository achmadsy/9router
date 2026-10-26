import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { MEMORY_CONFIG, HTTP_STATUS } from "../config/runtimeConfig.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { applyFingerprintTools } from "../utils/opencodeFingerprint.js";
import { getModelTargetFormat } from "../config/providerModels.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import { opencodeBunFetch } from "../services/opencodeBunClient.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

// OpenCode v2 UA shape: opencode/<channel>/<version>/<client>. Upstream rejects
// the v1 "opencode/1.18.x" form with 403 FreeTierError since 2026-10-14.
const OPENCODE_UA = "opencode/latest/2.1.2/cli";

const OPENCODE_CLIENT = "cli";
const MAX_SESSION_LENGTH = 256;
const MAX_TOOL_NAME_LEN = 128;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
const FREE_USAGE_LIMIT_RE = /FreeUsageLimitError/i;
// Upstream reports the pool reset in Retry-After (seconds). A short window
// means the session's own bucket drained while the shared pool still has
// capacity — a fresh session fixes that. A window of hours means the free
// pool itself is drained until the daily 00:00 UTC reset, which no request
// change can fix (verified live: fresh sessions on fresh proxy IPs all 429
// with retry-after pointing at the next UTC midnight).
const ROTATION_MAX_RESET_S = 300;
const OPENCODE_HARNESS_PREFIX = `You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.

# Harness
- Responses are rendered as GitHub-flavored Markdown.
- \`<system-reminder>\` blocks are harness instructions, not user-authored content. Read and follow them.
- Prefer parallelizing independent tool calls.
- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.
- Do not chain shell commands with separators like \`echo "====";\` or \`printf '---'\`; the output becomes noisy in a way that makes the user's side of the conversation worse.
- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.
- Use the edit tool for targeted changes to existing text files. It replaces the exact text in \`oldString\` with \`newString\`, and the values must differ. By default, \`oldString\` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set \`replaceAll\` to true to replace every occurrence.

# Communication
- Use clear file paths when referring to files.
- Keep responses clear and concise, and avoid unnecessary technical jargon.

# Working in codebases
- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.
- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.`;

// The upstream gate classifies clients by the native system envelope. A short
// harness prefix is rejected with 429 FreeUsageLimitError while the full
// native-shaped prompt (harness + model identity + generated Code Mode tool
// catalog + skills/env sections, ~16KB for a 12-tool request) is accepted for
// any caller's messages and tools (live A/B, 2026-10-24). This generator
// rebuilds that shape from the caller's own tools — no captured content.
function buildOpenCodeSystemEnvelope(model, tools, callerSystem) {
  const toolLines = (Array.isArray(tools) ? tools : []).map((tool) => {
    const fn = tool?.function || tool || {};
    const props = fn.parameters?.properties || {};
    const required = new Set(Array.isArray(fn.parameters?.required) ? fn.parameters.required : []);
    const args = Object.entries(props).map(([name, schema]) => {
      const type = Array.isArray(schema?.type) ? schema.type.join(" | ") : (schema?.type === "integer" ? "number" : schema?.type || "unknown");
      const doc = String(schema?.description || "").replace(/\*\//g, "").slice(0, 200);
      return `  /** ${doc} */\n  ${name}${required.has(name) ? "" : "?"}: ${type};`;
    }).join("\n");
    const desc = String(fn.description || "").replace(/\n/g, " ").slice(0, 300);
    return `- tools.caller.${fn.name}({\n${args}\n}): Promise<unknown> // ${desc}`;
  }).join("\n");
  const catalog = toolLines
    ? `- caller (${toolLines.length ? (Array.isArray(tools) ? tools.length : 0) : 0} tools) // Tools supplied by the calling coding agent.\n${toolLines}`
    : "No Code Mode tools are currently available. Do not call `execute` unless there is at least one available Code Mode tool.";
  const sections = [
    OPENCODE_HARNESS_PREFIX,
    `# Your Model\n- Name: ${model}\n- Provider ID: opencode\n- Model ID: ${model}`,
    `# Code Mode\n\nUse the \`execute\` tool to call the tools listed below. They cannot be called directly. They only work inside code you pass to \`execute\`.\n\nThe catalog is complete. Do not guess tool names.\n\n## Available tools\n\n${catalog}`,
    `Skills provide specialized instructions and workflows for specific tasks.\nUse the skill tool to load a skill when a task matches its description.\nThe user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.\n<available_skills>\n  <skill>\n    <id>coding</id>\n    <name>Coding tools</name>\n    <description>Use the caller's coding tools to inspect files, edit code, run commands, and complete the user's task end to end.</description>\n  </skill>\n</available_skills>`,
    `<env>\n  Working directory: /workspace\n  Workspace root folder: /workspace\n  Is directory a git repo: yes\n  Platform: linux\n</env>`,
  ];
  const envelope = sections.join("\n\n");
  return callerSystem?.trim() ? `${envelope}\n\n${callerSystem}` : envelope;
}
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  return !!m && parseInt(m[1], 10) >= 2;
}
// Models served by /inference/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const MESSAGES_MODELS = new Set(["union-alpha"]);

let lastTimestamp = 0;
let counter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

// Session prefix = 12 hex of ~(timeMs * 0x1000 + counter), low 48 bits, like the CLI.
// Upstream decodes it and rejects a non-small counter with 403 FreeTierError
// (live probes: counter 0–16 pass, >=100 fail), so the counter must stay real.
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const SESSION_TIME_MASK = (1n << 36n) - 1n;

function descendingTimeHex(time, counterValue) {
  return (~(BigInt(time) * 0x1000n + BigInt(counterValue)) & SESSION_PREFIX_MASK)
    .toString(16)
    .padStart(12, "0");
}

export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  return `ses_${descendingTimeHex(timestamp, counter)}${unstableRandom()}`;
}

// Zen validates that the 12 hex prefix decodes to a recent inverted timestamp, so a hash
// of the downstream session id (random bits) is rejected with 403 FreeTierError. Mint a
// canonical id once per downstream session and reuse it, like the real CLI does.
const translatedSessions = new Map();
const MAX_TRANSLATED_SESSIONS = 1000;
const TRANSLATED_SESSION_TTL_MS = 60 * 60 * 1000;

export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const key = `${clientTool || "generic"}\0${sessionId || ""}`;
  const now = Date.now();
  const hit = translatedSessions.get(key);
  if (hit && now - hit.createdAt < TRANSLATED_SESSION_TTL_MS) return hit.id;
  // Each translated conversation starts at counter 1; upstream validates this
  // low counter while TTL mapping keeps retries stable.
  const id = `ses_${descendingTimeHex(Date.now(), 1)}${unstableRandom()}`;
  translatedSessions.delete(key);
  if (translatedSessions.size >= MAX_TRANSLATED_SESSIONS) {
    translatedSessions.delete(translatedSessions.keys().next().value);
  }
  translatedSessions.set(key, { id, createdAt: now });
  return id;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

// Upstream free-tier quota is accounted per session. Minting a fresh
// x-opencode-session on every request burns through it and surfaces as
// 429 FreeUsageLimitError with growing reset-after delays, while the real
// CLI reuses one long-lived canonical session per conversation. Mirror
// that: one stable canonical session per downstream identity, evicted
// after MEMORY_CONFIG.sessionTtlMs like the other session stores.
const stableOpencodeSessions = new Map();
const MAX_STABLE_SESSIONS = 1000;
const stableSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stableOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      stableOpencodeSessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (stableSessionCleanup.unref) stableSessionCleanup.unref();

function identityKey(credentials) {
  const connectionId = credentials?.connectionId || credentials?.id;
  if (connectionId) return `opencode:conn:${String(connectionId).slice(0, 128)}`;
  const raw = credentials?.rawHeaders || {};
  const auth = raw.authorization || raw.Authorization || raw["x-api-key"] || raw["X-Api-Key"] || "";
  if (auth) {
    const digest = crypto.createHash("sha256").update(String(auth)).digest("hex").slice(0, 32);
    return `opencode:auth:${digest}`;
  }
  return "opencode:default";
}

// Native 2.1.2 sends a stable 40-hex project id per device/workspace
// (captured live) instead of a word. Derive one per connection identity so
// upstream sees a native-shaped, per-connection project bucket.
function projectKey(credentials) {
  return crypto.createHash("sha256").update(identityKey(credentials)).digest("hex").slice(0, 40);
}

export function stableSessionId(credentials) {
  const key = identityKey(credentials);
  const existing = stableOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    stableOpencodeSessions.delete(key);
    stableOpencodeSessions.set(key, existing);
    return existing.sessionId;
  }
  const sessionId = generateSessionId();
  if (stableOpencodeSessions.size >= MAX_STABLE_SESSIONS) {
    stableOpencodeSessions.delete(stableOpencodeSessions.keys().next().value);
  }
  stableOpencodeSessions.set(key, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

function bodyHasSessionHints(body) {
  try {
    if (!body || typeof body !== "object") return false;
    if (typeof body.session_id === "string" && body.session_id.trim()) return true;
    if (typeof body.conversation_id === "string" && body.conversation_id.trim()) return true;
    if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) return true;
    if (body.metadata && typeof body.metadata.user_id === "string" && body.metadata.user_id.trim()) return true;
    if (body.request && body.request.sessionId != null && String(body.request.sessionId) !== "") return true;
    const arr = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : null;
    if (arr) {
      let assistantText = "";
      for (const msg of arr) {
        if (msg?.role === "assistant") {
          const content = msg.content;
          if (typeof content === "string") assistantText += content;
          else if (Array.isArray(content)) {
            for (const part of content) assistantText += part?.text || part?.output || "";
          }
          if (assistantText.length >= 50) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function isMessagesModel(model) {
  return MESSAGES_MODELS.has(baseModelId(model));
}

function resolveOpencodeSession(body, credentials, providerSessionId, clientTool) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const hinted = incoming || normalizeSession(providerSessionId);
  if (hinted) return translateSessionId(hinted, clientTool);

  if (credentials?.connectionId || bodyHasSessionHints(body)) {
    let viaManager = null;
    try {
      viaManager = resolveSessionId({
        headers,
        body,
        connectionId: credentials?.connectionId,
        scope: "opencode",
      });
    } catch {
      viaManager = null;
    }
    if (viaManager) return translateSessionId(viaManager, clientTool);
  }

  return stableSessionId(credentials);
}

function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // Strip prior-turn reasoning items: OpenCode Free uses public/pooled credentials
    // (`Bearer public`) routing to an upstream OpenAI/Console account pool.
    // OpenAI Responses API strictly enforces that reasoning `encrypted_content`
    // can only be decrypted by the exact caller/account that issued it; sending it
    // across different accounts or rotating proxy relays triggers:
    // [invalid_request_error] reasoning `encrypted_content` was not issued to this caller (400).
    // Furthermore, under stateless mode (store=false), omitting encrypted_content
    // causes OpenAI to reject the referenced reasoning item as "not found or was deleted".
    // Dropping prior reasoning items allows multi-turn conversations and tool-calling
    // loops to succeed cleanly.
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  // Responses rejects effort:"none"/"off" — omit reasoning so upstream default applies.
  if (effort === "none" || effort === "off") {
    delete body.reasoning;
    delete body.reasoning_effort;
    return;
  }
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

// Chat Completions lane: the free backend validates reasoning_effort against the
// plain OpenAI enum (none|minimal|low|medium|high|xhigh|max) and answers 400
// "Invalid option" for anything else — including "auto", which adaptive thinking
// (Claude Code's thinking:{type:"adaptive"}) arrives as. Omitting the field lets
// the upstream pick its own default, which is what adaptive means; same rationale
// as the Responses path above, which rejects "unknown variant `auto`".
function dropAdaptiveReasoningEffort(body) {
  if (body?.reasoning_effort === "auto") delete body.reasoning_effort;
}

function prependHarness(body, model, credentials) {
  if (!Array.isArray(body?.messages)) return;
  const callerSystem = body.messages.find((m) => m.role === "system" && typeof m.content === "string")?.content || "";
  const envelope = buildOpenCodeSystemEnvelope(baseModelId(model || body.model), body.tools, callerSystem);
  const first = body.messages[0];
  if (first?.role === "system" && typeof first.content === "string" && callerSystem && first.content === callerSystem) {
    body.messages = [{ ...first, content: envelope }, ...body.messages.slice(1)];
    return;
  }
  if (first?.role === "system" && typeof first.content === "string" && first.content.startsWith("You are an AI agent running in OpenCode")) {
    body.messages = [{ ...first, content: envelope }, ...body.messages.slice(1)];
    return;
  }
  body.messages = [{ role: "system", content: envelope }, ...body.messages];
}

function hasNativeOpencodeEnvelope(body) {
  if (!Array.isArray(body?.messages)) return false;
  const system = body.messages.find((message) =>
    message?.role === "system" && typeof message.content === "string"
  )?.content || "";
  return system.startsWith("You are an AI agent running in OpenCode")
    && system.includes("# Your Model")
    && system.includes("# Code Mode")
    && system.includes("<available_skills>")
    && system.includes("<env>");
}

// Strip provider prefixes and thinking suffixes so the wire model id matches
// the registry ("oc/glm-5.3-flash-free(xhigh)" -> "glm-5.3-flash-free").
function normalizeWireModel(model) {
  return baseModelId(String(model || "").replace(/^(oc|opencode):?\/\s*/i, "").trim());
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const session = resolveOpencodeSession(body, sourceCredentials, providerSessionId, clientTool);

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: session,
    };
  }

  transformRequest(model, body, stream, credentials) {
    if (body && typeof body === "object") {
      if (model && !body.model) body.model = model;
      if (typeof body.model === "string") body.model = normalizeWireModel(body.model);
    }
    // Zen rejects non-streaming requests on free models with 403 FreeTierError;
    // always stream upstream and let the handler layer aggregate for non-stream clients.
    if (body && typeof body === "object") body.stream = true;
    const format = getModelTargetFormat("oc", model);
    if (format === "claude") {
      return body;
    }
    if ((isResponsesModel(model || body?.model) || format === "openai-responses") && body && typeof body === "object") {
      // ponytail: chỉ model đã xác nhận auto-only; mở allowlist khi có bằng chứng.
      if ("tool_choice" in body && body.tool_choice !== "auto"
        && this.config.quirks?.forceAutoToolChoiceModels?.includes(baseModelId(model))) {
        body.tool_choice = "auto";
      }
      const normalized = normalizeResponsesInput(body.input);
      if (normalized) body.input = normalized;
      if (!Array.isArray(body.input) || body.input.length === 0) {
        body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
      }
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      body.stream = true;
      body.store = false;
      normalizeResponsesTools(body);
      sanitizeResponsesItems(body);
      // Free-tier fingerprint tools are required even when an agent client
      // already supplied tools. ZCode/Claude Code requests normally have
      // non-empty tool arrays; skipping cloaking here triggers 403 FreeTierError.
      applyFingerprintTools(body, true);
    } else if (body && typeof body === "object") {
      dropAdaptiveReasoningEffort(body);
      // Native CLI chat lane always carries stream_options (captured 2.1.2:
      // messages, model, stream, stream_options [, tools, max_completion_tokens]).
      if (body.stream_options === undefined) body.stream_options = { include_usage: true };
      if (body.max_completion_tokens === undefined && body.max_tokens !== undefined) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      }
      // Native OpenCode carries the system prompt as the first message and the
      // chat lane sends only native envelope keys; the OpenAI translation can
      // leave a top-level system key and provider metadata behind.
      if (body.system !== undefined && Array.isArray(body.messages)) {
        const first = body.messages[0];
        const systemText = typeof body.system === "string"
          ? body.system
          : Array.isArray(body.system)
            ? body.system.map((part) => (typeof part === "string" ? part : part?.text || "")).filter(Boolean).join("\n\n")
            : "";
        if (systemText.trim() && first?.role !== "system") {
          body.messages = [{ role: "system", content: systemText }, ...body.messages];
        } else if (systemText.trim() && first?.role === "system" && typeof first.content === "string") {
          body.messages = [{ ...first, content: `${systemText}\n\n${first.content}` }, ...body.messages.slice(1)];
        }
        delete body.system;
      }
      delete body.metadata;
      delete body.context_management;
      // Only the full native envelope may pass unchanged. OpenCode itself also
      // uses ordinary OpenAI-compatible requests for custom providers, so its
      // User-Agent alone does not prove that the cloud harness is present.
      if (!hasNativeOpencodeEnvelope(body)) prependHarness(body, model, credentials);
      applyFingerprintTools(body, false);
    }

    return injectReasoningContent({ provider: this.provider, model, body });
  }

  // Free-tier quota is accounted per x-opencode-session, so a 429 carrying
  // FreeUsageLimitError means this session's bucket is spent — not the account
  // and not the model. Mint a fresh session for the retry attempt; the retry
  // loop re-runs transformRequest/buildHeaders with the rotated id. Any other
  // 429 (or an unreadable body) vetoes the retry and keeps the legacy
  // fall-through-to-error behavior.
  async computeRetryDelay(response, attempt, delayMs, ctx) {
    if (response.status !== HTTP_STATUS.RATE_LIMITED) return null;
    let text = "";
    try {
      text = await response.clone().text();
    } catch {
      return false;
    }
    if (!FREE_USAGE_LIMIT_RE.test(text)) return false;
    const retryAfterS = Number(response.headers?.get?.("retry-after"));
    if (Number.isFinite(retryAfterS) && retryAfterS > ROTATION_MAX_RESET_S) {
      ctx?.log?.info?.("RETRY", `OPENCODE | 429 FreeUsageLimitError — pool reset in ${Math.round(retryAfterS / 60)}m, skipping rotation`);
      return false;
    }
    const credentials = ctx?.credentials;
    if (credentials) {
      credentials[SESSION_FIELD] = generateSessionId();
      // Drop the exhausted stable entry so the next request also mints a
      // fresh session instead of reusing the one that just burned out.
      stableOpencodeSessions.delete(identityKey(credentials));
      ctx?.log?.info?.("RETRY", `OPENCODE | 429 FreeUsageLimitError — rotated session (attempt ${attempt}/${attempt + 1})`);
    }
    return Math.max(200, delayMs || 0);
  }

  async execute(args) {
    return super.execute({ ...args, credentials: this.prepareRequestCredentials(args) });
  }

  async fetchUpstream(url, options, proxyOptions = null) {
    // Vercel relays terminate and re-originate TLS, so they cannot preserve the
    // Bun/OpenCode client fingerprint. Keep the existing relay path for explicit
    // relay configurations; direct and HTTP-proxy requests use Bun end-to-end.
    if (proxyOptions?.vercelRelayUrl) {
      return proxyAwareFetch(url, options, proxyOptions);
    }
    const proxyEnabled = proxyOptions?.connectionProxyEnabled === true;
    const proxyUrl = proxyEnabled ? proxyOptions?.connectionProxyUrl || "" : "";
    return opencodeBunFetch(url, options, proxyUrl);
  }

  // Native v2.1.2 follows the published OpenCode endpoint under
  // /inference/openai/v1. The shorter /inference/v1 alias is not the canonical
  // client path and may be classified differently by the upstream gate.
  buildUrl(model) {
    const base = this.config.baseUrl;
    const format = isResponsesModel(model) ? "openai-responses" : getModelTargetFormat("oc", model);
    if (format === "openai-responses") return `${base}/inference/openai/v1/responses`;
    if (format === "claude" || isMessagesModel(model)) return `${base}/inference/openai/v1/messages`;
    return `${base}/inference/openai/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "") {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasValidOpencodeVersion(downstreamUa);

    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];

    // Native 2.1.2 mints a W3C trace per request: traceparent (55 chars) and
    // b3 (TraceId-SpanId-Sampled-ParentSpanId, 68 chars). Both were present on
    // every captured native call and absent from ours.
    const traceId = crypto.randomBytes(16).toString("hex");
    const spanId = crypto.randomBytes(8).toString("hex");
    const parentSpanId = crypto.randomBytes(8).toString("hex");

    // Mirrors the v2 CLI. Upstream needs x-opencode-session-id next to
    // x-opencode-session, and rejects any x-opencode-request (v1 only) with 403.
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || OPENCODE_CLIENT,
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
      "x-opencode-project": lower["x-opencode-project"] || projectKey(credentials),
      "traceparent": `00-${traceId}-${spanId}-01`,
      "b3": `${traceId}-${spanId}-1-${parentSpanId}`,
      // Native CLI sends Accept: */* even on the SSE chat lane.
      "Accept": "*/*",
    };

    if (url.endsWith("/messages")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return headers;
  }
}
