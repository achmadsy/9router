import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

function bypassesHost(host, value) {
  return String(value || "").toLowerCase().split(",").map((entry) => entry.trim()).filter(Boolean).some((pattern) => {
    const domain = pattern.replace(/^\./, "");
    return pattern === "*" || host === domain || host.endsWith(`.${domain}`);
  });
}

function invalidRoute(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** Explicit Z.AI control-plane route. Never accepts proxy URLs from the client. */
export function validateZaiNetworkRoute(value = "account") {
  if (typeof value !== "string" || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value.trim())) {
    throw invalidRoute("Invalid Z.AI network route");
  }
  return value.trim(); // account, direct, or a saved pool id
}

export async function resolveZaiNetwork(value = "account", providerSpecificData = {}) {
  const route = validateZaiNetworkRoute(value);
  const hasAccountProxy = (providerSpecificData.proxyPoolId && providerSpecificData.proxyPoolId !== "__none__")
    || providerSpecificData.connectionProxyEnabled === true;
  if (route === "direct" || (route === "account" && !hasAccountProxy && providerSpecificData.zaiPlanNetworkRoute === "direct")) {
    return {
      proxyOptions: { forceDirect: true, connectionProxyEnabled: false },
      network: { route, source: "direct", label: "Direct (server IP; environment proxy bypassed)" },
    };
  }

  const data = route === "account" ? providerSpecificData : { proxyPoolId: route };
  const options = await resolveConnectionProxyConfig(data, { excludeRelay: true });
  const poolId = data.proxyPoolId && data.proxyPoolId !== "__none__" ? data.proxyPoolId : null;
  const intended = !!poolId || data.connectionProxyEnabled === true;
  if (intended && (!options.connectionProxyEnabled || !options.connectionProxyUrl
      || (poolId && (options.source !== "pool" || options.proxyPoolId !== poolId)))) {
    throw invalidRoute("Selected Z.AI proxy is unavailable, inactive, or a relay. Select an active HTTP(S) proxy pool or explicitly choose Direct; no fallback was sent.");
  }
  if (options.connectionProxyEnabled) {
    if (["api.z.ai", "zcode.z.ai"].some((host) => bypassesHost(host, options.connectionNoProxy))) {
      throw invalidRoute("The selected proxy bypass list excludes Z.AI. Remove that exclusion or explicitly choose Direct; no fallback was sent.");
    }
    let protocol;
    try { protocol = new URL(options.connectionProxyUrl).protocol; } catch { /* rejected below */ }
    if (!["http:", "https:"].includes(protocol)) {
      throw invalidRoute("Z.AI plan requests require an HTTP(S) proxy URL. Use the HTTP port of your proxy, not a SOCKS or relay URL.");
    }
    return {
      // Plan provisioning/claims must not be replayed over a different egress.
      proxyOptions: { ...options, strictProxy: true },
      network: { route, source: options.source, poolId: options.proxyPoolId || null,
        label: options.source === "pool" ? `Proxy pool: ${options.proxyPool?.name || options.proxyPoolId}` : "Account proxy",
        strictProxy: true },
    };
  }
  return {
    proxyOptions: { ...options, strictProxy: true },
    network: { route, source: "default", label: "Server default (environment proxy, otherwise direct)" },
  };
}

/** Captcha browser must share the claim endpoint's effective egress. */
export function zaiCaptchaProxyUrl(proxyOptions) {
  if (proxyOptions?.forceDirect) return "";
  if (proxyOptions?.connectionProxyEnabled) return proxyOptions.connectionProxyUrl || "";
  if (bypassesHost("zcode.z.ai", process.env.NO_PROXY || process.env.no_proxy)) return "";
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || "";
}

/** Only store the selection; pool credentials stay in the pool repository. */
export function zaiNetworkConnectionData(route) {
  if (route === "direct") return { zaiPlanNetworkRoute: "direct" };
  if (route && route !== "account") return { proxyPoolId: route };
  return {};
}
