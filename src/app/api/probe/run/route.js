import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { verifyProbeAdminAuth, verifyCsrfOrigin } from "@/lib/probe/auth.js";
import { getActiveRun, startActiveRun, finishActiveRun } from "@/lib/probe/activeRun.js";
import { getProbeProfileSecrets } from "@/lib/db/repos/probeProfilesRepo.js";
import { createProbeRun, finishProbeRun, getProbeRun, getProbeRunReplay } from "@/lib/db/repos/probeRunsRepo.js";
import { runProbeOnSidecar, fetchBaselineMap } from "@/lib/probe/sidecarClient.js";
import { createBoundedSseStream, boundErrorMessage } from "@/lib/probe/sseProxy.js";
import { redactSensitiveText } from "@/lib/sentry.js";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
import { getCurrentGatewayBaseUrl, normalizeProbeSource, PROBE_SOURCE_SELF } from "@/lib/probe/endpoints.js";
import { normalizeProbeCustomHeaders } from "@/lib/probe/customHeaders.js";
import { ORIGINAL_SUITE_IDS } from "@/lib/probe/originalSuite.js";

export async function GET(request) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const run = getActiveRun();
  return NextResponse.json({ active: Boolean(run), run });
}

export async function POST(request) {
  const auth = await verifyProbeAdminAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!verifyCsrfOrigin(request)) {
    return NextResponse.json({ error: "Forbidden: CSRF origin mismatch" }, { status: 403 });
  }

  // Enforce one active run
  const current = getActiveRun();
  if (current) {
    return NextResponse.json(
      {
        error: "A probe run is already in progress",
        activeRunId: current.runId,
      },
      { status: 409 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let operation;
  let previousResults;
  let retryProbeId;
  if (body?.sourceRunId) {
    if (!["rerun", "retry", "rejudge"].includes(body.action)) {
      return NextResponse.json({ error: "Invalid saved-run action" }, { status: 400 });
    }
    const saved = await getProbeRun(body.sourceRunId);
    if (!saved) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    if (saved.status === "running") return NextResponse.json({ error: "Wait for this run to finish" }, { status: 409 });
    const replay = await getProbeRunReplay(saved.id);
    if (!replay) return NextResponse.json({ error: "Replay settings are unavailable or expired. Start a new run from Probe configuration." }, { status: 410 });
    if (body.probeId !== undefined && !ORIGINAL_SUITE_IDS.includes(body.probeId)) {
      return NextResponse.json({ error: "Unknown check" }, { status: 400 });
    }
    if (body.action === "retry" && !body.probeId) {
      return NextResponse.json({ error: "Select a check to retry" }, { status: 400 });
    }
    if (body.action !== "rerun") {
      if (!saved.results.length) return NextResponse.json({ error: "No saved results to replay" }, { status: 400 });
      operation = body.action;
      previousResults = saved.results;
      retryProbeId = body.probeId;
    }
    body = replay;
  }

  const { target, targetProfileId, judge, judgeProfileId, config = {} } = body || {};

  // Resolve target
  let resolvedTarget = null;
  if (targetProfileId) {
    const profile = await getProbeProfileSecrets(targetProfileId);
    if (!profile) {
      return NextResponse.json({ error: "Target profile not found" }, { status: 400 });
    }
    resolvedTarget = {
      source: profile.source,
      model: profile.model,
      endpoint: profile.endpoint,
      ...(profile.secrets || {}),
    };
  } else if (target && typeof target === "object") {
    resolvedTarget = target;
  } else {
    return NextResponse.json(
      { error: "Target configuration or targetProfileId is required" },
      { status: 400 }
    );
  }

  // Resolve judge (optional — engine runs identity/quality probes without one)
  let resolvedJudge = null;
  if (judgeProfileId) {
    const profile = await getProbeProfileSecrets(judgeProfileId);
    if (!profile) {
      return NextResponse.json({ error: "Judge profile not found" }, { status: 400 });
    }
    resolvedJudge = {
      source: profile.source,
      model: profile.model,
      endpoint: profile.endpoint,
      ...(profile.secrets || {}),
    };
  } else if (judge && typeof judge === "object") {
    resolvedJudge = judge;
  }

  // Self-source URLs come only from server configuration/request origin. Custom
  // endpoints remain public-only; sidecar performs authoritative connect-time pinning.
  const prepareEndpoint = async (node, label) => {
    if (!node) return null;
    const source = normalizeProbeSource(node.source, node.endpoint || node.baseUrl);
    const customHeaders = normalizeProbeCustomHeaders(node.customHeaders);
    if (source === PROBE_SOURCE_SELF) {
      return { ...node, source, customHeaders, endpoint: getCurrentGatewayBaseUrl(request) };
    }
    const endpoint = node.endpoint || node.baseUrl;
    if (!endpoint) throw new Error(`${label} endpoint is required`);
    try {
      await assertPublicUrlResolved(endpoint, { requireResolve: true });
    } catch (err) {
      throw new Error(`Invalid ${label.toLowerCase()} endpoint: ${err.message}`);
    }
    return { ...node, source, customHeaders, endpoint };
  };

  try {
    resolvedTarget = await prepareEndpoint(resolvedTarget, "Target");
    resolvedJudge = await prepareEndpoint(resolvedJudge, "Judge");
  } catch (err) {
    return NextResponse.json(
      { error: err.message },
      { status: 400 }
    );
  }

  const runId = `prun_${randomUUID()}`;
  const abortController = new AbortController();

  const started = startActiveRun({
    runId,
    ownerId: auth.ownerId,
    abortController,
  });

  if (!started.ok) {
    return NextResponse.json(
      { error: started.error, activeRunId: started.activeRunId },
      { status: started.status || 409 }
    );
  }

  // Persist the run up front so a page refresh mid-run can hydrate from the DB.
  try {
    await createProbeRun({
      id: runId,
      targetModel: resolvedTarget.model,
      targetSource: resolvedTarget.source,
      claimedModel: resolvedTarget.claimedModel,
      totalProbes: ORIGINAL_SUITE_IDS.length,
      ownerId: auth.ownerId,
      replayConfig: { target: resolvedTarget, judge: resolvedJudge, config },
    });
  } catch {
    finishActiveRun(runId);
    return NextResponse.json({ error: "Failed to create probe run" }, { status: 500 });
  }

  let sidecarRes;
  try {
    const baseline = await fetchBaselineMap(resolvedTarget.model);
    sidecarRes = await runProbeOnSidecar(
      {
        runId,
        target: resolvedTarget,
        judge: resolvedJudge,
        config,
        operation,
        previousResults,
        retryProbeId,
        ...(baseline ? { baseline } : {}),
      },
      abortController.signal
    );
  } catch (err) {
    finishActiveRun(runId);
    await finishProbeRun(runId, "error").catch(() => {});
    const boundedErr = boundErrorMessage(redactSensitiveText(err.message));
    return NextResponse.json(
      { error: `Failed to reach probe sidecar: ${boundedErr}` },
      { status: 502 }
    );
  }

  if (!sidecarRes.ok) {
    finishActiveRun(runId);
    await finishProbeRun(runId, "error").catch(() => {});
    const text = await sidecarRes.text().catch(() => "");
    const boundedErr = boundErrorMessage(redactSensitiveText(text) || `Sidecar returned HTTP ${sidecarRes.status}`);
    return NextResponse.json(
      { error: boundedErr },
      { status: sidecarRes.status >= 400 && sidecarRes.status < 600 ? sidecarRes.status : 502 }
    );
  }

  // Detach persistence from the browser connection. A refresh may cancel the
  // client branch, but the persistence branch keeps consuming the sidecar SSE,
  // stores every result, and owns active-run cleanup. Explicit Cancel still
  // reaches the sidecar via /api/probe/cancel.
  const [clientBranch, persistenceBranch] = sidecarRes.body.tee();
  const boundedStream = clientBranch.pipeThrough(
    createBoundedSseStream(runId, { manageLifecycle: false }),
  );
  const persistenceStream = persistenceBranch.pipeThrough(
    createBoundedSseStream(runId, { persist: true, manageLifecycle: true }),
  );
  void persistenceStream.pipeTo(new WritableStream()).catch(async () => {
    finishActiveRun(runId);
    await finishProbeRun(runId, "interrupted").catch(() => {});
  });

  return new Response(boundedStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "x-probe-run-id": runId,
    },
  });
}
