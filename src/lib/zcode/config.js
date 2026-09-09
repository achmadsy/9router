const apiBaseUrl = process.env.ZCODE_API_BASE_URL || "https://zcode.z.ai/api/v1";
const startPlanBaseUrl =
  process.env.ZCODE_START_PLAN_BASE_URL || `${apiBaseUrl}/zcode-plan`;
const startPlanAnthropicBaseUrl =
  process.env.ZCODE_START_PLAN_ANTHROPIC_BASE_URL ||
  `${startPlanBaseUrl}/anthropic`;
const startPlanChatUrl =
  process.env.ZCODE_START_PLAN_URL ||
  process.env.ZAI_CODING_PLAN_URL ||
  `${startPlanAnthropicBaseUrl}/v1/messages`;
const appVersion = process.env.ZCODE_APP_VERSION || "3.11.2";
const oauthDesktopRedirectUri =
  process.env.ZCODE_OAUTH_REDIRECT_URI ||
  `https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback&app_version=${appVersion}`;

export function buildZcodeStartPlanBalanceUrl() {
  const url = new URL(
    process.env.ZCODE_START_PLAN_BILLING_BALANCE_URL ||
      `${startPlanBaseUrl}/billing/balance`,
  );
  url.searchParams.set("app_version", appVersion);
  return url.toString();
}

const zcodeConfig = {
  apiBaseUrl,
  startPlanBaseUrl,
  startPlanAnthropicBaseUrl,
  startPlanChatUrl,
  oauthInitUrl: process.env.ZCODE_OAUTH_INIT_URL || `${apiBaseUrl}/oauth/cli/init`,
  oauthPollUrl: process.env.ZCODE_OAUTH_POLL_URL || `${apiBaseUrl}/oauth/cli/poll`,
  oauthTokenUrl: process.env.ZCODE_OAUTH_TOKEN_URL || `${apiBaseUrl}/oauth/token`,
  oauthDesktopRedirectUri,
  startPlanBillingBalanceUrl:
    process.env.ZCODE_START_PLAN_BILLING_BALANCE_URL ||
    `${startPlanBaseUrl}/billing/balance`,
  captchaPort: parseInt(process.env.ZCODE_CAPTCHA_PORT || process.env.PORT || "20128", 10),
  captchaCacheTTL: parseInt(process.env.CAPTCHA_CACHE_TTL || "45000", 10),
  captchaVerifyTimeoutMs: parseInt(process.env.CAPTCHA_VERIFY_TIMEOUT_MS || "120000", 10),
  captchaHeadedFallback:
    process.env.ZCODE_CAPTCHA_HEADED_FALLBACK !== "false" &&
    (process.platform !== "linux" || Boolean(process.env.DISPLAY)),
  captchaHeadlessTimeoutMs: parseInt(process.env.CAPTCHA_HEADLESS_TIMEOUT_MS || "12000", 10),
  captchaInteractiveTimeoutMs: parseInt(process.env.CAPTCHA_INTERACTIVE_TIMEOUT_MS || "300000", 10),
  captchaConfigCacheTTL: parseInt(process.env.CAPTCHA_CONFIG_CACHE_TTL || "600000", 10),
  // Backward-compatible alias for existing deployments using this property.
  codingPlanUrl: startPlanChatUrl,
  appVersion,
  userAgent: process.env.ZCODE_USER_AGENT || `ZCode/${appVersion}`,
};

export default zcodeConfig;
