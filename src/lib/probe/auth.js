import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { verifyDashboardAuthToken, getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

let cachedCliToken = null;
async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

/**
 * Always-protected admin verification.
 * Requires:
 * 1) Valid CLI token (x-9r-cli-token matching machineId)
 * OR
 * 2) Valid JWT session (cookie auth_token or Authorization: Bearer <token>)
 *
 * NEVER bypassed when requireLogin=false.
 * Returns { authorized: boolean, ownerId: string | null }
 */
export async function verifyProbeAdminAuth(request) {
  // 1. Check CLI token (constant-time compare)
  const cliToken = request?.headers?.get?.(CLI_TOKEN_HEADER);
  if (cliToken) {
    const expected = await getCliToken();
    if (expected && cliToken.length === expected.length &&
        timingSafeEqual(Buffer.from(cliToken), Buffer.from(expected))) {
      return { authorized: true, ownerId: "cli:machine" };
    }
  }

  // 2. Check Bearer token in Authorization header
  let token = null;
  const authHeader = request?.headers?.get?.("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }

  // 3. Check auth_token cookie
  if (!token) {
    try {
      const cookieStore = await cookies();
      token = cookieStore.get("auth_token")?.value;
    } catch {
      // In standalone request contexts or test mocks
      const cookieHeader = request?.headers?.get?.("cookie");
      if (cookieHeader) {
        const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
        if (match) token = match[1];
      }
    }
  }

  if (!token) {
    return { authorized: false, ownerId: null };
  }

  const session = await getDashboardAuthSession(token);
  if (!session || !session.authenticated) {
    return { authorized: false, ownerId: null };
  }

  const ownerId =
    session.sub ||
    session.id ||
    session.username ||
    session.samlEmail || // SAML sessions carry identity, not a local account id
    session.oidcEmail ||
    session.oidcSub ||
    "admin:session";
  return { authorized: true, ownerId };
}

/**
 * Verify request origin against Host/loopback/Base URL to prevent CSRF.
 */
export function verifyCsrfOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      return false;
    }
    return true; // Non-browser clients (curl/CLI) without Origin header
  }

  try {
    const originUrl = new URL(origin);
    // Host may be IPv6-bracketed ("[::1]:20128") — parse via URL, don't split on ":".
    const hostHeader = request.headers.get("host") || "";
    let hostUrl = null;
    try {
      // Build the expected origin from request/proxy metadata, never from the
      // untrusted Origin header itself. Only accept canonical proxy schemes.
      const forwardedProto = request.headers.get("x-forwarded-proto")?.toLowerCase();
      const requestProtocol = new URL(request.url).protocol;
      const scheme =
        forwardedProto === "http" || forwardedProto === "https"
          ? forwardedProto
          : requestProtocol.slice(0, -1);
      hostUrl = new URL(`${scheme}://${hostHeader}`);
    } catch {
      hostUrl = null;
    }
    const originOrigin = originUrl.origin;
    const originHost = originUrl.hostname.toLowerCase();

    if (hostUrl && originOrigin === hostUrl.origin) return true;
    // Loopback fallback tolerates hostname variation (127.0.0.1 vs ::1) while
    // retaining exact scheme and port checks.
    if (
      hostUrl &&
      originUrl.protocol === hostUrl.protocol &&
      originUrl.port === hostUrl.port &&
      LOOPBACK_HOSTS.has(originHost) &&
      LOOPBACK_HOSTS.has(hostUrl.hostname.toLowerCase())
    ) {
      return true;
    }

    const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
    if (baseUrl) {
      try {
        if (originOrigin === new URL(baseUrl).origin) return true;
      } catch {
        // Malformed configured URL cannot authorize an origin.
      }
    }

    return false;
  } catch {
    return false;
  }
}
