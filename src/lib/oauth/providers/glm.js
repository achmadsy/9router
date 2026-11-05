import { GLM_OAUTH_CONFIG } from "../constants/oauth.js";
import { ZaiAuthFlow } from "../../zcode/auth.js";
import { resolveZaiNetwork } from "../../zcode/network.js";
import { createZaiSession, getZaiSession, updateZaiSession, withZaiSessionLock } from "../../zcode/sessions.js";
import { ZAI_PLAN_MODES, validateZaiPlanMode } from "../../zcode/access.js";
import { zaiNetworkConnectionData } from "../../zcode/network.js";

const glm = {
  config: GLM_OAUTH_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (_config, _challenge, options = {}) => {
    const planMode = validateZaiPlanMode(options.zaiPlanMode || ZAI_PLAN_MODES.START);
    const { proxyOptions } = await resolveZaiNetwork(options.networkRoute || "account");
    const flow = new ZaiAuthFlow(undefined, null, proxyOptions);
    const init = await flow.start();
    await createZaiSession({ ...init, networkRoute: options.networkRoute || "account",
      expiresAtMs: flow.expiresAt, pollIntervalSec: flow.pollIntervalSec, zaiPlanMode: planMode });
    return { device_code: init.flowId, verification_uri: init.authorizeUrl,
      expires_in: Math.max(1, Math.floor((flow.expiresAt - Date.now()) / 1000)),
      interval: flow.pollIntervalSec, _zcodePollToken: init.pollToken };
  },
  pollToken: async (_config, deviceCode, _verifier, extraData) => withZaiSessionLock(deviceCode, async () => {
    let session = await getZaiSession(deviceCode);
    if (!session || extraData?._zcodePollToken !== session.pollToken) {
      return { ok: true, data: { error: "access_denied", error_description: "OAuth session expired or invalid" } };
    }
    if (session.result) return { ok: true, data: { error: "authorization_complete" } };
    if (session.tokenData) return { ok: true, data: { access_token: session.tokenData.accessToken, connection: session.tokenData } };
    if (!session.authorization && Date.now() < (session.nextPollAt || 0)) return { ok: true, data: { error: "authorization_pending" } };
    session = await updateZaiSession(deviceCode, { nextPollAt: Date.now() + (session.pollIntervalSec || 2) * 1000 });
    const { proxyOptions } = await resolveZaiNetwork(session.networkRoute);
    const flow = new ZaiAuthFlow(undefined, session.pollToken, proxyOptions);
    Object.assign(flow, { flowId: session.flowId, expiresAt: session.expiresAt, pollIntervalSec: session.pollIntervalSec });
    const data = session.authorization || await flow.poll();
    if (data.status === "pending") return { ok: true, data: { error: "authorization_pending" } };
    if (data.status !== "ready" || !data.zai?.access_token) return { ok: true, data: { error: "access_denied", error_description: "Authorization failed" } };
    session = await updateZaiSession(deviceCode, { authorization: data });
    const connection = await flow.exchangeForConnection(data.zai.access_token, data.token, data);
    connection.providerSpecificData = { ...connection.providerSpecificData,
      ...zaiNetworkConnectionData(session.networkRoute), zaiPlanMode: session.zaiPlanMode };
    await updateZaiSession(deviceCode, { tokenData: connection });
    return { ok: true, data: { access_token: connection.accessToken, connection } };
  }),
  mapTokens: (tokens) => tokens.connection,
};

export default glm;
