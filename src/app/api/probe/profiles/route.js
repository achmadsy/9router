import { NextResponse } from "next/server";
import { verifyProbeAdminAuth, verifyCsrfOrigin } from "@/lib/probe/auth.js";
import { listProbeProfiles, createProbeProfile } from "@/lib/db/repos/probeProfilesRepo.js";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
import { PROBE_SOURCE_CUSTOM, PROBE_SOURCE_SELF } from "@/lib/probe/endpoints.js";
import { normalizeProbeCustomHeaders } from "@/lib/probe/customHeaders.js";

const MAX_BODY_BYTES = 32_768;
const MAX_API_KEY_LENGTH = 8192;
const MAX_PROFILE_NAME_LENGTH = 128;

export async function GET(request) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const profiles = await listProbeProfiles(type || null);
  return NextResponse.json({ profiles });
}

export async function POST(request) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!verifyCsrfOrigin(request)) {
    return NextResponse.json({ error: "Forbidden: CSRF origin mismatch" }, { status: 403 });
  }

  let body;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body?.secrets?.apiKey === "string" && body.secrets.apiKey.length > MAX_API_KEY_LENGTH) {
    return NextResponse.json({ error: "API key is too long" }, { status: 400 });
  }

  const { name, type, source, model, endpoint, secrets } = body || {};

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Profile name is required" }, { status: 400 });
  }
  if (name.trim().length > MAX_PROFILE_NAME_LENGTH) {
    return NextResponse.json(
      { error: `Profile name is too long (max ${MAX_PROFILE_NAME_LENGTH} characters)` },
      { status: 400 }
    );
  }

  if (type !== "target" && type !== "judge") {
  return NextResponse.json(
      { error: "Invalid profile type: must be 'target' or 'judge'" },
      { status: 400 }
    );
  }
  const normalizedSource = source === PROBE_SOURCE_CUSTOM || source === PROBE_SOURCE_SELF || endpoint
    ? (source === PROBE_SOURCE_SELF || source === PROBE_SOURCE_CUSTOM ? source : PROBE_SOURCE_CUSTOM)
    : PROBE_SOURCE_SELF;
  if (normalizedSource === PROBE_SOURCE_CUSTOM && !endpoint) {
    return NextResponse.json({ error: "Custom endpoint is required" }, { status: 400 });
  }

  let customHeaders;
  try {
    customHeaders = normalizeProbeCustomHeaders(secrets?.customHeaders);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Early SSRF validation on custom endpoint if provided
  if (normalizedSource === PROBE_SOURCE_CUSTOM && endpoint) {
    try {
      await assertPublicUrlResolved(endpoint, { requireResolve: true });
    } catch (err) {
      return NextResponse.json(
        { error: `Invalid endpoint: ${err.message}` },
        { status: 400 }
      );
    }
  }

  const profile = await createProbeProfile({
    name: name.trim(),
    type,
    source: normalizedSource,
    model: model ? String(model).trim() : null,
    endpoint: normalizedSource === PROBE_SOURCE_CUSTOM && endpoint ? String(endpoint).trim() : null,
    secrets: {
      ...(typeof secrets?.apiKey === "string" && secrets.apiKey ? { apiKey: secrets.apiKey } : {}),
      ...(Object.keys(customHeaders).length ? { customHeaders } : {}),
    },
  });

  return NextResponse.json({ profile }, { status: 201 });
}
