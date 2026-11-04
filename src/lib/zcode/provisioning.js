import config from "./config.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";

async function requestBusiness(url, options, proxyOptions, fetchImpl, diagnostics, step, endpoint) {
  const started = Date.now();
  diagnostics?.event(step, "request", { method: options.method, endpoint });
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      strictTls: true,
      signal: AbortSignal.timeout(15_000),
    }, proxyOptions);
  } catch (error) {
    if (error?.httpStatus === 429) throw error;
    diagnostics?.event(step, "failed", { endpoint, durationMs: Date.now() - started, reason: "Network request failed or timed out" });
    throw new Error("ZCode provisioning network request failed");
  }
  const json = await response.json().catch(() => null);
  // Native 3.17.2 accepts omitted codes and numeric/string 0 or 200.
  const code = json?.code;
  const successfulCode = code == null || [0, 200, "0", "200"].includes(code);
  const accepted = response.ok && !!json && json.success !== false && successfulCode;
  diagnostics?.event(step, accepted ? "response" : "failed", {
    endpoint, httpStatus: response.status,
    providerCode: Number.isFinite(json?.code) ? json.code : null,
    validJson: !!json, durationMs: Date.now() - started,
  });
  if (!accepted) {
    // Never propagate upstream bodies: these endpoints return credentials.
    const safeCode = (typeof code === "number" || typeof code === "string") && Number.isFinite(Number(code)) ? Number(code) : null;
    throw Object.assign(new Error(`ZCode provisioning rejected (HTTP ${response.status}, code ${safeCode ?? "unknown"})`), {
      httpStatus: response.status,
      providerCode: safeCode,
      authenticationRejected: response.status === 401 || code === 401 || code === "401",
    });
  }
  return json.data;
}

const customerInfoEndpoint = "https://api.z.ai/api/biz/customer/getCustomerInfo";

/** Native persists the exchanged business token, not the short-lived OAuth
 * source token. Validate that saved credential before considering re-exchange.
 * This read-only helper never creates keys, enrolls projects or changes storage.
 */
export async function resolveZcodeBusinessSession(credentials, proxyOptions = null, fetchImpl = proxyAwareFetch, diagnostics = null) {
  const oauthToken = credentials?.providerSpecificData?.zaiAccessToken?.trim();
  const saved = typeof credentials?.accessToken === "string" ? credentials.accessToken.trim() : "";
  const readInfo = (token) => requestBusiness(customerInfoEndpoint, {
    method: "GET",
    headers: { Authorization: token, "Content-Type": "application/json" },
  }, proxyOptions, fetchImpl, diagnostics, "customer-info", customerInfoEndpoint);

  if (saved && saved !== oauthToken && saved !== credentials?.providerSpecificData?.zcodeJwtToken) {
    diagnostics?.event("business-session", "validating", { source: "saved-business-token" });
    try {
      const info = await readInfo(saved);
      if (!info || !Array.isArray(info.organizations)) throw new Error("Invalid Z.AI customer info response; preparation stopped");
      diagnostics?.event("business-session", "validated", { source: "saved-business-token", credentialsChanged: false });
      return { businessToken: saved, info };
    } catch (error) {
      // Only an explicit authentication rejection permits credential exchange.
      // Network/429/malformed responses must not trigger another login attempt.
      if (!error.authenticationRejected) throw error;
      diagnostics?.event("business-session", "rejected", { source: "saved-business-token" });
    }
  }
  if (!oauthToken) throw new Error("Z.AI OAuth login is required; reconnect this account to renew the business session");
  const loginEndpoint = "https://api.z.ai/api/auth/z/login";
  let login;
  try {
    login = await requestBusiness(loginEndpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: oauthToken }),
    }, proxyOptions, fetchImpl, diagnostics, "business-login", loginEndpoint);
  } catch (error) {
    if (error.httpStatus === 429 || !error.httpStatus) throw error;
    throw new Error(`Z.AI business login was rejected (HTTP ${error.httpStatus}, code ${error.providerCode ?? "unknown"}); reconnect this account through Z.AI OAuth`);
  }
  const businessToken = (typeof login?.access_token === "string" ? login.access_token.trim() : "")
    || (typeof login?.accessToken === "string" ? login.accessToken.trim() : "");
  if (!businessToken) throw new Error("Z.AI business login response is missing access_token; reconnect this account");
  diagnostics?.event("business-login", "result", { tokenReturned: true, persisted: false });
  const info = await readInfo(businessToken);
  if (!info || !Array.isArray(info.organizations)) throw new Error("Invalid Z.AI customer info response; preparation stopped");
  return { businessToken, info };
}

