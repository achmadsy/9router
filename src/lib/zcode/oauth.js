import { ZaiAuthFlow } from "./auth.js";
import {
  ZCODE_ZAI_CLIENT_ID,
  ZCODE_ZAI_CLIENT_SECRET,
  ZCODE_ZAI_TOKEN_URL,
} from "./constants.js";
import { resolveZaiNetwork } from "./network.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";
import { resolveZaiPlanMode } from "./access.js";

/**
 * Refresh Z.AI OAuth access_token via chat.z.ai (requires client_secret).
 * Mirrors xAI refresh pattern; zcodeJwt (Coding Plan JWT) is issued only during CLI poll
 * and cannot be renewed without re-authentication.
 */
export async function refreshZaiAccessToken(refreshToken, proxyOptions = null) {
  if (!refreshToken || !ZCODE_ZAI_CLIENT_SECRET) {
    return null;
  }

  let res;
  try {
    res = await proxyAwareFetch(ZCODE_ZAI_TOKEN_URL, {
      method: "POST", redirect: "error", strictTls: true, signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: ZCODE_ZAI_CLIENT_ID,
        client_secret: ZCODE_ZAI_CLIENT_SECRET,
      }),
    }, proxyOptions);
  } catch {
    throw new Error("Z.AI token refresh network request failed on the selected route");
  }

  if (!res.ok) {
    throw new Error(`Z.AI token refresh failed (HTTP ${res.status})`);
  }

  return await res.json();
}

/**
 * Refresh GLM OAuth credentials: rotate zai access_token (when configured) and
 * re-fetch the biz API key. Coding Plan JWT is left unchanged until user re-OAuths.
 */
export async function refreshGlmOAuthCredentials(credentials) {
  const refreshToken = credentials?.refreshToken;
  if (!refreshToken) return null;

  const psd = credentials.providerSpecificData || {};
  const { proxyOptions } = await resolveZaiNetwork(psd.zaiPlanNetworkRoute || "account", psd);
  const tokens = await refreshZaiAccessToken(refreshToken, proxyOptions);
  if (!tokens?.access_token) return null;

  const flow = new ZaiAuthFlow(undefined, null, proxyOptions);
  const connectionPatch = await flow.exchangeForConnection(
    tokens.access_token,
    credentials.providerSpecificData?.zcodeJwtToken,
    { zai: tokens }
  );

  return {
    accessToken: connectionPatch.accessToken,
    apiKey: connectionPatch.apiKey,
    refreshToken: tokens.refresh_token || refreshToken,
    expiresIn: tokens.expires_in,
    providerSpecificData: {
      ...credentials.providerSpecificData,
      ...connectionPatch.providerSpecificData,
      zaiPlanMode: resolveZaiPlanMode(credentials),
      zaiAccessToken: tokens.access_token,
      ...(tokens.refresh_token ? { zaiRefreshToken: tokens.refresh_token } : {}),
    },
  };
}