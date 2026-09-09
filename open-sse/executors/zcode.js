import { DefaultExecutor } from "./default.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { injectZcodeSystemPrompt } from "../../src/lib/zcode/systemPrompt.js";
import {
  getCaptchaManager,
  getZcodeCaptchaPort,
  isCaptchaError,
} from "../../src/lib/zcode/captcha-service.js";
import {
  applyZcodeStartPlanHeaders,
  buildZcodeAnthropicMetadataUserId,
} from "../../src/lib/zcode/headers.js";
import zcodeConfig from "../../src/lib/zcode/config.js";
import { GLM_CODING_PLAN_MODEL_MAP } from "../../src/lib/zcode/constants.js";
import { captureException, captureMessage } from "../rtk/sentry.js";

const MAX_CAPTCHA_RETRIES = 2;
const START_PLAN_BUSY_CODES = new Set(["3008", "3009", "3010"]);
const START_PLAN_BUSY_RETRY_DELAYS_MS = [1000, 2000];

async function readStartPlanError(response) {
  if (!response || response.ok) return null;
  try {
    const text = await response.clone().text();
    const json = JSON.parse(text);
    return {
      code: String(json?.error?.code ?? json?.code ?? ""),
      message: String(json?.error?.message ?? json?.msg ?? json?.message ?? ""),
    };
  } catch {
    return null;
  }
}

export class ZcodeExecutor extends DefaultExecutor {
  constructor(provider = "zcode") {
    super(provider);
  }

  resolveAuthDescriptor() {
    return {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      anthropicVersion: false,
    };
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    if (!transformed || typeof transformed !== "object") return transformed;

    // Catalog exposes plan-scoped IDs, while Start Plan accepts plain public names.
    const rawModel = String(transformed.model || model).split("/").pop();
    const mapped =
      getModelUpstreamId("zcode", rawModel) ||
      GLM_CODING_PLAN_MODEL_MAP[rawModel.toLowerCase()] ||
      rawModel;

    transformed.model = mapped;

    const request = injectZcodeSystemPrompt(transformed, {
      modelRef: `builtin:zai-start-plan/${transformed.model || mapped || model}`,
    });
    request.metadata = {
      ...(request.metadata || {}),
      user_id: buildZcodeAnthropicMetadataUserId(credentials),
    };
    return request;
  }

  buildUrl() {
    return zcodeConfig.startPlanChatUrl;
  }

  buildHeaders(credentials, stream = true, url, model) {
    const headers = super.buildHeaders(credentials, stream, url, model);
    applyZcodeStartPlanHeaders(headers, credentials);
    return headers;
  }

  parseError(response, bodyText) {
    if (!bodyText) return super.parseError(response, bodyText);

    try {
      const json = JSON.parse(bodyText);
      const err = json?.error;
      const code = String(err?.code ?? json?.code ?? "");
      const message = String(err?.message ?? json?.msg ?? json?.message ?? "");
      const lowerMessage = message.toLowerCase();

      if (code === "1113" || message.includes("1113")) {
        return {
          status: response.status || 429,
          message:
            "ZCode quota exhausted or no active Start Plan resource package for this model. " +
            "Check Start Plan usage or retry after quota reset.",
        };
      }

      if (
        START_PLAN_BUSY_CODES.has(code) ||
        START_PLAN_BUSY_CODES.has(message) ||
        lowerMessage.includes("concurrency limit")
      ) {
        return {
          status: response.status || 429,
          message:
            "Start Plan is busy and automatic model stream recovery reached the maximum retry count.",
        };
      }

      if (lowerMessage.includes("quota") || lowerMessage.includes("resource package")) {
        return {
          status: response.status || 429,
          message: `ZCode Start Plan quota error from upstream: ${message}`,
        };
      }

      if (
        code === "3007" ||
        lowerMessage.includes("captcha") ||
        lowerMessage.includes("verify token") ||
        lowerMessage.includes("verify failed") ||
        code === "captcha_required"
      ) {
        try {
          captureMessage(
            `[ZCode Captcha] Upstream triggered verification/captcha: ${message || code}`,
            "error",
            { tags: { provider: "zcode", stage: "upstream_captcha", code } },
          );
        } catch {}
        return {
          status: 403,
          message:
            "ZCode upstream triggered Aliyun verification/captcha. " +
            "Automated captcha solve failed or timed out. " +
            "Please complete verification in browser or refresh your ZCode session.",
        };
      }

      if (message.length > 0) return { status: response.status, message };
    } catch {
      // Fall through to default parser.
    }

    return super.parseError(response, bodyText);
  }

