// Sidecar contract (achmadsy/LLMprobe-engine):
//   GET  /health
//   GET  /v1/probes          → { version, probes: [{ id, label, group, description, ...flags }] }
//   POST /v1/models          { baseUrl, apiKey?, customHeaders? } → { models: [{ id, name? }] }
//   POST /v1/runs            { id, baseUrl, apiKey, customHeaders?, modelId, claimedModel?, judge? }  → SSE
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
    modelId: node.model ?? node.modelId,
  };
  if (node.claimedModel ?? node.claimedModelId) out.claimedModel = node.claimedModel ?? node.claimedModelId;
  if (!out.baseUrl || !out.modelId) return undefined;
  // Keyless self-gateway probes run without credentials; keyless custom targets
  // rely on endpoints that do not require auth.
  if (apiKey) out.apiKey = apiKey;
  if (node.customHeaders && Object.keys(node.customHeaders).length) {
    out.customHeaders = node.customHeaders;
  }
  return out;
}

/**
 * Fetch display-safe probe metadata from the authenticated sidecar.
 */
export async function getProbeCatalogFromSidecar(signal) {
  const maxBytes = 262_144;
  const timeoutSignal = AbortSignal.timeout(5000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(`${getSidecarUrl()}/v1/probes`, {
    headers: buildHeaders(),
    signal: combinedSignal,
  });

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("Probe catalog response too large");
  }

  if (!response.body) {
    return { ok: response.ok, status: response.status, data: null };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Probe catalog response too large");
        throw new Error("Probe catalog response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let data = null;
  try {
    data = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("Probe catalog response was not valid JSON");
  }
  return { ok: response.ok, status: response.status, data };
}

/**
 * Fetch an OpenAI-compatible catalog through the sidecar's pinned egress path.
 */
export async function discoverModelsOnSidecar({ baseUrl, apiKey, customHeaders }, signal) {
  const timeoutSignal = AbortSignal.timeout(12_000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  return fetch(`${getSidecarUrl()}/v1/models`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(customHeaders && Object.keys(customHeaders).length ? { customHeaders } : {}),
    }),
    signal: combinedSignal,
  });
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
    // Official baseline responses keyed by probeId, used by llm_judge
    // similarity scoring (engine contract: Record<probeId, string>).
    ...(payload.baseline ? { baseline: payload.baseline } : {}),
    ...(payload.config?.timeoutMs ? { timeoutMs: payload.config.timeoutMs } : {}),
    // Probe transport failures and retryable upstream responses (429/5xx)
    // five times. The engine applies exponential backoff between attempts.
    requestRetries: 5,
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

// Official baseline responses keyed by probeId, fetched from the BazaarLink
// public API and cached per model. Fail-open: without a baseline the engine's
// rubric fallback grades llm_judge probes instead.
const BASELINE_TTL_MS = 6 * 60 * 60 * 1000;
const baselineCache = new Map(); // modelId -> { map, fetchedAt }
const baselineInFlight = new Map();

export function getBaselineApiUrl() {
  return (process.env.PROBE_BASELINE_URL || "https://bazaarlink.ai").replace(/\/+$/, "");
}

export async function fetchBaselineMap(modelId) {
  if (!modelId) return null;
  const cached = baselineCache.get(modelId);
  if (cached && Date.now() - cached.fetchedAt < BASELINE_TTL_MS) {
    return cached.map;
  }
  if (baselineInFlight.has(modelId)) {
    return baselineInFlight.get(modelId);
  }
  const promise = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(
        `${getBaselineApiUrl()}/api/probe/baselines?modelId=${encodeURIComponent(modelId)}`,
        { signal: controller.signal },
      ).finally(() => clearTimeout(timer));
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data?.probes) || data.probes.length === 0) return null;
      const map = {};
      for (const probe of data.probes) {
        if (probe?.probeId && typeof probe.responseText === "string" && probe.responseText.length > 0) {
          map[probe.probeId] = probe.responseText;
        }
      }
      const result = Object.keys(map).length > 0 ? map : null;
      if (result) baselineCache.set(modelId, { map: result, fetchedAt: Date.now() });
      return result;
    } catch {
      return null;
    } finally {
      baselineInFlight.delete(modelId);
    }
  })();
  baselineInFlight.set(modelId, promise);
  return promise;
}
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
