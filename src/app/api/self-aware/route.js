import { NextResponse } from "next/server";
import { listBoardCooldowns } from "@/sse/services/selfAwareCooldown.js";
import { getProxyPools } from "@/lib/localDb.js";

export const dynamic = "force-dynamic";

// GET /api/self-aware — every currently active cooldown (old + new mechanisms)
export async function GET() {
  try {
    const [rows, pools] = await Promise.all([
      listBoardCooldowns(),
      getProxyPools({}).catch(() => []),
    ]);
    const poolById = new Map((pools || []).map((p) => [p.id, p]));
    const enriched = rows.map((r) => {
      const out = { ...r };
      if (r.scopeType === "proxy") {
        const pool = poolById.get(r.scopeId);
        out.proxyPoolName = pool?.name || null;
        out.proxyPoolDeleted = !pool && r.scopeId !== "direct";
      }
      if (r.scopeType === "account" && !out.connectionName && r.scopeId) {
        out.connectionId = r.scopeId;
      }
      return out;
    });
    return NextResponse.json({ cooldowns: enriched, count: enriched.length });
  } catch (e) {
    console.error("[API] self-aware list failed:", e);
    return NextResponse.json({ cooldowns: [], count: 0, error: e.message }, { status: 500 });
  }
}