/** Native Coding Plan enrollment. The expiring project token is never persisted or returned. */
export async function enrollZcodeProject(credentials, proxyOptions = null, fetchImpl = proxyAwareFetch, diagnostics = null) {
  const { businessToken, info } = await resolveZcodeBusinessSession(credentials, proxyOptions, fetchImpl, diagnostics);
  const organizations = Array.isArray(info?.organizations) ? info.organizations : [];
  const organization = organizations.find((org) => org.organizationName?.includes("默认机构") && org.projects?.length)
    || organizations.find((org) => org.projects?.length);
  const project = organization?.projects.find((entry) => entry.projectName?.includes("默认项目"))
    || organization?.projects[0];
  diagnostics?.event("project-selection", "result", {
    organizations: organizations.length, organizationFound: !!organization?.organizationId, projectFound: !!project?.projectId,
  });
  if (!organization?.organizationId || !project?.projectId) {
    throw new Error("No available ZCode personal project");
  }

  const keyUrl = `https://api.z.ai/api/biz/v1/organization/${encodeURIComponent(organization.organizationId)}/projects/${encodeURIComponent(project.projectId)}/api_keys`;
  const headers = { Authorization: `Bearer ${businessToken}`, "Content-Type": "application/json" };
  // Log a URL template: real path segments contain the account's API-key id.
  const keyEndpoint = "https://api.z.ai/api/biz/v1/organization/{org}/projects/{project}/api_keys";
  const keys = await requestBusiness(keyUrl, { method: "GET", headers }, proxyOptions, fetchImpl,
    diagnostics, "api-key-list", keyEndpoint);
  if (!Array.isArray(keys)) throw new Error("Invalid ZCode project key list");
  // Native ZCode reuses an existing same-name key. Do not delete or migrate it.
  let key = keys.find((entry) => entry.name === "zcode-api-key");
  diagnostics?.event("api-key-selection", "result", {
    keyCount: keys.length, reuseExisting: !!key, usageScene: Number.isFinite(key?.usageScene) ? key.usageScene : null,
  });
  if (!key) {
    key = await requestBusiness(keyUrl, {
      method: "POST", headers,
      body: JSON.stringify({ name: "zcode-api-key", usageScene: 1 }),
    }, proxyOptions, fetchImpl, diagnostics, "api-key-create", keyEndpoint);
    diagnostics?.event("api-key-create", "result", { keyReturned: typeof key?.apiKey === "string" && !!key.apiKey.trim() });
  }
  if (typeof key?.apiKey !== "string" || !key.apiKey.trim()) {
    throw new Error("ZCode project key missing from provisioning response");
  }

  const projectToken = await requestBusiness(`${keyUrl}/${encodeURIComponent(key.apiKey)}/access_tokens`, {
    method: "POST", headers,
    body: JSON.stringify({ clientType: "zcode", clientVersion: config.appVersion }),
  }, proxyOptions, fetchImpl, diagnostics, "project-token", `${keyEndpoint}/{key}/access_tokens`);
  diagnostics?.event("project-token", "result", {
    enabled: projectToken?.enabled === true,
    tokenReturned: typeof projectToken?.accessToken === "string" && !!projectToken.accessToken.trim(),
    expiresIn: Number.isFinite(projectToken?.expiresIn) ? projectToken.expiresIn : null,
    persisted: false,
  });
  if (projectToken?.enabled !== true || typeof projectToken.accessToken !== "string" || !projectToken.accessToken.trim()) {
    throw new Error("ZCode provisioning did not return an enabled project token");
  }
  // Inference continues using the login JWT / existing API key. In particular,
  // do not copy this five-hour token or its expiry into connection credentials.
  return { enrolled: true };
}
