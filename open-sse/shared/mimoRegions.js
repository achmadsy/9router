/**
 * Xiaomi MiMo account-service regions.
 *
 * MiMo Desktop picks a regional account service at sign-in. The choice is visible in
 * the OAuth callback (`sid=mimopc` for China, `sid=mimosgp` for Singapore) and in the
 * Desktop cookie store's `state` cookie, whose `callback` URL points at that region's
 * host. The CN and SGP services hold separate entitlements, so a membership check run
 * against the wrong region fails with `membership_required` (biz_code 30012) even for
 * an account that is entitled — which is exactly why this must not be hardcoded.
 *
 * The registry entry is the single source of truth (see
 * providers/registry/xiaomi-mimo.js). This module only resolves it:
 *   explicit override -> value detected from the Desktop cookie -> default.
 */

import { PROVIDERS } from "../providers/index.js";

const DEFAULT_REGION = "cn";

// PROVIDERS[id] IS the transport object (providers/index.js lifts transport to the
// top level), so regions/defaultRegion sit directly on it.
/** Region table from the registry: { [id]: { host, sid } } */
export const MIMO_REGIONS = PROVIDERS["xiaomi-mimo"]?.regions || {};

/** Region id -> host, for the allowlist check. */
const ALLOWED_HOSTS = new Set(
  Object.values(MIMO_REGIONS)
    .map((r) => r?.host)
    .filter(Boolean),
);

/**
 * Normalize a candidate account service into a known region.
 * Anything not present in the registry allowlist is discarded — the detected host
 * comes from a cookie the Desktop wrote, but it is still client-side input and must
 * never be interpolated into an outbound URL unchecked (SSRF).
 * @returns {{ id: string, host: string, sid: string }|null}
 */
function normalize(candidate) {
  if (!candidate) return null;

  const host = typeof candidate.host === "string" ? candidate.host.trim().toLowerCase() : "";
  if (host && ALLOWED_HOSTS.has(host)) {
    for (const [id, region] of Object.entries(MIMO_REGIONS)) {
      if (region?.host === host) return { id, host: region.host, sid: region.sid };
    }
  }

  // No usable host — the region id, or the service SID it maps to, is still enough.
  // Both spellings are accepted: "sgp" (what the UI stores) and "mimosgp" (what the
  // Desktop `state` cookie reports).
  const key = typeof candidate.sid === "string" ? candidate.sid.trim() : "";
  if (key) {
    if (MIMO_REGIONS[key]) {
      return { id: key, host: MIMO_REGIONS[key].host, sid: MIMO_REGIONS[key].sid };
    }
    for (const [id, region] of Object.entries(MIMO_REGIONS)) {
      if (region?.sid === key) return { id, host: region.host, sid: region.sid };
    }
  }

  return null;
}

/**
 * Resolve the account service for this connection.
 *
 * @param {object|null} providerSpecificData - `mimoRegion` (set by the OAuth/import
 *   flows) or `region` (the generic key the Edit Connection dropdown writes, shared
 *   with xiaomi-tokenplan) is the explicit override
 * @param {{host?:string, sid?:string}|null} [detected] - from the Desktop cookie store
 * @returns {{ id: string, host: string, sid: string }}
 */
export function resolveMimoAccount(providerSpecificData = null, detected = null) {
  const override = normalize({ sid: providerSpecificData?.mimoRegion || providerSpecificData?.region });
  if (override) return override;

  const fromCookie = normalize(detected);
  if (fromCookie) return fromCookie;

  const fallback = MIMO_REGIONS[DEFAULT_REGION];
  return { id: DEFAULT_REGION, host: fallback.host, sid: fallback.sid };
}

/**
 * Cookie names the account service stamps beside `serviceToken`, derived from the
 * service scope (`mimopc_ph`/`mimopc_slh` for China, `mimosgp_*` for Singapore).
 * @param {string} sid
 */
export function scopedCookieNames(sid) {
  return [`${sid}_ph`, `${sid}_slh`];
}

/**
 * Extract the region a Desktop sign-in selected from its `state` cookie.
 *
 * The cookie is a hex-encoded JSON blob:
 *   { "sid": "mimosgp", "callback": "https://mimo-server-sgp.xiaomimimo.com/api/sts?..." }
 * Both `callback` (URL-encoded) and `state` are treated as untrusted — parse
 * defensively and let `resolveMimoAccount` reject anything unrecognized.
 *
 * @param {string} hexState
 * @returns {{host: string|null, sid: string|null}|null}
 */
export function parseRegionFromStateCookie(hexState) {
  if (typeof hexState !== "string" || !hexState.trim()) return null;
  try {
    const json = Buffer.from(hexState.trim(), "hex").toString("utf-8");
    const state = JSON.parse(json);
    if (!state || typeof state !== "object") return null;

    let host = null;
    if (typeof state.callback === "string") {
      try {
        host = new URL(decodeURIComponent(state.callback)).hostname.toLowerCase() || null;
      } catch {
        host = null; // malformed callback URL — fall back to the sid
      }
    }

    const sid = typeof state.sid === "string" && state.sid.trim() ? state.sid.trim() : null;
    if (!host && !sid) return null;
    return { host, sid };
  } catch {
    return null; // not hex, not JSON, or not an object
  }
}
