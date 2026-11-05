import { AsyncLocalStorage } from "node:async_hooks";
import { DefaultExecutor } from "./default.js";
import zcodeConfig from "../../src/lib/zcode/config.js";
import { GLM_CODING_PLAN_MODEL_MAP, GLM_EFFORT_MODELS } from "../../src/lib/zcode/constants.js";
import { FORMATS } from "../translator/formats.js";
import { injectZcodeSystemPrompt } from "../../src/lib/zcode/systemPrompt.js";
import { capCacheControlBlocks } from "../translator/formats/claude.js";
import { isZaiStartPlan, isZaiAccountCodingPlan, normalizeZaiCredentials } from "../../src/lib/zcode/access.js";
import { getZcodeProjectToken, invalidateZcodeProjectToken } from "../../src/lib/zcode/provisioning.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { GLM_ACTIVITY_BLOCK, GLM_VERIFICATION_REQUIRED } from "../config/errorConfig.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  getCaptchaManager,
  isCaptchaError,
} from "../../src/lib/zcode/captcha-service.js";
import {
  applyZcodeApiKeyHeaders,
  applyZcodeCodingPlanHeaders,
  buildZcodeAnthropicMetadataUserId,
} from "../../src/lib/zcode/headers.js";

/** Compatibility model predicate; entitlement selection is separate. */
const START_PLAN_MODELS = new Set(GLM_EFFORT_MODELS);

function isStartPlanModel(model) {
  if (!model) return false;
  const id = String(model).toLowerCase();
  if (START_PLAN_MODELS.has(id)) return true;
  // Accept "provider/model" and upstream aliases
  const bare = id.includes("/") ? id.split("/").pop() : id;
  return START_PLAN_MODELS.has(bare);
}

/** Per-request context — avoids singleton executor cross-request credential races. */
export const glmRequestContext = new AsyncLocalStorage();

function getGlmRequestContext() {
  return glmRequestContext.getStore();
}

export class GlmExecutor extends DefaultExecutor {
  constructor() {
    super("glm");
  }

  isStartPlanRequest(model = null) {
    const ctxModel = model ?? getGlmRequestContext()?.model;
    return ctxModel != null && isStartPlanModel(ctxModel);
  }

  usesCodingPlan(credentials) {
    // Paid plans obtain their own request-scoped project token in execute;
    // neither a login JWT nor the business token is their inference credential.
    return isZaiAccountCodingPlan(credentials) ||
      (isZaiStartPlan(credentials) && !!credentials?.providerSpecificData?.zcodeJwtToken);
  }

  usesApiKeyOnly(credentials) {
    return !!credentials?.apiKey && !this.usesCodingPlan(credentials);
  }

  /** 400/403 on Start Plan = captcha gate (code 3007 / "captcha verify failed"). */
  isCaptchaResponse(status, response) {
    if (status !== 400 && status !== 403) return false;
    return isCaptchaError(response);
  }

  getUrlIndex() {
    return getGlmRequestContext()?.urlIndex ?? 0;
  }

  usesZcodeApiKeyUpstream(credentials) {
    const urlIndex = this.getUrlIndex();
    return (
      this.usesApiKeyOnly(credentials) ||
      (this.usesCodingPlan(credentials) && urlIndex === 1)
    );
  }

  canFallbackToApiKey() {
    // Plan selection is explicit; a failure must not spend a different entitlement.
    return false;
  }

