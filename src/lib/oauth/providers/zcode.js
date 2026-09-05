import { ZCODE_CONFIG } from "../constants/oauth.js";

const zcode = {
  config: ZCODE_CONFIG,
  flowType: "device_code",

  requestDeviceCode: async () => {
    const { ZcodeAuthService } = await import("../services/zcode.js");
    const svc = new ZcodeAuthService();
    const { flowId, authorizeUrl } = await svc.initFlow();

    return {
      device_code: flowId,
      user_code: flowId.slice(0, 8).toUpperCase(),
      verification_uri: authorizeUrl,
      verification_uri_complete: authorizeUrl,
      expires_in: 600,
      interval: 2,
    };
  },

  pollToken: async (config, deviceCode) => {
    const { ZcodeAuthService } = await import("../services/zcode.js");
    const svc = new ZcodeAuthService();
    const result = await svc.pollFlow(deviceCode);

    if (result.status === "pending") {
      return { ok: false, data: { error: "authorization_pending" } };
    }

    if (result.status === "failed") {
      return { ok: false, data: { error: "access_denied", error_description: result.error } };
    }

    if (result.status === "expired") {
      return { ok: false, data: { error: "expired_token", error_description: result.error } };
    }

    if (result.status === "ready" && result.tokens) {
      return {
        ok: true,
        data: {
          access_token: result.tokens.accessToken,
          expires_in: result.tokens.expiresIn,
          _zcodeEmail: result.tokens.email,
          _zcodeJwtToken: result.tokens.providerSpecificData.zcodeJwtToken,
          _zcodeFlowId: result.tokens.providerSpecificData.flowId,
        },
      };
    }

    return { ok: false, data: { error: "unknown_status" } };
  },

  mapTokens: (tokens) => {
    const email = tokens._zcodeEmail || null;
    return {
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in,
      email,
      displayName: email,
      providerSpecificData: {
        authMethod: "zcode_oauth",
        useCodingPlan: true,
        zcodeJwtToken: tokens._zcodeJwtToken || tokens.access_token,
        flowId: tokens._zcodeFlowId,
      },
    };
  },
};

export default zcode;
