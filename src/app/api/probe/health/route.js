import { NextResponse } from "next/server";
import { verifyProbeAdminAuth } from "@/lib/probe/auth.js";
import { getSidecarHealth } from "@/lib/probe/sidecarClient.js";

export async function GET(request) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const health = await getSidecarHealth();
  return NextResponse.json({
    status: health.reachable ? "ok" : "degraded",
    sidecar: health,
  });
}
