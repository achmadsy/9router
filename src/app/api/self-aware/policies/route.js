import { NextResponse } from "next/server";
import {
  listSelfAwarePolicies, upsertSelfAwarePolicy, deleteSelfAwarePolicy,
} from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

const MIN_MS = 1000;
const MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30d

// GET /api/self-aware/policies
export async function GET() {
  try {
    const policies = await listSelfAwarePolicies();
    return NextResponse.json({ policies });
  } catch (e) {
    console.error("[API] self-aware policies list failed:", e);
    return NextResponse.json({ policies: [], error: e.message }, { status: 500 });
  }
}

// PUT /api/self-aware/policies — create/update one
export async function PUT(request) {
  try {
    const body = await request.json();
    const provider = String(body.provider || "").trim();
    const model = String(body.model || "").trim();
    const timeoutMs = Number(body.timeoutMs);
    if (!provider) {
      return NextResponse.json({ error: "provider is required" }, { status: 400 });
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_MS || timeoutMs > MAX_MS) {
      return NextResponse.json({ error: `timeoutMs must be ${MIN_MS}..${MAX_MS}` }, { status: 400 });
    }
    const policy = await upsertSelfAwarePolicy({ provider, model, timeoutMs });
    return NextResponse.json({ policy });
  } catch (e) {
    console.error("[API] self-aware policy upsert failed:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE /api/self-aware/policies — ?provider=&model=
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = String(searchParams.get("provider") || "").trim();
    const model = String(searchParams.get("model") || "").trim();
    if (!provider) {
      return NextResponse.json({ error: "provider is required" }, { status: 400 });
    }
    const ok = await deleteSelfAwarePolicy(provider, model);
    return NextResponse.json({ ok });
  } catch (e) {
    console.error("[API] self-aware policy delete failed:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
