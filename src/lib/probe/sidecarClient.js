// Sidecar contract (achmadsy/LLMprobe-engine):
//   GET  /health
//   POST /v1/runs            { id, baseUrl, apiKey, modelId, claimedModel?, judge? }  → SSE
//   POST /v1/runs/:id/cancel
export function getSidecarUrl() {
  return (process.env.PROBE_SIDECAR_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");
}

export function getSidecarToken() {
  return process.env.PROBE_SIDECAR_TOKEN || process.env.SIDECAR_TOKEN || "";
}

function buildHeaders() {
  const headers = {
    "content-type": "application/json",
  };
  const token = getSidecarToken();
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Check health of the probe sidecar service.
 */
export async function getSidecarHealth(timeoutMs = 3000) {
  const url = `${getSidecarUrl()}/health`;
  try {
    const res = await fetch(url, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    return {
      reachable: res.ok,
      status: res.status,
      url: getSidecarUrl(),
      data,
    };
  } catch (err) {
    return {
      reachable: false,
      status: 503,
      url: getSidecarUrl(),
      error: err.message,
    };
  }
}

function toEndpointConfig(node) {
  if (!node || typeof node !== "object") return undefined;
  const apiKey = node.apiKey ?? node.secrets?.apiKey ?? node.secrets?.token;
  const out = {
    baseUrl: node.baseUrl ?? node.endpoint,
    apiKey,
    modelId: node.model ?? node.modelId,
  };
  if (node.claimedModel ?? node.claimedModelId) out.claimedModel = node.claimedModel ?? node.claimedModelId;
  if (!out.baseUrl || !out.modelId) return undefined;
  if (!out.apiKey) delete out.apiKey;
  return out;
}

/**
 * Forward a probe run to the sidecar. Returns the raw SSE Response.
 */
export async function runProbeOnSidecar(payload, signal) {
  const target = toEndpointConfig(payload.target);
  if (!target) {
    throw new Error("Target endpoint/model missing for probe run");
  }
  const judge = toEndpointConfig(payload.judge);
  const body = {
    id: payload.runId,
    ...target,
    ...(judge ? { judge } : {}),
    ...(payload.config?.timeoutMs ? { timeoutMs: payload.config.timeoutMs } : {}),
  };
  return fetch(`${getSidecarUrl()}/v1/runs`, {
    method: "POST",
    headers: {
      ...buildHeaders(),
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Request cancellation of an active sidecar run.
 */
export async function cancelProbeOnSidecar(runId) {
  const url = `${getSidecarUrl()}/v1/runs/${encodeURIComponent(runId)}/cancel`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({ runId }),
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 500, error: err.message };
  }
}
