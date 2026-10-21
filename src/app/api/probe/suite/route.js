import { NextResponse } from "next/server";
import { verifyProbeAdminAuth } from "@/lib/probe/auth.js";
import { getProbeCatalogFromSidecar } from "@/lib/probe/sidecarClient.js";
import { ORIGINAL_SUITE_IDS } from "@/lib/probe/originalSuite.js";

const MAX_PROBES = 256;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 256;
const MAX_GROUP_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 2048;
const MAX_VERSION_LENGTH = 64;

function requiredString(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function normalizeCatalog(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.probes)) {
    return null;
  }
  if (data.probes.length === 0 || data.probes.length > MAX_PROBES) {
    return null;
  }

  const version = requiredString(data.version, MAX_VERSION_LENGTH);
  if (!version) return null;

  const ids = new Set();
  const probes = [];
  for (const item of data.probes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;

    const id = requiredString(item.id, MAX_ID_LENGTH);
    const label = requiredString(item.label, MAX_LABEL_LENGTH);
    const group = requiredString(item.group, MAX_GROUP_LENGTH);
    const description = requiredString(item.description, MAX_DESCRIPTION_LENGTH);
    if (!id || !label || !group || !description || ids.has(id)) return null;
    if (
      (item.optional !== undefined && typeof item.optional !== "boolean") ||
      (item.isNew !== undefined && typeof item.isNew !== "boolean") ||
      (item.neutral !== undefined && typeof item.neutral !== "boolean")
    ) {
      return null;
    }

    ids.add(id);
    probes.push({
      id,
      label,
      group,
      description,
      // Bounded drawer metadata from the engine (prompt ≤ 500 chars).
      ...(typeof item.scoring === "string" && item.scoring.length <= 64 ? { scoring: item.scoring } : {}),
      ...(typeof item.prompt === "string" && item.prompt ? { prompt: item.prompt.slice(0, 500) } : {}),
      ...(typeof item.expected === "string" && item.expected ? { expected: item.expected.slice(0, 300) } : {}),
      ...(item.optional === true ? { optional: true } : {}),
      ...(item.isNew === true ? { isNew: true } : {}),
      ...(item.neutral === true ? { neutral: true } : {}),
    });
  }

  // Fail closed when a required public-suite probe is absent. Returning fewer
  // while the UI claims the original 86-probe contract would be misleading.
  const byId = new Map(probes.map((probe) => [probe.id, probe]));
  if (ORIGINAL_SUITE_IDS.some((id) => !byId.has(id))) return null;

  return { version, probes: ORIGINAL_SUITE_IDS.map((id) => byId.get(id)) };
}

function json(data, init = {}) {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sidecarResponse = await getProbeCatalogFromSidecar(request.signal);
    if (!sidecarResponse.ok) {
      return json({ error: "Probe catalog unavailable" }, { status: 502 });
    }

    const catalog = normalizeCatalog(sidecarResponse.data);
    if (!catalog) {
      return json({ error: "Probe catalog invalid" }, { status: 502 });
    }

    return json(catalog);
  } catch (error) {
    if (error?.name === "AbortError" && request.signal.aborted) return undefined;
    return json({ error: "Probe catalog unavailable" }, { status: 503 });
  }
}
