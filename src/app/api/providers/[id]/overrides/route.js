import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { resolveRuntimeProviderId } from "open-sse/providers/clones.js";
import { buildZcodeCodingPlanDefaultHeaders } from "@/lib/zcode/headers.js";
import { isBlockedProviderHeader, normalizeProviderHeaderOverride } from "open-sse/utils/providerHeaderOverrides.js";

export const dynamic = "force-dynamic";

function builtinHeadersFor(runtimeProvider) {
  // GLM's executor replaces generic Claude transport headers with ZCode defaults.
  // Use its non-secret builder here too; never mint credentials or request IDs.
  const headers = runtimeProvider === "glm"
    ? buildZcodeCodingPlanDefaultHeaders()
    : PROVIDERS[runtimeProvider]?.headers || {};
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !isBlockedProviderHeader(name)));
}

async function readOverrides() {
  const settings = await getSettings();
  return settings.providerOverrides || {};
}

/**
 * GET /api/providers/[id]/overrides — user override for this provider
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    // URL may use an alias (gcli, cc…) — key everything by canonical registry id
    const canonical = resolveProviderAlias(id);
    const runtimeProvider = resolveRuntimeProviderId(canonical);
    const override = (await readOverrides())[canonical] || {};
    // Clone defaults follow the runtime provider; saved overrides stay isolated.
    return NextResponse.json({
      headers: override.headers || {},
      builtinHeaders: builtinHeadersFor(runtimeProvider),
      ...(runtimeProvider === "glm" ? { defaultProfile: "zcode-account-plan" } : {}),
    });
  } catch (error) {
    console.log("Error getting provider overrides:", error);
    return NextResponse.json({ error: "Failed to get overrides" }, { status: 500 });
  }
}

/**
 * PUT /api/providers/[id]/overrides — body: { headers: {name: string | null} }
 * null suppresses that default header; an empty map clears all overrides.
 */
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const canonical = resolveProviderAlias(id);
    const body = await request.json().catch(() => null);
    const { override, error } = normalizeProviderHeaderOverride(body);
    if (error) {
      return NextResponse.json({ error }, { status: 400 });
    }
    const current = await readOverrides();
    const next = { ...current };
    if (override) next[canonical] = override;
    else delete next[canonical];
    await updateSettings({ providerOverrides: next });
    return NextResponse.json({ headers: override?.headers || {} });
  } catch (error) {
    console.log("Error saving provider overrides:", error);
    return NextResponse.json({ error: "Failed to save overrides" }, { status: 500 });
  }
}
