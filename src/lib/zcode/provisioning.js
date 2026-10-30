import config from "./config.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";

async function requestBusiness(url, options, proxyOptions, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }, proxyOptions);
  } catch {
    throw new Error("ZCode provisioning network request failed");
  }
  const json = await response.json().catch(() => null);
  if (!response.ok || !json || json.success === false || ![0, 200].includes(json.code)) {
    // Never propagate upstream bodies: these endpoints return credentials.
    throw new Error(`ZCode provisioning rejected (HTTP ${response.status}, code ${Number.isFinite(json?.code) ? json.code : "unknown"})`);
  }
  return json.data;
}

/** Native Coding Plan enrollment. The expiring project token is never persisted or returned. */
export async function enrollZcodeProject(credentials, proxyOptions = null, fetchImpl = proxyAwareFetch) {
  const businessToken = credentials?.accessToken?.trim();
  if (!businessToken) throw new Error("ZCode business login is required for provisioning");

  const info = await requestBusiness("https://api.z.ai/api/biz/customer/getCustomerInfo", {
    method: "GET",
    headers: { Authorization: businessToken, "Content-Type": "application/json" },
  }, proxyOptions, fetchImpl);
  const organizations = Array.isArray(info?.organizations) ? info.organizations : [];
  const organization = organizations.find((org) => org.organizationName?.includes("默认机构") && org.projects?.length)
    || organizations.find((org) => org.projects?.length);
  const project = organization?.projects.find((entry) => entry.projectName?.includes("默认项目"))
    || organization?.projects[0];
  if (!organization?.organizationId || !project?.projectId) {
    throw new Error("No available ZCode personal project");
  }

  const keyUrl = `https://api.z.ai/api/biz/v1/organization/${encodeURIComponent(organization.organizationId)}/projects/${encodeURIComponent(project.projectId)}/api_keys`;
  const headers = { Authorization: `Bearer ${businessToken}`, "Content-Type": "application/json" };
  const keys = await requestBusiness(keyUrl, { method: "GET", headers }, proxyOptions, fetchImpl);
  if (!Array.isArray(keys)) throw new Error("Invalid ZCode project key list");
  // Native ZCode reuses an existing same-name key. Do not delete or migrate it.
  let key = keys.find((entry) => entry.name === "zcode-api-key");
  if (!key) {
    key = await requestBusiness(keyUrl, {
      method: "POST", headers,
      body: JSON.stringify({ name: "zcode-api-key", usageScene: 1 }),
    }, proxyOptions, fetchImpl);
  }
  if (typeof key?.apiKey !== "string" || !key.apiKey.trim()) {
    throw new Error("ZCode project key missing from provisioning response");
  }

  const projectToken = await requestBusiness(`${keyUrl}/${encodeURIComponent(key.apiKey)}/access_tokens`, {
    method: "POST", headers,
    body: JSON.stringify({ clientType: "zcode", clientVersion: config.appVersion }),
  }, proxyOptions, fetchImpl);
  if (projectToken?.enabled !== true || typeof projectToken.accessToken !== "string" || !projectToken.accessToken.trim()) {
    throw new Error("ZCode provisioning did not return an enabled project token");
  }
  // Inference continues using the login JWT / existing API key. In particular,
  // do not copy this five-hour token or its expiry into connection credentials.
  return { enrolled: true };
}
