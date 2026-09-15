import { machineIdSync } from "node-machine-id";
import { FREEBUFF_CONFIG } from "../constants/oauth.js";

/**
 * Freebuff / Codebuff custom device-code login (NOT standard OAuth2 device grant).
 *
 * Wire protocol (from CodebuffAI/freebuff CLI):
 *   1) POST {apiBaseUrl}/api/auth/cli/code  body { fingerprintId }
 *        → { loginUrl, fingerprintHash, expiresAt [, expiresInMs] }
 *   2) User opens loginUrl in a browser and signs in.
 *   3) GET  {apiBaseUrl}/api/auth/cli/status
 *        ?fingerprintId=&fingerprintHash=&expiresAt=
 *        → 200 { user, authToken } on success
 *        → still waiting otherwise (authorization_pending).
 *
 * fingerprintId is the device/machine mid: hardware-based (`enhanced-<sha256>`)
 * or a legacy `codebuff-cli-<rand>` fallback. Stable for the process.
 */

const fingerprintCache = new Map();

function makeLegacyFingerprint() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `codebuff-cli-${rand}`;
}

/**
 * Stable device fingerprint for this process. Prefer hardware mid when
 * node-machine-id is available; fall back to a random CLI fingerprint.
 */
async function ensureFingerprintId() {
  const key = "default";
  if (fingerprintCache.has(key)) return fingerprintCache.get(key);

  let fingerprintId = null;
  try {
    const os = await import("node:os");
    const { createHash } = await import("node:crypto");
    const machineId = machineIdSync();
    if (!machineId || machineId === "unknown" || machineId.length < 8) {
      throw new Error("Invalid machine ID returned");
    }
    const network = os.networkInterfaces();
    const macAddresses = Object.values(network)
      .flat()
      .filter(
        (iface) =>
          iface &&
          !iface.internal &&
          iface.mac &&
          iface.mac !== "00:00:00:00:00:00",
      )
      .map((iface) => iface.mac)
      .sort();
    const fingerprintInfo = {
      system: { manufacturer: "", model: "", serial: "", uuid: "" },
      cpu: {
        manufacturer: "",
        brand: os.cpus()?.[0]?.model || "",
        cores: os.cpus().length,
        physicalCores: 0,
      },
      os: {
        platform: os.platform(),
        distro: "",
        arch: os.arch(),
        hostname: os.hostname(),
      },
      runtime: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        shell: process.env.SHELL || "",
        cpuCount: os.cpus().length,
      },
      network: {
        macAddresses,
        interfaceCount: Object.keys(network).length,
      },
      machineId,
      fingerprintVersion: "2.0",
    };
    fingerprintId = `enhanced-${createHash("sha256")
      .update(JSON.stringify(fingerprintInfo))
      .digest("base64url")}`;
  } catch {
    fingerprintId = makeLegacyFingerprint();
  }

  if (!fingerprintId || fingerprintId === "enhanced-" || fingerprintId.length < 8) {
    fingerprintId = makeLegacyFingerprint();
  }

  fingerprintCache.set(key, fingerprintId);
  return fingerprintId;
}

async function fetchJson(url, init, timeoutMs = 30000) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

