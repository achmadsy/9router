import crypto from "node:crypto";
import config from "./config.js";
import { buildZcodeGuiRequestHeaders } from "./headers.js";
import { ZCODE_ZAI_DEFAULT_EXPIRES_IN } from "./constants.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Z.AI login uses the server-mediated CLI poll (ZCode desktop `loginZCodeCli`):
 *   1. Client generates poll_token (32 random bytes, hex)
 *   2. POST oauth/cli/init with Authorization: Bearer <poll_token>
 *   3. Server returns authorize_url whose redirect_uri is zcode.z.ai's OWN
 *      /oauth/cli/callback/zai — NOT localhost
 *   4. Poll oauth/cli/poll/{flow_id} with same Bearer until ready
 *
 * Building a direct chat.z.ai authorize URL with a localhost redirect_uri is
 * rejected: {"detail":"Redirect URI not registered for this client"}.
 * (Verified live 2026-09-11. cliproxy's loopback path is BigModel-only.)
 */
const ZCODE_API_BASE = process.env.ZCODE_API_BASE_URL || config.apiBaseUrl;
const MAX_POLL_DURATION_MS = 300 * 1000;

function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (base64.length % 4)) % 4;
    const padded = base64 + "=".repeat(padding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function isValidEmail(value) {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

function normalizeEmail(value) {
  if (!isValidEmail(value)) return undefined;
  return value.trim();
}

function extractEmailFromJwt(jwt) {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return undefined;
  return normalizeEmail(payload.email || payload.preferred_username);
}

function extractZcodeUserId(jwt) {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return undefined;
  const id = payload.user_id || payload.userId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function extractEmailFromPollData(pollData) {
  if (!pollData || typeof pollData !== "object") return undefined;
  const zai = pollData.zai || {};
  const candidates = [
    pollData.email,
    pollData.user_email,
    pollData.userEmail,
    zai.email,
    zai.user_email,
    zai.userEmail,
    zai.account_email,
    pollData.user?.email,
    zai.user?.email,
  ];
  for (const candidate of candidates) {
    const email = normalizeEmail(candidate);
    if (email) return email;
  }
  return undefined;
}

function extractEmailFromCustomerInfo(data) {
  if (!data || typeof data !== "object") return undefined;
  const candidates = [
    data.email,
    data.userEmail,
    data.user_email,
    data.customerEmail,
    data.accountEmail,
    data.loginEmail,
    data.mail,
    data.user?.email,
    data.customer?.email,
    data.profile?.email,
    data.accountInfo?.email,
  ];
  for (const candidate of candidates) {
    const email = normalizeEmail(candidate);
    if (email) return email;
  }
  for (const org of data.organizations || []) {
    const email = normalizeEmail(org.email || org.ownerEmail || org.contactEmail);
    if (email) return email;
  }
  return undefined;
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Z.AI OAuth via ZCode CLI poll (server-mediated callback).
 * Mint coding-plan API key afterward for standard Anthropic endpoint use.
 */
export class ZaiAuthFlow {
  constructor(apiBaseUrl = ZCODE_API_BASE, pollToken = null) {
    this.apiBaseUrl = apiBaseUrl;
    this.pollToken = pollToken || crypto.randomBytes(32).toString("hex");
    this.provider = "zai";
    this.flowId = null;
    this.authorizeUrl = null;
    this.expiresAt = null;
    this.pollIntervalSec = 2;
    this._timeoutId = null;
    this._closed = false;
  }

  /**
   * Start CLI login flow. Returns server-provided authorize_url
   * (redirect_uri is zcode.z.ai's own callback — no local server).
   */
  async start() {
    const res = await fetch(`${this.apiBaseUrl}/oauth/cli/init`, {
      method: "POST",
      headers: buildZcodeGuiRequestHeaders({
        Authorization: `Bearer ${this.pollToken}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ provider: this.provider }),
    });

    const text = await res.text();
    const json = safeJson(text);
    if (!res.ok || !json || typeof json.code !== "number" || json.code !== 0) {
      throw new Error(
        `Z.AI OAuth init failed: ${res.status} ${json?.msg || text.slice(0, 300)}`
      );
    }

    const data = json.data || {};
    const flowId = typeof data.flow_id === "string" ? data.flow_id.trim() : "";
    const rawAuthorizeUrl =
      typeof data.authorize_url === "string" ? data.authorize_url.trim() : "";
    if (
      !flowId ||
      !rawAuthorizeUrl ||
      typeof data.expires_at !== "number" ||
      typeof data.poll_interval_sec !== "number"
    ) {
      throw new Error("Z.AI OAuth init: invalid response data");
    }

    const serverExpiresAt = data.expires_at * 1000;
    const pollIntervalMs = data.poll_interval_sec * 1000;
    const remainingMs = serverExpiresAt - Date.now();
    if (
      !Number.isFinite(serverExpiresAt) ||
      !Number.isFinite(pollIntervalMs) ||
      remainingMs <= 0 ||
      pollIntervalMs < 1000 ||
      pollIntervalMs >= remainingMs
    ) {
      throw new Error("Z.AI OAuth init: invalid response data");
    }

    const authorizeUrl = new URL(rawAuthorizeUrl);
    if (authorizeUrl.protocol !== "https:" || !authorizeUrl.searchParams.get("state")?.trim()) {
      throw new Error("Z.AI OAuth init: invalid response data");
    }
    const desktopRedirect = new URL("/app/oauth/login", this.apiBaseUrl);
    desktopRedirect.searchParams.set("redirect", "zcode://oauth/callback");
    desktopRedirect.searchParams.set("app_version", config.appVersion);
    authorizeUrl.searchParams.set("redirect_uri", desktopRedirect.toString());

    this.flowId = flowId;
    this.authorizeUrl = authorizeUrl.toString();
    this.expiresAt = Math.min(Date.now() + MAX_POLL_DURATION_MS, serverExpiresAt);
    this.pollIntervalSec = data.poll_interval_sec;

    return {
      flowId: this.flowId,
      authorizeUrl: this.authorizeUrl,
      pollToken: this.pollToken,
      provider: this.provider,
    };
  }

  /**
   * One non-blocking poll. Returns {status:"pending"|"ready"|"failed", ...}.
   * On ready: { status, token, zai, user, email, name, raw }.
   */
  async poll() {
    if (!this.flowId) {
      return { status: "failed", error: "OAuth flow not started" };
    }
    if (this.expiresAt && Date.now() >= this.expiresAt) {
      return { status: "failed", error: "Authorization timed out" };
    }

    let res;
    try {
      res = await fetch(
        `${this.apiBaseUrl}/oauth/cli/poll/${encodeURIComponent(this.flowId)}`,
        {
          method: "GET",
          headers: buildZcodeGuiRequestHeaders({
            Authorization: `Bearer ${this.pollToken}`,
          }),
        }
      );
    } catch {
      return { status: "pending" };
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return { status: "pending" };
    }

    const text = await res.text();
    const json = safeJson(text);
    if (!res.ok || !json || typeof json.code !== "number" || json.code !== 0) {
      throw new Error(
        `Z.AI OAuth poll failed: ${res.status} ${json?.msg || text.slice(0, 300)}`
      );
    }

    const data = json.data || {};
    const status = data.status;

    if (status === "ready") {
      const user = data.user;
      const zai = data.zai;
      const token = typeof data.token === "string" ? data.token.trim() : "";
      const userId = typeof user?.user_id === "string" ? user.user_id.trim() : "";
      const accessToken =
        typeof zai?.access_token === "string" ? zai.access_token.trim() : "";
      if (
        !token ||
        !user ||
        typeof user !== "object" ||
        Array.isArray(user) ||
        !userId ||
        !zai ||
        typeof zai !== "object" ||
        Array.isArray(zai) ||
        !accessToken
      ) {
        throw new Error("Z.AI OAuth poll: invalid ready response data");
      }
      const avatar = typeof user.avatar === "string" ? user.avatar.trim() : "";
      const email = typeof user.email === "string" ? user.email.trim() : "";
      const name = typeof user.name === "string" ? user.name.trim() : "";
      return {
        status: "ready",
        token,
        zai: { access_token: accessToken },
        user: {
          user_id: userId,
          ...(avatar ? { avatar } : {}),
          ...(email ? { email } : {}),
          ...(name ? { name } : {}),
        },
        email: normalizeEmail(email),
        name: name || undefined,
        raw: data,
      };
    }

    if (status === "failed") {
      return { status: "failed", error: "Authorization failed or was denied" };
    }

    if (status !== "pending") {
      throw new Error("Z.AI OAuth poll: invalid response data");
    }

    if (this.expiresAt && Date.now() > this.expiresAt) {
      return { status: "failed", error: "Authorization timed out" };
    }

    return { status: "pending" };
  }

  /** Seconds the client should wait before the next poll. */
  get nextPollDelayMs() {
    return Math.max(1, this.pollIntervalSec) * 1000;
  }

  /** Block until poll returns non-pending (or timeout). */
  async waitForAuthorization(timeoutMs = MAX_POLL_DURATION_MS) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const data = await this.poll();
      if (data.status !== "pending") return data;
      if (Date.now() >= deadline) {
        return { status: "failed", error: "Authorization timed out" };
      }
      await new Promise((r) => setTimeout(r, this.nextPollDelayMs));
    }
  }

  close() {
    this._closed = true;
    this.flowId = null;
  }

  /**
   * After OAuth: biz login → org/project → mint zcode-api-key → apiKey.secretKey.
   * Same provisioning as official client / cliproxy MintAPIKey.
   */
  async exchangeForConnection(accessToken, zcodeJwtToken, pollData = null) {
    const { bizToken, loginData } = await this._fetchBizToken(accessToken);
    const { orgId, projId, customerInfo } = await this._getOrgAndProject(bizToken);
    const fullKey = await this._getOrCreateApiKey(bizToken, orgId, projId);
    const zcodeUserId = extractZcodeUserId(zcodeJwtToken) || extractZcodeUserId(accessToken);

    const email =
      extractEmailFromPollData(pollData) ||
      extractEmailFromCustomerInfo(customerInfo) ||
      normalizeEmail(loginData.email || loginData.userEmail || loginData.user_email) ||
      extractEmailFromJwt(zcodeJwtToken) ||
      extractEmailFromJwt(accessToken) ||
      undefined;

    const zai = pollData?.zai || {};
    const refreshToken =
      typeof zai.refresh_token === "string" && zai.refresh_token.trim()
        ? zai.refresh_token.trim()
        : undefined;
    const expiresIn =
      typeof zai.expires_in === "number" && zai.expires_in > 0
        ? zai.expires_in
        : ZCODE_ZAI_DEFAULT_EXPIRES_IN;

    // Coding Plan models → minted API key on api.z.ai (no captcha).
    // Start Plan models (glm-5.3*) → JWT on zcode.z.ai (captcha-gated; executor handles).
    return {
      apiKey: fullKey,
      accessToken: bizToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(refreshToken || zai.expires_in
        ? {
            expiresIn,
            expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
          }
        : {}),
      email,
      name: email || undefined,
      providerSpecificData: {
        authMethod: "zcode_oauth",
        // Native ZCode OAuth inference uses zcode-plan with the login JWT.
        useCodingPlan: true,
        zcodeJwtToken: zcodeJwtToken || undefined,
        zaiAccessToken: accessToken,
        ...(refreshToken ? { zaiRefreshToken: refreshToken } : {}),
        ...(zcodeUserId ? { zcodeUserId } : {}),
      },
    };
  }

  async _fetchBizToken(accessToken) {
    const loginRes = await fetch("https://api.z.ai/api/auth/z/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: accessToken }),
    });
    if (!loginRes.ok) throw new Error("Failed to exchange business token");
    const loginJson = await loginRes.json();
    const bizToken = loginJson.data?.access_token || loginJson.data?.accessToken;
    if (!bizToken) throw new Error("Business credentials missing from response");
    return { bizToken, loginData: loginJson.data || {} };
  }

  async _getOrgAndProject(bizToken) {
    const infoRes = await fetch("https://api.z.ai/api/biz/customer/getCustomerInfo", {
      method: "GET",
      headers: { Authorization: `Bearer ${bizToken}` },
    });
    if (!infoRes.ok) throw new Error("Failed to fetch organization info");
    const infoJson = await infoRes.json();

    const orgs = infoJson.data?.organizations || [];
    if (!orgs.length) throw new Error("No available organization found");
    let targetOrg = null;
    for (const o of orgs) {
      if (!o.projects?.length) continue;
      if (o.organizationName?.includes("默认机构")) {
        targetOrg = o;
        break;
      }
      if (!targetOrg) targetOrg = o;
    }
    if (!targetOrg) targetOrg = orgs[0];
    if (!targetOrg.projects?.length) throw new Error("No available project found");

    const projects = targetOrg.projects;
    const targetProj = projects.find((p) => p.projectName?.includes("默认项目")) || projects[0];

    return {
      orgId: targetOrg.organizationId,
      projId: targetProj.projectId,
      customerInfo: infoJson.data || {},
    };
  }

  async _getOrCreateApiKey(bizToken, orgId, projId) {
    const keyUrl = `https://api.z.ai/api/biz/v1/organization/${orgId}/projects/${projId}/api_keys`;
    const keysRes = await fetch(keyUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${bizToken}` },
    });
    if (!keysRes.ok) throw new Error("Failed to fetch API Keys");
    const keysJson = await keysRes.json();
    const keys = keysJson.data || [];

    let keyObj = keys.find((k) => k.name === "zcode-api-key");
    if (!keyObj) {
      const createRes = await fetch(keyUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bizToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "zcode-api-key" }),
      });
      if (!createRes.ok) throw new Error("Failed to create API Key");
      const createJson = await createRes.json();
      keyObj = createJson.data;
    }

    const apiKey = keyObj?.apiKey;
    if (!apiKey) throw new Error("Failed to obtain API Key");

    const copyRes = await fetch(`${keyUrl}/copy/${encodeURIComponent(apiKey)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${bizToken}` },
    });
    if (!copyRes.ok) throw new Error("Failed to fetch Secret Key");
    const copyJson = await copyRes.json();
    const secretKey = copyJson.data?.secretKey;
    if (!secretKey) throw new Error("Failed to decrypt Secret Key");

    return `${apiKey}.${secretKey}`;
  }
}
