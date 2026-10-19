import { NextResponse } from "next/server";
import { verifyProbeAdminAuth, verifyCsrfOrigin } from "@/lib/probe/auth.js";
import { getProbeProfileById, deleteProbeProfile } from "@/lib/db/repos/probeProfilesRepo.js";

export async function GET(request, { params }) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const profile = await getProbeProfileById(id);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return NextResponse.json({ profile });
}

export async function DELETE(request, { params }) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!verifyCsrfOrigin(request)) {
    return NextResponse.json({ error: "Forbidden: CSRF origin mismatch" }, { status: 403 });
  }

  const { id } = await params;
  const deleted = await deleteProbeProfile(id);
  if (!deleted) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, deleted: true });
}
