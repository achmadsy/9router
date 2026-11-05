import { NextResponse } from "next/server";
import { ZaiAuthFlow } from "@/lib/zcode/auth";
import { createZaiSession } from "@/lib/zcode/sessions";
import { resolveSavedProviderId, readAsParam } from "@/lib/oauth/utils/savedProvider";
import { resolveZaiNetwork, validateZaiNetworkRoute } from "@/lib/zcode/network";
import { validateZaiPlanMode, ZAI_PLAN_MODES } from "@/lib/zcode/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/oauth/zai/init — start Z.AI CLI poll OAuth.
 * Server returns authorize_url with zcode.z.ai's own callback (no localhost).
 */
export async function POST(request) {
  try {
    const saved = await resolveSavedProviderId(request ? readAsParam(request) : null, "glm");
    const body = await request.json().catch(() => ({}));
    const networkRoute = validateZaiNetworkRoute(body.networkRoute ?? "account");
    const zaiPlanMode = validateZaiPlanMode(body.zaiPlanMode || ZAI_PLAN_MODES.START);
    const { proxyOptions, network } = await resolveZaiNetwork(networkRoute);
    const flow = new ZaiAuthFlow(undefined, null, proxyOptions);
    const init = await flow.start();

    await createZaiSession({
      flowId: init.flowId,
      pollToken: init.pollToken,
      provider: init.provider,
      targetProviderId: saved.provider,
      networkRoute,
      zaiPlanMode,
      pollIntervalSec: flow.pollIntervalSec,
      expiresAtMs: flow.expiresAt || undefined,
    });

    return NextResponse.json({
      flowId: init.flowId,
      authorizeUrl: init.authorizeUrl,
      provider: init.provider,
      pollAfterMs: flow.nextPollDelayMs,
      network,
    });
  } catch (error) {
    console.error("[Z.AI OAuth] init error:", error);
    return NextResponse.json({ error: error.message }, { status: error.status === 400 ? 400 : 500 });
  }
}
