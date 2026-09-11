import { NextResponse } from "next/server";
import { getCombos } from "@/lib/localDb";
import { buildModelsList } from "@/app/api/v1/models/route.js";

// GET /api/keys/access-options — unfiltered management catalog (models + combos)
// for the API-key policy editor. Not subject to any key policy filter.
export async function GET() {
  try {
    const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
    const combos = await getCombos();
    return NextResponse.json({
      models: models.map((m) => ({ id: m.id, owned_by: m.owned_by || null })),
      combos: (combos || []).map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind || null,
        models: (c.models || []).map((m) => (typeof m === "string" ? m : m?.id || m?.model)).filter(Boolean),
      })),
    });
  } catch (error) {
    console.log("Error fetching access options:", error);
    return NextResponse.json({ error: "Failed to fetch access options" }, { status: 500 });
  }
}
