import { NextResponse } from "next/server";
import { ZaiAuthFlow } from "@/lib/zcode/auth";
import { createZaiSession } from "@/lib/zcode/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/oauth/zai/init — start Z.AI CLI poll OAuth.
 * Server returns authorize_url with zcode.z.ai's own callback (no localhost).
 */
export async function POST() {
  try {
    const flow = new ZaiAuthFlow();
    const init = await flow.start();

    await createZaiSession({
      flowId: init.flowId,
      pollToken: init.pollToken,
      provider: init.provider,
      expiresAtMs: flow.expiresAt || undefined,
    });

    return NextResponse.json({
      flowId: init.flowId,
      authorizeUrl: init.authorizeUrl,
      provider: init.provider,
      pollAfterMs: flow.nextPollDelayMs,
    });
  } catch (error) {
    console.error("[Z.AI OAuth] init error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