const freebuff = {
  config: FREEBUFF_CONFIG,
  flowType: "device_code",

  /**
   * Start a login attempt. Returns a device_code-shaped payload so the shared
   * OAuthModal can open verification_uri and poll.
   *
   * device_code = fingerprintId (modal forwards as deviceCode on poll)
   * codeVerifier = unused (no PKCE) — set null so poll route skips PKCE check
   */
  requestDeviceCode: async (config) => {
    const fingerprintId = await ensureFingerprintId();
    const baseUrl = (config.apiBaseUrl || "https://freebuff.com").replace(/\/$/, "");
    const initiateUrl = config.initiateUrl || `${baseUrl}/api/auth/cli/code`;

    const { ok, status, data } = await fetchJson(initiateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ fingerprintId }),
    });

    if (!ok || !data?.loginUrl) {
      const msg = data?.error || data?.message || `HTTP ${status}`;
      throw new Error(`Freebuff login initiation failed: ${msg}`);
    }

    // expiresAt is the SERVER's instant — must be echoed back byte-for-byte
    // (HMAC input). Do not recompute from client clock.
    const expiresInMs =
      Number.isFinite(data.expiresInMs) && data.expiresInMs > 0
        ? data.expiresInMs
        : 3600 * 1000;

    return {
      device_code: fingerprintId,
      user_code: data.loginUrl,
      verification_uri: data.loginUrl,
      verification_uri_complete: data.loginUrl,
      expires_in: Math.max(30, Math.floor(expiresInMs / 1000)),
      interval: 3,
      // Plumb through for pollToken via extraData (OAuthModal maps these).
      _freebuffFingerprintHash: data.fingerprintHash,
      _freebuffExpiresAt: data.expiresAt,
      _freebuffFingerprintId: fingerprintId,
      _freebuffLoginUrl: data.loginUrl,
    };
  },

  /**
   * Poll login status until the user finishes browser sign-in.
   * extraData carries fingerprintHash + expiresAt from requestDeviceCode.
   */
  pollToken: async (config, deviceCode, _codeVerifier, extraData) => {
    const fingerprintId =
      deviceCode || extraData?._freebuffFingerprintId || (await ensureFingerprintId());
    const fingerprintHash = extraData?._freebuffFingerprintHash;
    const expiresAt = extraData?._freebuffExpiresAt;

    if (!fingerprintId || !fingerprintHash || !expiresAt) {
      return {
        ok: false,
        data: {
          error: "invalid_request",
          error_description: "Missing freebuff fingerprint state",
        },
      };
    }

    const baseUrl = (config.apiBaseUrl || "https://freebuff.com").replace(/\/$/, "");
    const statusUrl = config.statusUrl || `${baseUrl}/api/auth/cli/status`;
    const qs = new URLSearchParams({
      fingerprintId,
      fingerprintHash,
      expiresAt,
    });

    let result;
    try {
      result = await fetchJson(`${statusUrl}?${qs.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      return {
        ok: false,
        data: {
          error: "poll_failed",
          error_description: err?.message || String(err),
        },
      };
    }

    // Still waiting for the browser sign-in. The official CLI treats 401 as
    // expected pending state (it suppresses the "unexpected status" warning).
    if (result.status === 401 || result.status === 404 || result.status === 202) {
      return { ok: false, data: { error: "authorization_pending" } };
    }
    if (result.status === 410 || result.status === 400) {
      // Code expired / invalid — treat as expired token for the modal.
      return {
        ok: false,
        data: {
          error: "expired_token",
          error_description: "Login code expired. Please try again.",
        },
      };
    }
    if (result.status === 403) {
      return {
        ok: false,
        data: {
          error: "access_denied",
          error_description: "Authorization denied by user",
        },
      };
    }
    if (!result.ok) {
      const msg =
        result.data?.error ||
        result.data?.message ||
        `HTTP ${result.status}`;
      return { ok: false, data: { error: "poll_failed", error_description: msg } };
    }

    // Success: server returns the signed-in user (and often authToken on the body).
    const authToken =
      result.data?.authToken ||
      result.data?.token ||
      result.data?.user?.authToken;
    if (!authToken) {
      return { ok: false, data: { error: "authorization_pending" } };
    }

    const user = result.data?.user || result.data || {};
    return {
      ok: true,
      data: {
        access_token: authToken,
        refresh_token: null,
        expires_in: null,
        _userEmail: user.email || null,
        _userName: user.name || null,
        _userId: user.id || null,
        _fingerprintId: fingerprintId,
        _fingerprintHash: fingerprintHash,
      },
    };
  },

  mapTokens: (tokens) => {
    const email = (tokens._userEmail || "").trim() || null;
    const displayName = (tokens._userName || "").trim() || null;
    const userId = tokens._userId || null;
    const fingerprintId = tokens._fingerprintId || null;
    const fingerprintHash = tokens._fingerprintHash || null;
    return {
      accessToken: tokens.access_token,
      refreshToken: null,
      // Account authToken is long-lived; leave expiresAt null so 9router
      // does not try to refresh (there is no refresh endpoint).
      expiresIn: null,
      email,
      displayName,
      providerSpecificData: {
        authMethod: "device",
        userId,
        fingerprintId,
        fingerprintHash,
        // Device mid used by free-mode admission + usage.
        deviceMid: fingerprintId,
      },
    };
  },
};

export default freebuff;
