import { NextResponse } from "next/server";
import { getApiKeyById, getRecoverableApiKeySecret } from "@/lib/localDb";

// GET /api/keys/[id]/secret — recoverable plaintext for dashboard show/copy.
// Encrypted at rest; never returned by list/GET metadata endpoints.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    const secret = await getRecoverableApiKeySecret(id);
    if (!secret) {
      return NextResponse.json(
        { error: "Secret is not recoverable for this key. Reroll to mint a new secret." },
        { status: 404 }
      );
    }
    return NextResponse.json({ id: key.id, name: key.name, keyHint: key.keyHint, secret });
  } catch (error) {
    console.log("Error recovering key secret:", error);
    return NextResponse.json({ error: "Failed to recover secret" }, { status: 500 });
  }
}
