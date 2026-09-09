import { ZCODE_CONFIG } from "../constants/oauth.js";

function flattenServiceTokens(tokens) {
  return {
    access_token: tokens.accessToken,
    _zaiAccessToken: tokens.zaiAccessToken,
    _zcodeEmail: tokens.email,
    _zcodeDisplayName: tokens.displayName,
    _zcodeJwtToken: tokens.providerSpecificData.zcodeJwtToken,
    _zcodeUserId: tokens.providerSpecificData.zcodeUserId,
    _zcodeFlowId: tokens.providerSpecificData.flowId,
    ...(tokens.expiresIn ? { expires_in: tokens.expiresIn } : {}),
  };
}

const zcode = {
  config: ZCODE_CONFIG,
  flowType: "authorization_code",

  prepareConfig: async () => {
    const { ZcodeAuthService } = await import("../services/zcode.js");
    const service = new ZcodeAuthService();
    const { flowId, authorizeUrl, state, expiresIn } = await service.initFlow();
    return {
      ...ZCODE_CONFIG,
      _zcodeAuthorizeUrl: authorizeUrl,
      _zcodeState: state,
      _zcodeFlowId: flowId,
      _zcodeExpiresIn: expiresIn,
    };
  },

  // Exchange must reuse pending state created during /authorize, never start another init flow.
  prepareExchangeConfig: async () => ZCODE_CONFIG,

  buildAuthUrl: (config) => config._zcodeAuthorizeUrl,

  exchangeToken: async (config, callbackUrl) => {
    const { ZcodeAuthService } = await import("../services/zcode.js");
    const service = new ZcodeAuthService();
    const result = await service.exchangeCallback(callbackUrl);
    if (result.status !== "ready" || !result.tokens) {
      throw new Error(result.error || "ZCode OAuth exchange failed");
    }

    return flattenServiceTokens(result.tokens);
  },

  pollToken: async (config, flowId) => {
    const { ZcodeAuthService } = await import("../services/zcode.js");
    const service = new ZcodeAuthService();
    const result = await service.pollFlow(flowId);
    if (result.status === "ready" && result.tokens) {
      return { ok: true, data: flattenServiceTokens(result.tokens) };
    }
    if (result.status === "pending") {
      return {
        ok: true,
        data: {
          error: "authorization_pending",
          error_description: "Authorization is not ready yet",
          retry_after: result.retryAfter,
        },
      };
    }
    return {
      ok: false,
      data: {
        error: result.status === "expired" ? "expired_token" : "access_denied",
        error_description: result.error || "ZCode OAuth failed",
      },
    };
  },

  // Start Plan inference uses raw ZCode JWT. Nested Z.AI account token remains
  // OAuth metadata; it is not an API key and must not enter signing v4.
  mapTokens: (tokens) => {
    const email = tokens._zcodeEmail || null;
    return {
      accessToken: tokens._zcodeJwtToken || tokens.access_token,
      email,
      displayName: tokens._zcodeDisplayName || email,
      ...(tokens.expires_in ? { expiresIn: tokens.expires_in } : {}),
      providerSpecificData: {
        authMethod: "zcode_oauth",
        useStartPlan: true,
        zcodeJwtToken: tokens._zcodeJwtToken || tokens.access_token,
        zaiAccessToken: tokens._zaiAccessToken,
        zaiUserId: tokens._zcodeUserId,
        flowId: tokens._zcodeFlowId,
      },
    };
  },
};

export default zcode;
