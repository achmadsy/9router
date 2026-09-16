import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel } from "@/models";
import { CAPACITY_META } from "@/shared/constants/models";
import { refreshCustomModelFormats } from "open-sse/providers/customModelFormats.js";

export const dynamic = "force-dynamic";

// Whitelist capability keys to boolean values — ignore anything else
function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  for (const key of Object.keys(CAPACITY_META)) {
    if (typeof caps[key] === "boolean") clean[key] = caps[key];
  }
  return Object.keys(clean).length ? clean : null;
}

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model
export async function POST(request) {
  try {
    const { providerAlias, id, type, name, caps, targetFormat } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    // Optional per-model upstream endpoint override (e.g. opencode free
    // union-alpha needs /messages). Three values mean something today.
    const VALID_TARGET_FORMATS = new Set(["claude", "openai", "openai-responses"]);
    const cleanTargetFormat = VALID_TARGET_FORMATS.has(targetFormat) ? targetFormat : null;
    const cleanCaps = sanitizeCaps(caps);
    const added = await addCustomModel({
      providerAlias, id, type: type || "llm", name,
      ...(cleanCaps ? { caps: cleanCaps } : {}),
      ...(targetFormat !== undefined ? { targetFormat: cleanTargetFormat } : {}),
    });
    // Per-model targetFormat overrides are read synchronously per request —
    // re-pull the cache so the new/updated row applies without a restart.
    await refreshCustomModelFormats();
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    await refreshCustomModelFormats();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
