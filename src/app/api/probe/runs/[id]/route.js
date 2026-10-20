import { NextResponse } from "next/server";
import { verifyProbeAdminAuth } from "@/lib/probe/auth.js";
import { getProbeRun } from "@/lib/db/repos/probeRunsRepo.js";

export async function GET(request, { params }) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id || !/^prun_[a-f0-9-]{10,64}$/.test(id)) {
    return NextResponse.json({ error: "Invalid run id" }, { status: 400 });
  }

  const run = await getProbeRun(id);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json({ run });
}