  getFallbackCount() {
    return 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const ctx = getGlmRequestContext();
    if (ctx) ctx.urlIndex = urlIndex;

    // Explicit account plans use the native Anthropic endpoint with a
    // plan-scoped inference token (login JWT for Start, project token for paid).
    if (this.usesCodingPlan(credentials) && urlIndex === 0) {
      return zcodeConfig.codingPlanUrl;
    }

    // Fallback / API-key path: respect multi-transport (openai → coding/paas,
    // claude → api.z.ai anthropic) instead of forcing anthropic for every format.
    if (this.usesApiKeyOnly(credentials) || this.canFallbackToApiKey(credentials)) {
      const rt = credentials?.runtimeTransport;
      if (rt?.baseUrl) {
        return rt.urlSuffix ? `${rt.baseUrl}${rt.urlSuffix}` : rt.baseUrl;
      }
      const sourceFormat =
        credentials?.runtimeTransport?.format ||
        (this.config?.format === "claude" ? "claude" : "openai");
      if (sourceFormat === "claude") {
        return zcodeConfig.apiKeyFallbackUrl;
      }
      return zcodeConfig.openaiCodingUrl || zcodeConfig.apiKeyFallbackUrl;
    }

    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    if (!transformed || typeof transformed !== "object") return transformed;

    const modelId = transformed.model || model;
    if (typeof modelId !== "string") return transformed;

    const bareId = modelId.includes("/") ? modelId.split("/").pop() : modelId;
    const mapped =
      GLM_CODING_PLAN_MODEL_MAP[bareId.toLowerCase()] ||
      getModelUpstreamId("glm", modelId) ||
      GLM_CODING_PLAN_MODEL_MAP[modelId.toLowerCase()] ||
      modelId;

    if (mapped !== modelId) {
      transformed.model = mapped;
    }

    const originalEffort = getGlmRequestContext()?.effort;
    const anthropic = !credentials?.runtimeTransport || credentials.runtimeTransport.format === FORMATS.CLAUDE;
    if (anthropic && (this.usesCodingPlan(credentials) || isZaiAccountCodingPlan(credentials)) && this.getUrlIndex() === 0) {
      if (START_PLAN_MODELS.has(bareId.toLowerCase())) {
        const budget = transformed.thinking?.budget_tokens;
        const selectedEffort = originalEffort || body.output_config?.effort || body.reasoning_effort
          || (Number.isFinite(budget) ? (budget >= 32000 ? "max" : budget <= 4096 ? "low" : "high") : "high");
        const effort = ["low", "high", "max"].includes(selectedEffort) ? selectedEffort : "high";
        transformed.thinking = { type: "enabled" };
        const requestedMaxTokens = getGlmRequestContext()?.maxTokens;
        if (Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0) {
          // Numeric thinking budgets no longer require an inflated output limit.
          transformed.max_tokens = Math.min(transformed.max_tokens || requestedMaxTokens, requestedMaxTokens);
        }
        transformed.output_config = { ...transformed.output_config, effort };
        delete transformed.reasoning_effort;
        delete transformed.temperature;
        delete transformed.top_p;
        delete transformed.top_k;
      }
      const withSystem = injectZcodeSystemPrompt(transformed);
      capCacheControlBlocks(withSystem, true);
      const userId = buildZcodeAnthropicMetadataUserId(credentials);
      return userId
        ? { ...withSystem, metadata: { ...withSystem.metadata, user_id: userId } }
        : withSystem;
    }

    return transformed;
  }

  buildHeaders(credentials, stream = true) {
    const headers = super.buildHeaders(credentials, stream);

    if (this.usesCodingPlan(credentials) && this.getUrlIndex() === 0) {
      applyZcodeCodingPlanHeaders(headers, credentials);
    } else if (this.usesZcodeApiKeyUpstream(credentials)) {
      applyZcodeApiKeyHeaders(headers, credentials);
    }

    return headers;
  }

