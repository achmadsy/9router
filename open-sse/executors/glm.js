import { AsyncLocalStorage } from "node:async_hooks";
import { DefaultExecutor } from "./default.js";
import zcodeConfig from "../../src/lib/zcode/config.js";
import { GLM_CODING_PLAN_MODEL_MAP } from "../../src/lib/zcode/constants.js";
import { injectZcodeSystemPrompt } from "../../src/lib/zcode/systemPrompt.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import {
  getCaptchaManager,
  getZcodeCaptchaPort,
  isCaptchaError,
} from "../../src/lib/zcode/captcha-service.js";
import {
  applyZcodeApiKeyHeaders,
  applyZcodeCodingPlanHeaders,
  buildZcodeAnthropicMetadataUserId,
} from "../../src/lib/zcode/headers.js";

const MAX_CAPTCHA_RETRIES = 3;

/**
 * Models that only exist on ZCode **Start Plan** (zcode.z.ai JWT + captcha).
 * Coding Plan API key on api.z.ai returns 1113 for these.
 */
const START_PLAN_MODELS = new Set(["glm-5.3", "glm-5.3-flash"]);

/** Native casing — Start Plan balance/resource lookup is case-sensitive. */
const START_PLAN_UPSTREAM_MODEL_IDS = {
  "glm-5.3": "GLM-5.3",
  "glm-5.3-flash": "GLM-5.3-Flash",
};

function isStartPlanModel(model) {
  if (!model) return false;
  const id = String(model);
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

  usesCodingPlan(credentials, model = null) {
    const psd = credentials?.providerSpecificData;
    if (!psd) return false;
    const hasJwt = !!(psd.zcodeJwtToken || credentials.accessToken);
    if (!hasJwt) return false;
    // Start Plan models always need JWT path; others honor stored flag.
    if (this.isStartPlanRequest(model)) return true;
    return !!psd.useCodingPlan;
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

  canFallbackToApiKey(credentials) {
    // Start Plan-only models are absent from Coding Plan resource packages
    // (api.z.ai returns code 1113). Never fall back to the API-key path.
    if (this.isStartPlanRequest()) return false;
    return this.usesCodingPlan(credentials) && !!credentials?.apiKey;
  }

  getFallbackCount() {
    if (this.isStartPlanRequest()) return 1;
    const credentials = getGlmRequestContext()?.credentials;
    if (!credentials) return 1;
    return this.canFallbackToApiKey(credentials) ? 2 : 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const ctx = getGlmRequestContext();
    if (ctx) ctx.urlIndex = urlIndex;

    // Coding Plan JWT → zcode-plan Anthropic endpoint (desktop quota lives here).
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
      (this.isStartPlanRequest(modelId) && START_PLAN_UPSTREAM_MODEL_IDS[bareId]) ||
      getModelUpstreamId("glm", modelId) ||
      GLM_CODING_PLAN_MODEL_MAP[modelId.toLowerCase()] ||
      modelId;

    if (mapped !== modelId) {
      transformed.model = mapped;
    }

    if (this.usesCodingPlan(credentials) && this.getUrlIndex() === 0) {
      // Native GLM-5.3 Start Plan: thinking.budgetTokens + output_config.effort
      if (bareId === "glm-5.3" || bareId === "glm-5.3-flash") {
        const disabled = transformed.thinking?.type === "disabled";
        const budget =
          Number.isFinite(transformed.thinking?.budget_tokens) && transformed.thinking.budget_tokens > 0
            ? transformed.thinking.budget_tokens
            : 8000;
        if (!disabled) {
          transformed.thinking = { type: "enabled", budgetTokens: budget };
          transformed.output_config = {
            ...transformed.output_config,
            effort: transformed.reasoning_effort || transformed.output_config?.effort || "high",
          };
        }
        delete transformed.reasoning_effort;
      }
      const withSystem = injectZcodeSystemPrompt(transformed, {
        modelRef: `builtin:zai-start-plan/${transformed.model || mapped}`,
      });
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

  shouldRetry(status, urlIndex) {
    const credentials = getGlmRequestContext()?.credentials;
    if (
      status === 401 &&
      urlIndex === 0 &&
      credentials &&
      this.canFallbackToApiKey(credentials)
    ) {
      return true;
    }
    return super.shouldRetry(status, urlIndex);
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

      if (code === "1113" || (typeof message === "string" && message.includes("1113"))) {
        return {
          status: response.status || 429,
          message:
            "GLM quota exhausted or no active resource package for this model. " +
            "Check ZCode Start/Coding Plan balance, try glm-5-turbo, or wait for daily reset.",
        };
      }

      if (code === "3010" || (typeof message === "string" && message.includes("concurrency limit"))) {
        return {
          status: response.status || 429,
          message:
            "Z.AI model admission concurrency limit exceeded. Close other ZCode/9router sessions and retry.",
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

  async execute(params) {
    const { credentials, model } = params;
    // Lazy captcha: only after Start Plan returns 400/403 captcha — not on every request.
    return glmRequestContext.run({ credentials, urlIndex: 0, model }, async () => {
      const result = await super.execute(params);
      const status = result?.response?.status;
      if (
        this.usesCodingPlan(credentials, model) &&
        (await this.isCaptchaResponse(status, result?.response))
      ) {
        getCaptchaManager()?.invalidate?.();
        return this.executeWithCaptcha(params);
      }
      return result;
    });
  }

  /**
   * On Start Plan captcha (400/403), solve captcha and retry.
   * Coding Plan API-key path never enters here.
   */
  async executeWithCaptcha(params) {
    const { credentials, model } = params;
    const captchaManager = getCaptchaManager();
    const port = getZcodeCaptchaPort();
    // CloakBrowser must share the same normal proxy as the model request (IP binding).
    // Relay URLs are already stripped for glm by resolveConnectionProxyConfig.
    const psd = credentials?.providerSpecificData;
    const normalProxy =
      psd?.connectionProxyEnabled === true && psd?.connectionProxyUrl
        ? String(psd.connectionProxyUrl).trim()
        : "";
    captchaManager.setProxy?.(normalProxy);

    for (let attempt = 1; attempt <= MAX_CAPTCHA_RETRIES; attempt++) {
      let verifyParam;
      try {
        verifyParam = await captchaManager.getVerifyParam(port);
      } catch (err) {
        throw new Error(`Captcha verification failed: ${err.message}`);
      }

      const credsWithCaptcha = {
        ...credentials,
        providerSpecificData: {
          ...(credentials.providerSpecificData || {}),
          _captchaVerifyParam: verifyParam,
        },
      };

      const result = await super.execute({ ...params, credentials: credsWithCaptcha });

      if (await this.isCaptchaResponse(result.response?.status, result.response)) {
        captchaManager.invalidate();
        continue;
      }

      return result;
    }

    throw new Error("Captcha expired multiple times. Restart the service or check CloakBrowser.");
  }
}

export default GlmExecutor;