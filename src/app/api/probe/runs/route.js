import { NextResponse } from "next/server";
import { verifyProbeAdminAuth } from "@/lib/probe/auth.js";
import { listProbeRuns } from "@/lib/db/repos/probeRunsRepo.js";

export async function GET(request) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit")) || 20;
  const runs = await listProbeRuns(limit);
  return NextResponse.json({ runs });
}
