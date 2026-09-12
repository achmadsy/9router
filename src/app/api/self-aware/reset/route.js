import { NextResponse } from "next/server";
import {
  listBoardCooldowns, deleteSelfAwareCooldown, resetAllSelfAwareCooldowns,
} from "@/sse/services/selfAwareCooldown.js";
import {
  updateProviderConnection, getProviderConnections, getProviderConnectionById,
} from "@/lib/db/index.js";
import { clearAntigravityCooldown, clearAllAntigravityCooldowns } from "@/sse/services/antigravityQuota.js";
import { resolveProviderId } from "@/shared/constants/providers.js";

export const dynamic = "force-dynamic";

function activeLockKeyMap(connection) {
  const now = Date.now();
  const out = [];
  for (const [k, v] of Object.entries(connection || {})) {
    if (!k.startsWith("modelLock_") || !v) continue;
    const t = new Date(v).getTime();
    if (t > now) out.push({ key: k, expiresAtMs: t });
  }
  return out;
}

async function resetOne(row, nowMs) {
  let cleared = 0;
  const provider = resolveProviderId(row.provider);

  // Antigravity: clear RAM + mirror together
  if (provider === "antigravity") {
    clearAntigravityCooldown(row.scopeId, row.model);
    cleared++;
  }

  // Account-scope: clear matching modelLock_* on the connection.
  // scopeId comes from the validated board row (not raw client input) —
  // look up by exact id (getProviderConnections ignores filter.id).
  if (row.scopeType === "account" && row.scopeId) {
    try {
      const conn = await getProviderConnectionById(row.scopeId);
      if (conn) {
        const update = {};
        const modelKey = row.model ? `modelLock_${row.model}` : "modelLock___all";
        if (conn[modelKey]) {
          update[modelKey] = null;
          cleared++;
        }
        // Align any lock expiring within 1s of this row (sidecar↔lock match)
        for (const { key, expiresAtMs } of activeLockKeyMap(conn)) {
          if (key === modelKey) continue;
          const rowExp = new Date(row.expiresAt).getTime();
          if (Math.abs(expiresAtMs - rowExp) <= 1000) {
            update[key] = null;
            cleared++;
          }
        }
        if (Object.keys(update).length > 0) {
          await updateProviderConnection(conn.id, update);
        }
      }
    } catch { /* fail-open */ }
  }

  // Sidecar row (any scope with an id)
  if (row.id) {
    const ok = await deleteSelfAwareCooldown(row.id);
    if (ok) cleared++;
  }

  // Legacy-backoff rows without sidecar id: still count as reset for board UX
  if (!row.id && cleared === 0 && row.source === "legacy-backoff") {
    cleared++;
  }
  return cleared > 0;
}

// POST /api/self-aware/reset
// body: { all: true } | { id } | { provider, model, scopeType, scopeId }
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const nowMs = Date.now();

    if (body.all === true) {
      // Clear Antigravity RAM blocks that board shows
      clearAllAntigravityCooldowns();
      const n = await resetAllSelfAwareCooldowns(nowMs);
      // Also null out all currently active modelLock_* across connections
      try {
        const conns = await getProviderConnections({});
        for (const c of conns) {
          const update = {};
          for (const { key } of activeLockKeyMap(c)) update[key] = null;
          if (Object.keys(update).length > 0) await updateProviderConnection(c.id, update);
        }
      } catch { /* fail-open */ }
      return NextResponse.json({ ok: true, cleared: n });
    }

    const rows = await listBoardCooldowns(nowMs);
    let target = null;
    if (body.id) {
      target = rows.find((r) => r.id === body.id) || null;
      // Sidecar-only delete if not on board (already expired edge case)
      if (!target) {
        const ok = await deleteSelfAwareCooldown(body.id);
        return NextResponse.json({ ok });
      }
    } else if (body.provider) {
      target = rows.find((r) =>
        r.provider === body.provider &&
        (body.model === undefined || r.model === (body.model || "")) &&
        (body.scopeType === undefined || r.scopeType === body.scopeType) &&
        (body.scopeId === undefined || r.scopeId === body.scopeId)
      ) || null;
    }

    if (!target) {
      return NextResponse.json({ error: "Cooldown not found" }, { status: 404 });
    }

    const ok = await resetOne(target, nowMs);
    return NextResponse.json({ ok });
  } catch (e) {
    console.error("[API] self-aware reset failed:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
