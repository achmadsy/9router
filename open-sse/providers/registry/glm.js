import { CLAUDE_API_HEADERS } from "../shared.js";

export default {
  id: "glm",
  priority: 140,
  alias: "glm",
  display: {
    name: "Zai GLM Coding",
    icon: "code",
    color: "#2563EB",
    textIcon: "GL",
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
    website: "https://z.ai",
    notice: {
      text: "Z.AI international (z.ai). OAuth Coding Plan or API key via api.z.ai.",
      apiKeyUrl: "https://z.ai",
      signupUrl: "https://z.ai",
    },
  },
  category: "oauth",
  // Dual-auth like kimi: paste an API key, or OAuth-login with the Z.ai
  // account to auto-mint a coding-plan key.
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  // OAuth = ZCode CLI polling flow (apps/zcode-cli cli-oauth.ts) — no PKCE, no
  // local callback: init mints a one-off poll token, the browser authorize_url
  // is server-generated, and poll/ready carries the tokens. The Z.AI OAuth
  // token is exchanged for a business JWT, then a long-lived coding-plan API
  // key (no refresh grant — re-login on expiry, same as the official CLI).
  oauth: {
    providerId: "zai",
    cliInitUrl: "https://zcode.z.ai/api/v1/oauth/cli/init",
    cliPollUrl: "https://zcode.z.ai/api/v1/oauth/cli/poll",
    businessLoginUrl: "https://api.z.ai/api/auth/z/login",
    apiBaseUrl: "https://api.z.ai",
    planApiKeyName: "zcode-api-key",
    refreshLeadMs: 600000,
  },
  transport: {
    baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
    format: "claude",
    urlSuffix: "?beta=true",
    headers: { ...CLAUDE_API_HEADERS },
    auth: {
      combined: true,
      header: "x-api-key",
      scheme: "raw",
    },
    usage: {
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
    },
  },
  // Multi-endpoint: pick the transport matching client sourceFormat to skip translation.
  transports: [
    {
      format: "openai",
      baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
      urlSuffix: "?beta=true",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  models: [
    { id: "glm-5.3", name: "GLM 5.3", upstreamModelId: "GLM-5.3" },
    { id: "glm-5.2", name: "GLM 5.2", upstreamModelId: "GLM-5.2" },
    { id: "glm-5.1", name: "GLM 5.1", upstreamModelId: "GLM-5.1" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo", upstreamModelId: "GLM-5-Turbo" },
    { id: "glm-5", name: "GLM 5" },
    { id: "glm-4.7", name: "GLM 4.7", upstreamModelId: "GLM-4.7" },
    { id: "glm-4.6", name: "GLM 4.6" },
    { id: "glm-4.6v", name: "GLM 4.6V (Vision)" },
  ],
  features: {
    usage: true,
    usageApikey: true,
  },
};
