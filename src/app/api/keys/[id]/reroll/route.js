import { NextResponse } from "next/server";
import { rerollApiKey } from "@/lib/localDb";

// POST /api/keys/[id]/reroll — rotate verifier; same ID/policy; new secret (copyable anytime after).
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const updated = await rerollApiKey(id);
    if (!updated) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({
      // Prefer `secret`; keep `key` for older clients.
      secret: updated.key,
      key: updated.key,
      keyHint: updated.keyHint,
      name: updated.name,
      id: updated.id,
      accessMode: updated.accessMode,
      targets: updated.targets || [],
      rerolledAt: updated.rerolledAt,
    });
  } catch (error) {
    console.log("Error rerolling key:", error);
    return NextResponse.json({ error: "Failed to reroll key" }, { status: 500 });
  }
}
