import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey, getApiKeyAccessTargets } from "@/lib/localDb";
import { API_KEY_ACCESS_MODE } from "@/lib/apiKeys/constants.js";
import { normalizeTargets } from "@/lib/apiKeys/policy.js";
import { parsePolicyInput } from "@/lib/apiKeys/validate.js";

// Immutable / secret fields. machineId is server-owned (and identity-critical).
const FORBIDDEN_FIELDS = [
  "key",
  "keyHash",
  "secret",
  "hashVersion",
  "machineId",
  "createdAt",
  "updatedAt",
  "rerolledAt",
];

// GET /api/keys/[id] - Get single key (metadata + targets, never secret)
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    const targets = key.targets || (await getApiKeyAccessTargets(id));
    return NextResponse.json({ key, targets });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key (name/isActive/accessMode + atomic full policy replace).
// Legacy status-only PUT ({ isActive }) keeps working.
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    for (const f of FORBIDDEN_FIELDS) {
      if (body[f] !== undefined) {
        return NextResponse.json({ error: `Field '${f}' is not allowed` }, { status: 400 });
      }
    }

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const policy = parsePolicyInput(body);
    if (policy.error) {
      return NextResponse.json({ error: policy.error }, { status: 400 });
    }

    const updateData = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.isActive !== undefined) updateData.isActive = body.isActive;

    if (policy.accessMode !== undefined) {
      updateData.accessMode = policy.accessMode === API_KEY_ACCESS_MODE.RESTRICTED
        ? API_KEY_ACCESS_MODE.RESTRICTED
        : API_KEY_ACCESS_MODE.ALL;
      updateData.targets = normalizeTargets(policy.targets || []);
    } else if (policy.targets !== undefined) {
      updateData.targets = normalizeTargets(policy.targets);
      if (updateData.targets.length > 0) {
        updateData.accessMode = API_KEY_ACCESS_MODE.RESTRICTED;
      }
    }

    const updated = await updateApiKey(id, updateData);
    if (!updated) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    const targets = updated.targets || [];
    return NextResponse.json({ key: updated, targets });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key (historical usage kept via apiKeyId)
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
