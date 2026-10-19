import { NextResponse } from "next/server";
import { verifyProbeAdminAuth, verifyCsrfOrigin } from "@/lib/probe/auth.js";
import { cancelActiveRun } from "@/lib/probe/activeRun.js";
import { cancelProbeOnSidecar } from "@/lib/probe/sidecarClient.js";

export async function POST(request) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!verifyCsrfOrigin(request)) {
    return NextResponse.json({ error: "Forbidden: CSRF origin mismatch" }, { status: 403 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch { /* optional body */ }

  const runId = body?.runId || null;

  const cancelled = cancelActiveRun(runId, auth.ownerId);
  if (!cancelled.ok) {
    return NextResponse.json(
      { error: cancelled.error },
      { status: cancelled.status || 400 }
    );
  }

  // Notify sidecar best-effort
  cancelProbeOnSidecar(cancelled.runId).catch(() => {});

  return NextResponse.json({
    success: true,
    cancelled: true,
    runId: cancelled.runId,
  });
}