  async execute(params) {
    const { credentials, proxyOptions } = params;

    const relayUrl =
      proxyOptions?.vercelRelayUrl || credentials?.providerSpecificData?.vercelRelayUrl;
    if (relayUrl) {
      throw new Error(
        "ZCode provider does not support relay-based proxies (Vercel/Cloudflare/Deno relay). " +
        "Please use a standard HTTP or SOCKS5 proxy so API requests and browser captcha verification share the same exit IP.",
      );
    }

    const connectionProxyUrl =
      (proxyOptions?.connectionProxyEnabled && proxyOptions?.connectionProxyUrl) ||
      (credentials?.providerSpecificData?.connectionProxyEnabled &&
        credentials?.providerSpecificData?.connectionProxyUrl) ||
      "";

    const captchaManager = getCaptchaManager();
    const port = getZcodeCaptchaPort();
    let captchaAttempts = 0;
    let busyRetries = 0;
    let lastResult = null;

    while (
      captchaAttempts < MAX_CAPTCHA_RETRIES &&
      busyRetries <= START_PLAN_BUSY_RETRY_DELAYS_MS.length
    ) {
      captchaAttempts += 1;
      const isHeadedAttempt = captchaAttempts === MAX_CAPTCHA_RETRIES;
      let verifyParam = null;
      try {
        verifyParam = await captchaManager.getVerifyParam(port, {
          proxy: connectionProxyUrl || null,
          headless: !isHeadedAttempt,
          interactive: true,
        });
      } catch (err) {
        console.error(
          `[ZCode Captcha] Solve failed (attempt ${captchaAttempts}${isHeadedAttempt ? " - headed" : " - headless"}):`,
          err.message,
        );
        try {
          captureException(err, {
            tags: {
              provider: "zcode",
              stage: "captcha_solve",
              attempt: String(captchaAttempts),
            },
            extra: { isHeadedAttempt, port, connectionProxyUrl },
          });
        } catch {}
      }

      const credsWithCaptcha = {
        ...credentials,
        providerSpecificData: {
          ...(credentials?.providerSpecificData || {}),
          ...(verifyParam ? { _captchaVerifyParam: verifyParam } : {}),
        },
      };

      const result = await super.execute({ ...params, credentials: credsWithCaptcha });
      lastResult = result;

      if (
        (result?.response?.status === 403 || result?.response?.status === 400) &&
        (await isCaptchaError(result.response))
      ) {
        captchaManager.invalidate();
        if (captchaAttempts < MAX_CAPTCHA_RETRIES) {
          const nextMode = "headed browser on display :99";
          const msg =
            `[ZCode Captcha] Challenge (${result.response.status}) detected on attempt ${captchaAttempts}. ` +
            `Invalidating token and retrying with ${nextMode}...`;
          console.warn(msg);
          try {
            captureMessage(msg, "warning", {
              tags: {
                provider: "zcode",
                stage: "captcha_challenge",
                attempt: String(captchaAttempts),
              },
            });
          } catch {}
        } else {
          const msg =
            `[ZCode Captcha] Challenge (${result.response.status}) persisted after ${captchaAttempts} attempts.`;
          console.error(msg);
          try {
            captureMessage(msg, "error", {
              tags: {
                provider: "zcode",
                stage: "captcha_persisted",
                attempt: String(captchaAttempts),
              },
            });
          } catch {}
        }
        continue;
      }

      const upstreamError = await readStartPlanError(result?.response);
      if (
        upstreamError &&
        (START_PLAN_BUSY_CODES.has(upstreamError.code) ||
          START_PLAN_BUSY_CODES.has(upstreamError.message)) &&
        busyRetries < START_PLAN_BUSY_RETRY_DELAYS_MS.length
      ) {
        const delay = START_PLAN_BUSY_RETRY_DELAYS_MS[busyRetries];
        busyRetries += 1;
        captchaAttempts -= 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return result;
    }

    return lastResult || super.execute(params);
  }
}

export default ZcodeExecutor;
