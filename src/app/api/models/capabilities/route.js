import { NextResponse } from "next/server";
import {
  deleteModelCapabilityOverride,
  getModelCapabilityOverrides,
  setModelCapabilityOverride,
} from "@/lib/db/repos/modelCapabilityRepo.js";
import {
  refreshModelCapabilityOverrides,
  sanitizeModelTokenCaps,
} from "open-sse/providers/modelCapabilityOverrides.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ overrides: await getModelCapabilityOverrides() });
  } catch (error) {
    console.log("Error fetching model capability overrides:", error);
    return NextResponse.json({ error: "Failed to fetch model capability overrides" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const { provider, model, caps } = await request.json();
    if (!provider || !model) {
      return NextResponse.json({ error: "provider and model required" }, { status: 400 });
    }
    const cleanCaps = sanitizeModelTokenCaps(caps);
    if (!cleanCaps) {
      return NextResponse.json({ error: "Positive integer contextWindow or maxOutput required" }, { status: 400 });
    }
    await setModelCapabilityOverride(provider, model, cleanCaps);
    await refreshModelCapabilityOverrides();
    return NextResponse.json({ success: true, provider, model, caps: cleanCaps });
  } catch (error) {
    console.log("Error updating model capability override:", error);
    return NextResponse.json({ error: "Failed to update model capability override" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    if (!provider || !model) {
      return NextResponse.json({ error: "provider and model required" }, { status: 400 });
    }
    await deleteModelCapabilityOverride(provider, model);
    await refreshModelCapabilityOverrides();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting model capability override:", error);
    return NextResponse.json({ error: "Failed to delete model capability override" }, { status: 500 });
  }
}
