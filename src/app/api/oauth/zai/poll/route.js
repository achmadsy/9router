import { NextResponse } from "next/server";
import { ZaiAuthFlow } from "@/lib/zcode/auth";
import { getZaiSession, updateZaiSession, deleteZaiSession, withZaiSessionLock } from "@/lib/zcode/sessions";
import { saveOAuthConnection, sessionDestination, readAsParam } from "@/lib/oauth/utils/savedProvider";
import { resolveZaiNetwork, zaiNetworkConnectionData } from "@/lib/zcode/network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const flowId = body?.flowId;
    if (typeof flowId !== "string" || !flowId.trim()) {
      return NextResponse.json({ error: "flowId is required" }, { status: 400 });
    }
    return await withZaiSessionLock(flowId, async () => {
      let session = await getZaiSession(flowId);
      if (!session) return NextResponse.json({ error: "OAuth session expired or not found" }, { status: 404 });
      const targetProviderId = sessionDestination(session, readAsParam(request, body), "glm");
      if (session.result) return NextResponse.json({ ...session.result, status: "ready" });
      if (!session.tokenData && typeof body.initializeStartPlan === "boolean") {
        session = await updateZaiSession(flowId, { initializeStartPlan: body.initializeStartPlan });
      }
      const networkRoute = session.networkRoute || "account";
      const { proxyOptions, network } = await resolveZaiNetwork(networkRoute);
      const flow = new ZaiAuthFlow(undefined, session.pollToken, proxyOptions);
      Object.assign(flow, { flowId: session.flowId, expiresAt: session.expiresAt,
        pollIntervalSec: session.pollIntervalSec || 2 });
      if (!session.tokenData) {
        if (!session.authorization && Date.now() < (session.nextPollAt || 0)) {
          return NextResponse.json({ status: "pending", pollAfterMs: session.nextPollAt - Date.now() });
        }
        session = await updateZaiSession(flowId, { nextPollAt: Date.now() + flow.nextPollDelayMs });
        const data = session.authorization || await flow.poll();
        if (data.status === "pending") return NextResponse.json({ status: "pending", pollAfterMs: flow.nextPollDelayMs });
        if (data.status !== "ready" || !data.zai?.access_token) {
          await deleteZaiSession(flowId);
          return NextResponse.json({ status: "failed", error: data.error || "Authorization failed" });
        }
        session = await updateZaiSession(flowId, { authorization: data });
        const tokenData = await flow.exchangeForConnection(data.zai.access_token, data.token, data);
        tokenData.providerSpecificData = { ...tokenData.providerSpecificData,
          ...zaiNetworkConnectionData(networkRoute), zaiPlanMode: session.zaiPlanMode || "start-plan" };
        session = await updateZaiSession(flowId, { tokenData });
      }
      if (session.initializeStartPlan && !session.preparationAttempted) {
        session = await updateZaiSession(flowId, { preparationAttempted: true });
        try {
          await flow.initializeStartPlan(session.tokenData, proxyOptions);
          session = await updateZaiSession(flowId, { startPlanInitialized: true });
        } catch (error) {
          session = await updateZaiSession(flowId, { warning: error.message || "Start Plan preparation failed" });
        }
      }
      const connection = await saveOAuthConnection({ ...session.tokenData, provider: "glm",
        authType: "oauth", testStatus: "active", isActive: true }, targetProviderId);
      const result = { status: "ready", connection: { id: connection.id, provider: connection.provider,
        email: connection.email, name: connection.name }, network,
        startPlanInitialized: session.startPlanInitialized === true,
        ...(session.warning ? { warning: session.warning } : {}) };
      await updateZaiSession(flowId, { result, tokenData: null, authorization: null });
      return NextResponse.json(result);
    });
  } catch (error) {
    console.error("[Z.AI OAuth] poll error:", error.message);
    return NextResponse.json({ error: error.message || "Internal error" }, { status: error.status === 400 ? 400 : 502 });
  }
}
