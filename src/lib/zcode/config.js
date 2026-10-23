const apiBaseUrl = process.env.ZCODE_API_BASE_URL || "https://zcode.z.ai/api/v1";
const appVersion = process.env.ZCODE_APP_VERSION || "3.16.3";

const RELEASE_TARGETS = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const RELEASE_ARCHES = {
  x64: "x86_64",
  arm64: "aarch64",
};

export function resolveZcodeClientConfigPlatform(
  platform = process.platform,
  arch = process.arch
) {
  const target = RELEASE_TARGETS[platform] || platform;
  const releaseArch = RELEASE_ARCHES[arch] || arch;
  return `${target}-${releaseArch}`;
}

export function buildZcodeClientConfigUrl() {
  const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/client/configs`);
  url.searchParams.set("app_version", appVersion);
  url.searchParams.set("platform", resolveZcodeClientConfigPlatform());
  return url.toString();
}

const zcodeConfig = {
  apiBaseUrl,
  captchaPort: parseInt(process.env.ZCODE_CAPTCHA_PORT || process.env.PORT || "20128", 10),
  captchaCacheTTL: parseInt(process.env.CAPTCHA_CACHE_TTL || "45000", 10),
  captchaVerifyTimeoutMs: parseInt(process.env.CAPTCHA_VERIFY_TIMEOUT_MS || "120000", 10),
  captchaHeadedFallback: process.env.ZCODE_CAPTCHA_HEADED_FALLBACK !== "false",
  captchaHeadlessTimeoutMs: parseInt(process.env.CAPTCHA_HEADLESS_TIMEOUT_MS || "45000", 10),
  captchaInteractiveTimeoutMs: parseInt(process.env.CAPTCHA_INTERACTIVE_TIMEOUT_MS || "300000", 10),
  captchaConfigCacheTTL: parseInt(process.env.CAPTCHA_CONFIG_CACHE_TTL || "600000", 10),
  /** Delay before tearing down the browser after a solved captcha (page posts token). */
  captchaTeardownDelayMs: parseInt(process.env.CAPTCHA_TEARDOWN_DELAY_MS || "3000", 10),
  /** Reap browser when no verification is pending for this long. 0 disables. */
  captchaIdleTeardownMs: parseInt(process.env.CAPTCHA_IDLE_TEARDOWN_MS || "300000", 10),
  codingPlanUrl:
    process.env.ZAI_CODING_PLAN_URL ||
    `${apiBaseUrl.replace(/\/+$/, "")}/zcode-plan/anthropic/v1/messages`,
  /** Start Plan billing balance (native ZCode quota panel). */
  startPlanBalanceUrl:
    process.env.ZAI_START_PLAN_BALANCE_URL ||
    `${apiBaseUrl.replace(/\/+$/, "")}/zcode-plan/billing/balance`,
  apiKeyFallbackUrl:
    process.env.ZAI_FALLBACK_URL || "https://api.z.ai/api/anthropic/v1/messages",
  /** OpenAI-format coding-plan / API-key endpoint (registry multi-transport). */
  openaiCodingUrl:
    process.env.ZAI_OPENAI_CODING_URL ||
    "https://api.z.ai/api/coding/paas/v4/chat/completions",
  appVersion,
  userAgent: process.env.UPSTREAM_USER_AGENT || `ZCode/${appVersion}`,
};

export default zcodeConfig;
