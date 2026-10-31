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
      signal: AbortSignal.timeout(15_000),
    }, proxyOptions);
  } catch (error) {
    if (error?.httpStatus === 429) throw error;
    diagnostics?.event(step, "failed", { endpoint, durationMs: Date.now() - started, reason: "Network request failed or timed out" });
    throw new Error("ZCode provisioning network request failed");
  }
  const json = await response.json().catch(() => null);
  const accepted = response.ok && !!json && json.success !== false && [0, 200].includes(json.code);
  diagnostics?.event(step, accepted ? "response" : "failed", {
    endpoint, httpStatus: response.status,
    providerCode: Number.isFinite(json?.code) ? json.code : null,
    validJson: !!json, durationMs: Date.now() - started,
  });
  if (!accepted) {
    // Never propagate upstream bodies: these endpoints return credentials.
    throw new Error(`ZCode provisioning rejected (HTTP ${response.status}, code ${Number.isFinite(json?.code) ? json.code : "unknown"})`);
  }
  return json.data;
}

/** Native Coding Plan enrollment. The expiring project token is never persisted or returned. */
export async function enrollZcodeProject(credentials, proxyOptions = null, fetchImpl = proxyAwareFetch, diagnostics = null) {
  const oauthToken = credentials?.providerSpecificData?.zaiAccessToken?.trim();
  if (!oauthToken) throw new Error("Z.AI OAuth token is required for fresh business login; reconnect this account");
  const loginEndpoint = "https://api.z.ai/api/auth/z/login";
  const login = await requestBusiness(loginEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: oauthToken }),
  }, proxyOptions, fetchImpl, diagnostics, "business-login", loginEndpoint);
  const businessToken = (typeof login?.access_token === "string" ? login.access_token.trim() : "")
    || (typeof login?.accessToken === "string" ? login.accessToken.trim() : "");
  if (!businessToken) throw new Error("Z.AI business login response is missing access_token");
  diagnostics?.event("business-login", "result", { tokenReturned: true, persisted: false });

  const info = await requestBusiness("https://api.z.ai/api/biz/customer/getCustomerInfo", {
    method: "GET",
    headers: { Authorization: businessToken, "Content-Type": "application/json" },
  }, proxyOptions, fetchImpl, diagnostics, "customer-info", "https://api.z.ai/api/biz/customer/getCustomerInfo");
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
