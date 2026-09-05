/**
 * ZCode CLI OAuth flow implementation (subscription-only).
 * Initiates CLI login at https://zcode.z.ai/api/v1/oauth/cli/init
 * Polls at https://zcode.z.ai/api/v1/oauth/cli/poll/:flowId
 */

import { randomBytes } from "node:crypto";
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const ZCODE_CLI_INIT_URL = "https://zcode.z.ai/api/v1/oauth/cli/init";
const ZCODE_CLI_POLL_URL = "https://zcode.z.ai/api/v1/oauth/cli/poll";
const SESSION_TTL_MS = 10 * 60 * 1000;

const kv = makeKv("zcodeOAuthSessions");
const memorySessions = new Map();

function parseJwtEmail(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return payload.email || payload.user_email || payload.sub || null;
  } catch {
    return null;
  }
}

export class ZcodeAuthService {
  async initFlow() {
    const pollToken = randomBytes(32).toString("hex");
    const response = await fetch(ZCODE_CLI_INIT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pollToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "zai" }),
    });

    if (!response.ok) {
      throw new Error(`ZCode auth init failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    const flowId = json.data?.flow_id || json.data?.flowId;
    const authorizeUrl = json.data?.authorize_url || json.data?.authorizeUrl;

    if (!flowId || !authorizeUrl) {
      throw new Error("Invalid response from ZCode OAuth init endpoint");
    }

    const session = {
      flowId,
      pollToken,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };

    memorySessions.set(flowId, session);
    try {
      await kv.set(flowId, session);
    } catch {
      // memory fallback
    }

    return {
      flowId,
      authorizeUrl,
    };
  }

  async pollFlow(flowId) {
    let session = memorySessions.get(flowId);
    if (!session) {
      try {
        session = await kv.get(flowId);
      } catch {
        session = null;
      }
    }

    if (!session || session.expiresAt < Date.now()) {
      return {
        status: "expired",
        error: "OAuth session expired or not found",
      };
    }

    const url = `${ZCODE_CLI_POLL_URL}/${encodeURIComponent(flowId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.pollToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return {
        status: "failed",
        error: `Polling failed with status ${response.status}`,
      };
    }

    const json = await response.json();
    const data = json?.data || {};

    if (data.status === "pending") {
      return { status: "pending" };
    }

    if (data.status === "failed") {
      memorySessions.delete(flowId);
      try { await kv.remove(flowId); } catch {}
      return { status: "failed", error: "Authorization denied" };
    }

    if (data.status === "ready" || data.token) {
      const zcodeJwtToken = data.token;
      if (!zcodeJwtToken) {
        return { status: "failed", error: "Missing Coding Plan token from response" };
      }

      memorySessions.delete(flowId);
      try { await kv.remove(flowId); } catch {}

      const email =
        parseJwtEmail(zcodeJwtToken) ||
        data.email ||
        data.user_email ||
        `zcode-${flowId.slice(0, 8)}`;

      return {
        status: "ready",
        tokens: {
          accessToken: zcodeJwtToken,
          email,
          displayName: email,
          expiresIn: 30 * 24 * 3600, // JWT session roughly 30 days
          providerSpecificData: {
            authMethod: "zcode_oauth",
            useCodingPlan: true,
            zcodeJwtToken,
            flowId,
          },
        },
      };
    }

    return { status: data.status || "pending" };
  }
}

export default ZcodeAuthService;
