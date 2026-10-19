export function getSidecarUrl() {
  return (process.env.PROBE_SIDECAR_URL || "http://127.0.0.1:20129").replace(/\/+$/, "");
}

export function getSidecarToken() {
  return process.env.PROBE_SIDECAR_TOKEN || process.env.PROBE_TOKEN || "";
}

function buildHeaders() {
  const headers = {
    "content-type": "application/json",
  };
  const token = getSidecarToken();
  if (token) {
    headers["x-probe-token"] = token;
  }
  return headers;
}

/**
 * Check health of probe sidecar service.
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

/**
 * Forward probe run request to sidecar.
 */
export async function runProbeOnSidecar(payload, signal) {
  const url = `${getSidecarUrl()}/run`;
  return fetch(url, {
    method: "POST",
    headers: {
      ...buildHeaders(),
      accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal,
  });
}

/**
 * Send cancellation request to sidecar.
 */
export async function cancelProbeOnSidecar(runId) {
  const url = `${getSidecarUrl()}/cancel`;
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
