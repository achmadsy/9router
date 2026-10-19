import { cookies } from "next/headers";
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
  // 1. Check CLI token
  const cliToken = request?.headers?.get?.(CLI_TOKEN_HEADER);
  if (cliToken) {
    const expected = await getCliToken();
    if (expected && cliToken === expected) {
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

  const ownerId = session.sub || session.id || session.username || "admin:session";
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
    const hostHeader = request.headers.get("host") || "";
    const hostName = hostHeader.split(":")[0].toLowerCase();
    const originHost = originUrl.hostname.toLowerCase();

    if (originHost === hostName) return true;
    if (LOOPBACK_HOSTS.has(originHost) && LOOPBACK_HOSTS.has(hostName)) return true;

    const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
    if (baseUrl) {
      const baseHostname = new URL(baseUrl).hostname.toLowerCase();
      if (originHost === baseHostname) return true;
    }

    return false;
  } catch {
    return false;
  }
}
