import { NextResponse } from "next/server";
import { verifyProbeAdminAuth, verifyCsrfOrigin } from "@/lib/probe/auth.js";
import {
  PROBE_SOURCE_CUSTOM,
  PROBE_SOURCE_SELF,
} from "@/lib/probe/endpoints.js";
import { discoverModelsOnSidecar } from "@/lib/probe/sidecarClient.js";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { resolveApiKeyContext } from "@/sse/services/apiKeyPolicy.js";
import { filterCatalogByPolicy, loadCombosForPolicy } from "@/lib/apiKeys/policy.js";

const MAX_BODY_BYTES = 32_768;
const MAX_ENDPOINT_LENGTH = 4096;
const MAX_API_KEY_LENGTH = 8192;
const MAX_MODELS = 10_000;

function normalizeModels(models) {
  const seen = new Set();
  const normalized = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id || id.length > 512 || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, ...(typeof model?.name === "string" && model.name.trim() ? { name: model.name.trim().slice(0, 512) } : {}) });
    if (normalized.length >= MAX_MODELS) break;
  }
  return normalized;
}

export async function POST(request) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!verifyCsrfOrigin(request)) {
    return NextResponse.json({ error: "Forbidden: CSRF origin mismatch" }, { status: 403 });
  }

  let body;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const source = body?.source;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (![PROBE_SOURCE_SELF, PROBE_SOURCE_CUSTOM].includes(source)) {
    return NextResponse.json({ error: "Invalid model source" }, { status: 400 });
  }
  if (endpoint.length > MAX_ENDPOINT_LENGTH || apiKey.length > MAX_API_KEY_LENGTH) {
    return NextResponse.json({ error: "Endpoint or API key is too long" }, { status: 400 });
  }

  if (source === PROBE_SOURCE_SELF) {
    const headers = new Headers();
    if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
    const keyCtx = await resolveApiKeyContext({ headers }, { requireApiKey: false });
    if (keyCtx.errorResponse) return keyCtx.errorResponse;

    const catalog = await buildModelsList(["llm"]);
    const filtered = filterCatalogByPolicy(keyCtx.keyRow, catalog, {
      combos: await loadCombosForPolicy(),
    });
    return NextResponse.json({ models: normalizeModels(filtered) });
  }

  if (!endpoint) {
    return NextResponse.json({ error: "Custom endpoint is required" }, { status: 400 });
  }

  try {
    await assertPublicUrlResolved(endpoint, { requireResolve: true });
    const sidecarResponse = await discoverModelsOnSidecar({ baseUrl: endpoint, apiKey }, request.signal);
    const data = await sidecarResponse.json().catch(() => ({}));
    if (!sidecarResponse.ok) {
      const message = data?.error?.message || data?.error || `Probe sidecar returned HTTP ${sidecarResponse.status}`;
      return NextResponse.json({ error: String(message).slice(0, 1000) }, { status: sidecarResponse.status });
    }
    return NextResponse.json({ models: normalizeModels(data.models) });
  } catch (error) {
    if (error?.name === "AbortError" && request.signal.aborted) return undefined;
    const status = String(error?.message || "").startsWith("Blocked URL:") ? 400 : 502;
    return NextResponse.json(
      { error: String(error?.message || "Model discovery failed").slice(0, 1000) },
      { status }
    );
  }
}
