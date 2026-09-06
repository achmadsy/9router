import { DefaultExecutor } from "./default.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { injectZcodeSystemPrompt } from "../../src/lib/zcode/systemPrompt.js";
import {
  getCaptchaManager,
  getZcodeCaptchaPort,
  isCaptchaError,
} from "../../src/lib/zcode/captcha-service.js";
import { applyZcodeCodingPlanHeaders } from "../../src/lib/zcode/headers.js";
import { GLM_CODING_PLAN_MODEL_MAP } from "../../src/lib/zcode/constants.js";
import { captureException, captureMessage } from "../rtk/sentry.js";

const MAX_CAPTCHA_RETRIES = 2;

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

  transformRequest(model, body) {
    const transformed = super.transformRequest(model, body);
    if (!transformed || typeof transformed !== "object") return transformed;

    const rawModel = transformed.model || model;
    const mapped =
      getModelUpstreamId("zcode", rawModel) ||
      GLM_CODING_PLAN_MODEL_MAP[rawModel.toLowerCase()] ||
      rawModel;

    transformed.model = mapped;

    return injectZcodeSystemPrompt(transformed, {
      modelRef: `builtin:zai-start-plan/${transformed.model || mapped || model}`,
    });
  }

  buildHeaders(credentials, stream = true, url, model) {
    const headers = super.buildHeaders(credentials, stream, url, model);
    applyZcodeCodingPlanHeaders(headers, credentials);
    return headers;
  }

  parseError(response, bodyText) {
    if (!bodyText) {
      return super.parseError(response, bodyText);
    }

    try {
      const json = JSON.parse(bodyText);
      const err = json?.error;
      const code = String(err?.code ?? json?.code ?? "");
      const message = String(err?.message ?? json?.msg ?? json?.message ?? "");

      if (code === "1113" || message.includes("1113") || message.toLowerCase().includes("quota")) {
        return {
          status: response.status || 429,
          message:
            "ZCode quota exhausted or no active resource package for this model. " +
            "Check your ZCode subscription balance or retry after daily quota reset.",
        };
      }

      if (code === "3010" || message.includes("3010") || message.toLowerCase().includes("concurrency limit")) {
        return {
          status: response.status || 429,
          message: "ZCode concurrency limit reached. Please reduce concurrent requests and retry.",
        };
      }

      if (
        code === "3007" ||
        message.toLowerCase().includes("captcha") ||
        message.toLowerCase().includes("verify token") ||
        message.toLowerCase().includes("verify failed") ||
        code === "captcha_required"
      ) {
        try {
          captureMessage(
            `[ZCode Captcha] Upstream triggered verification/captcha: ${message || code}`,
            "error",
            { tags: { provider: "zcode", stage: "upstream_captcha", code: String(code) } }
          );
        } catch {}
        return {
          status: 403,
          message:
            "ZCode upstream triggered Aliyun verification/captcha. " +
            "Automated captcha solve failed or timed out. " +
            "Please complete the verification in the browser or refresh your ZCode session.",
        };
      }

      if (message.length > 0) {
        return { status: response.status, message };
      }
    } catch {
      // ignore json parse error
    }

    return super.parseError(response, bodyText);
  }

  async execute(params) {
    const { credentials, proxyOptions } = params;

    // Reject relay proxies (Vercel / Cloudflare / Deno edge relays)
    // Relay proxies rewrite headers/endpoints via edge functions and cannot tunnel browser traffic.
    const relayUrl = proxyOptions?.vercelRelayUrl || credentials?.providerSpecificData?.vercelRelayUrl;
    if (relayUrl) {
      throw new Error(
        "ZCode provider does not support relay-based proxies (Vercel/Cloudflare/Deno relay). " +
        "Please use a standard HTTP or SOCKS5 proxy so both API requests and browser captcha verification share the same exit IP."
      );
    }

    // Resolve standard forward proxy (HTTP/HTTPS/SOCKS5) if configured on the connection or pool
    const connectionProxyUrl =
      (proxyOptions?.connectionProxyEnabled && proxyOptions?.connectionProxyUrl) ||
      (credentials?.providerSpecificData?.connectionProxyEnabled && credentials?.providerSpecificData?.connectionProxyUrl) ||
      "";

    const captchaManager = getCaptchaManager();
    const port = getZcodeCaptchaPort();

    let lastResult = null;
    for (let attempt = 1; attempt <= MAX_CAPTCHA_RETRIES; attempt++) {
      // Attempt 1 runs headless popup auto-trigger; attempt 2 falls back to headed browser on display :99
      const isHeadedAttempt = attempt === MAX_CAPTCHA_RETRIES;
      let verifyParam = null;
      try {
        verifyParam = await captchaManager.getVerifyParam(port, {
          proxy: connectionProxyUrl || null,
          headless: !isHeadedAttempt,
          interactive: true,
        });
      } catch (err) {
        console.error(
          `[ZCode Captcha] Solve failed (attempt ${attempt}${isHeadedAttempt ? " - headed" : " - headless"}):`,
          err.message,
        );
        try {
          captureException(err, {
            tags: { provider: "zcode", stage: "captcha_solve", attempt: String(attempt) },
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
        if (attempt < MAX_CAPTCHA_RETRIES) {
          const nextAttempt = attempt + 1;
          const nextMode = nextAttempt === MAX_CAPTCHA_RETRIES ? "headed browser on display :99" : "headless browser";
          const msg = `[ZCode Captcha] Challenge (${result.response.status}) detected on attempt ${attempt}. Invalidating token and retrying with ${nextMode}...`;
          console.warn(msg);
          try {
            captureMessage(
              msg,
              "warning",
              { tags: { provider: "zcode", stage: "captcha_challenge", attempt: String(attempt) } }
            );
          } catch {}
        } else {
          const msg = `[ZCode Captcha] Challenge (${result.response.status}) persisted after ${attempt} attempts.`;
          console.error(msg);
          try {
            captureMessage(
              msg,
              "error",
              { tags: { provider: "zcode", stage: "captcha_persisted", attempt: String(attempt) } }
            );
          } catch {}
        }
        continue;
      }

      return result;
    }

    return lastResult || super.execute(params);
  }
}

export default ZcodeExecutor;