  parseError(response, bodyText) {
    if (!bodyText) {
      return super.parseError(response, bodyText);
    }

    try {
      const json = JSON.parse(bodyText);
      const err = json?.error;
      const code = err?.code ?? json?.code;
      const message = err?.message ?? json?.msg ?? json?.message;

      if (typeof message === "string" && message.includes(GLM_VERIFICATION_REQUIRED)) {
        return { status: 403, message, noCooldown: true };
      }
      if (response.status === GLM_ACTIVITY_BLOCK.status &&
          (String(code) === String(GLM_ACTIVITY_BLOCK.code) ||
           (typeof message === "string" && message.toLowerCase().includes(GLM_ACTIVITY_BLOCK.text)))) {
        return {
          status: response.status,
          message: `${GLM_ACTIVITY_BLOCK.label}: request blocked due to unusual activity. ` +
            "Automatic fallback stopped; pause requests and contact Z.AI support if the block persists.",
          noCooldown: true,
        };
      }

      if (code === "1113" || (typeof message === "string" && message.includes("1113"))) {
        return {
          status: response.status || 429,
          message:
            "GLM quota exhausted or no active resource package for this model. " +
            "Check ZCode Start/Coding Plan balance, try glm-5-turbo, or wait for daily reset.",
        };
      }

      const isConcurrencyLimit =
        String(code) === "3009" ||
        String(code) === "3010" ||
        (typeof message === "string" && message.toLowerCase().includes("concurrency limit"));
      if (isConcurrencyLimit) {
        return {
          status: response.status || 429,
          message:
            "Z.AI model admission concurrency limit exceeded. Close other ZCode/9router sessions and retry.",
          noCooldown: true,
        };
      }

      if (typeof message === "string" && message.length > 0) {
        return { status: response.status, message };
      }
    } catch {
      /* fall through */
    }

    return super.parseError(response, bodyText);
  }

  verificationResult(url = zcodeConfig.codingPlanUrl) {
    return { response: new Response(JSON.stringify({ error: {
      message: `${GLM_VERIFICATION_REQUIRED}: complete the request in the official ZCode app. No automatic replay was sent.`,
    } }), { status: 403, headers: { "Content-Type": "application/json" } }),
    url, headers: {}, transformedBody: null, skipCredentialRefresh: true };
  }

  async fetchUpstream(url, options, proxyOptions) {
    try {
      return await proxyAwareFetch(url, { ...options, strictTls: true, redirect: "error" },
        { ...proxyOptions, strictProxy: proxyOptions?.forceDirect !== true });
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      throw new Error("Z.AI inference network request failed on the selected route");
    }
  }

  async execute(params) {
    params = { ...params, proxyOptions: { ...params.proxyOptions, strictProxy: params.proxyOptions?.forceDirect !== true } };
    let credentials = normalizeZaiCredentials(params.credentials);
    const { model } = params;
    if (params.providerSessionId) credentials = { ...credentials, _clientSessionId: params.providerSessionId };
    if (isZaiStartPlan(credentials) && !credentials?.providerSpecificData?.zcodeJwtToken) {
      return { ...this.verificationResult(), response: new Response(JSON.stringify({ error: {
        message: `${GLM_VERIFICATION_REQUIRED}: the selected Start Plan has no login credential. Reconnect this account; no API-key fallback was sent.`,
      } }), { status: 403, headers: { "Content-Type": "application/json" } }) };
    }
    if (isZaiAccountCodingPlan(credentials)) {
      const token = await getZcodeProjectToken(credentials, params.proxyOptions);
      credentials = { ...credentials, apiKey: token };
    }
    params = { ...params, credentials };
    if (isZaiStartPlan(credentials)) {
      let verification;
      try { verification = await getCaptchaManager().fetchCaptchaConfig(params.proxyOptions); }
      catch { return this.verificationResult(); }
      if (!verification || (verification.enabled !== false && verification.skip_model_request !== true)) {
        return this.verificationResult();
      }
    }
    return glmRequestContext.run({ credentials, urlIndex: 0, model, effort: params.glmEffort, maxTokens: params.glmMaxTokens }, async () => {
      const result = await super.execute(params);
      const status = result?.response?.status;
      if (status === 401 && isZaiAccountCodingPlan(credentials)) {
        invalidateZcodeProjectToken(credentials, params.proxyOptions);
      }
      if (
        (await this.isCaptchaResponse(status, result?.response))
      ) {
        return this.verificationResult(result.url);
      }
      return result;
    });
  }

}

export default GlmExecutor;