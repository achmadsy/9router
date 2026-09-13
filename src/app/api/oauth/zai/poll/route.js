import { NextResponse } from "next/server";
import { ZaiAuthFlow } from "@/lib/zcode/auth";
import { getZaiSession, deleteZaiSession } from "@/lib/zcode/sessions";
import { createProviderConnection } from "@/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/oauth/zai/poll — poll Z.AI CLI login; mint key + create connection when ready.
 * Body: { flowId: string }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const flowId = body?.flowId;
    if (!flowId) {
      return NextResponse.json({ error: "flowId is required" }, { status: 400 });
    }

    const session = await getZaiSession(flowId);
    if (!session) {
      return NextResponse.json(
        { error: "OAuth session expired or not found" },
        { status: 404 }
      );
    }

    // Rebuild flow handle from session (CLI poll needs Bearer pollToken only).
    const flow = new ZaiAuthFlow(undefined, session.pollToken);
    flow.flowId = session.flowId;
    flow.expiresAt = session.expiresAt;

    const data = await flow.poll();

    if (data.status === "pending") {
      return NextResponse.json({
        status: "pending",
        pollAfterMs: flow.nextPollDelayMs,
      });
    }

    if (data.status === "failed") {
      await deleteZaiSession(flowId);
      return NextResponse.json({
        status: "failed",
        error: data.error || "Authorization denied or failed",
      });
    }

    if (data.status !== "ready" || !data.zai?.access_token) {
      await deleteZaiSession(flowId);
      return NextResponse.json(
        { status: "failed", error: "Access token missing from OAuth response" },
        { status: 500 }
      );
    }

    const accessToken = data.zai.access_token;
    const zcodeJwtToken = data.token;

    let tokenData;
    try {
      tokenData = await flow.exchangeForConnection(accessToken, zcodeJwtToken, data);
    } catch (err) {
      await deleteZaiSession(flowId);
      return NextResponse.json(
        { status: "failed", error: err.message || "Failed to mint API key" },
        { status: 502 }
      );
    }

    await deleteZaiSession(flowId);

    const connection = await createProviderConnection({
      provider: "glm",
      authType: "oauth",
      ...tokenData,
      testStatus: "active",
      isActive: true,
    });

    return NextResponse.json({
      status: "ready",
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        name: connection.name,
      },
    });
  } catch (error) {
    console.error("[Z.AI OAuth] poll error:", error);
    return NextResponse.json(
      { error: error.message || "Internal error" },
      { status: 500 }
    );
  }
}
