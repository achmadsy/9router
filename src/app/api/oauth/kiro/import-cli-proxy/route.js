import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { resolveSavedProviderId, readAsParam, applySavedProvider } from "@/lib/oauth/utils/savedProvider";
import { normalizeKiroExternalIdpAuth } from "@/lib/oauth/kiroExternalIdp";

/**
 * POST /api/oauth/kiro/import-cli-proxy
 * Import Kiro CLIProxyAPI auth JSON for Microsoft external_idp accounts.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const saved = await resolveSavedProviderId(readAsParam(request, body), "kiro");
    const rawAuth = body?.cliProxyAuth ?? body?.auth ?? body?.json ?? body;
    const tokenData = normalizeKiroExternalIdpAuth(rawAuth);

    const connection = await createProviderConnection(applySavedProvider({
      provider: "kiro",
      authType: "oauth",
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: tokenData.expiresAt,
      email: tokenData.email || null,
      providerSpecificData: tokenData.providerSpecificData,
      testStatus: "active",
    }, saved));

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "CLIProxyAPI import failed" },
      { status: 400 }
    );
  }
}
