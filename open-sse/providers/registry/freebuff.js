export default {
  id: "freebuff",
  priority: 280,
  alias: "fb",
  aliases: ["freebuff-ai", "codebuff-free"],
  uiAlias: "fb",
  display: {
    name: "Freebuff (WIP)",
    icon: "auto_awesome",
    color: "#7C3AED",
    textIcon: "FB",
    website: "https://freebuff.com",
    notice: {
      text: "Freebuff free models (GLM / DeepSeek / MiMo / …). Login via freebuff.com device code.",
      signupUrl: "https://freebuff.com",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  hasProviderSpecificData: true,
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    format: "openai",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    // Wire ids from Freebuff catalog (common/src/constants/freebuff-models.ts).
    // Display names shortened for the 9router picker.
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", upstreamModelId: "z-ai/glm-5.3-flash" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4.1 Flash", upstreamModelId: "deepseek/deepseek-v4-flash" },
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", upstreamModelId: "openai/gpt-5.6-luna" },
    { id: "mimo/mimo-v2.5", name: "MiMo 2.5", upstreamModelId: "mimo/mimo-v2.5" },
    { id: "upstage/solar-pro4", name: "Solar Pro 4", upstreamModelId: "upstage/solar-pro4" },
    // Muse 1.3 is still recognized upstream but paused (404); expose active 1.2 only.
    { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2", upstreamModelId: "meta/muse-spark-1.2-contributor" },
  ],
  features: {
    usage: true,
  },
  oauth: {
    // Custom device-code login (NOT standard OAuth2 device grant).
    //   1) POST /api/auth/cli/code { fingerprintId } → { loginUrl, fingerprintHash, expiresAt }
    //   2) User opens loginUrl in browser
    //   3) GET  /api/auth/cli/status?fingerprintId&fingerprintHash&expiresAt → authToken
    apiBaseUrl: "https://freebuff.com",
    initiateUrl: "https://freebuff.com/api/auth/cli/code",
    statusUrl: "https://freebuff.com/api/auth/cli/status",
    // Login lives on freebuff.com. Inference/session/usage use the shared
    // Codebuff backend (`NEXT_PUBLIC_CODEBUFF_APP_URL` in the upstream client).
    // Must be www. directly: the apex 307-redirects and native fetch drops
    // Authorization on cross-host redirects → "invalid token" everywhere.
    backendBaseUrl: "https://www.codebuff.com",
    usageUrl: "https://www.codebuff.com/api/v1/usage",
    sessionUrl: "https://www.codebuff.com/api/v1/freebuff/session",
    // Long-lived account authToken; no refresh token. Codes live 1h.
    expiresInSeconds: null,
    refreshLeadMs: null,
    timeoutMs: 3600000,
  },
};
