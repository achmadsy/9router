import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getProviderConnectionById, getProviderConnections } from "@/models";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { claimZaiPlan, hasActiveStartPlan, inspectZaiPlans, prepareOriginalStartPlan, summarizePlanError } from "@/lib/zcode/plans";
import { resolveRuntimeProviderId } from "open-sse/providers/clones.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BATCH_SIZE = 50;
const INSPECTION_CONCURRENCY = 2;
const CLAIM_DELAY_MS = 1000;

function accountLabel(connection, index = 0) {
  return connection.name || connection.email || `Account ${index + 1}`;
}

async function resolvePlanProxy(connection) {
  return resolveConnectionProxyConfig(connection.providerSpecificData, { excludeRelay: true });
}

async function inspectConnection(connection, index) {
  const base = {
    connectionId: connection.id,
    name: accountLabel(connection, index),
    email: connection.email || null,
    isActive: connection.isActive !== false,
  };
  const jwt = connection.providerSpecificData?.zcodeJwtToken?.trim();
  if (!jwt) {
    return {
      ...base,
      eligible: false,
      activePlans: [],
      offers: [],
      balances: [],
      error: "ZCode OAuth login is required for plan management",
    };
  }

  try {
    const plans = await inspectZaiPlans(jwt, await resolvePlanProxy(connection), undefined, { includeCampaigns: true });
    return { ...base, eligible: true, ...plans, originalStartPlanActive: hasActiveStartPlan(plans), error: null };
  } catch (error) {
    return {
      ...base,
      eligible: true,
      activePlans: [],
      offers: [],
      balances: [],
      error: summarizePlanError(error, "Failed to retrieve plans"),
    };
  }
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function validateProvider(providerId) {
  return resolveRuntimeProviderId(providerId) === "glm";
}

export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    if (!validateProvider(id)) {
      return NextResponse.json({ error: "Plan management is only available for Z.AI GLM providers" }, { status: 400 });
    }

    const url = new URL(_request.url);
    const pageSize = 10;
    const requestedPage = Number(url.searchParams.get("page")) || 1;
    const connections = await getProviderConnections({ provider: id });
    connections.sort((a, b) => ((a.priority || 999) - (b.priority || 999)) || a.id.localeCompare(b.id));
    const totalPages = Math.max(1, Math.ceil(connections.length / pageSize));
    const page = Math.min(totalPages, Math.max(1, Math.floor(requestedPage)));
    const visible = connections.slice((page - 1) * pageSize, page * pageSize);
    const accounts = await mapConcurrent(visible, INSPECTION_CONCURRENCY, inspectConnection);
    return NextResponse.json({
      providerId: id,
      totalAccounts: connections.length,
      eligibleAccounts: connections.filter((connection) => connection.providerSpecificData?.zcodeJwtToken?.trim()).length,
      page, pageSize, totalPages,
      accounts,
    });
  } catch (error) {
    return NextResponse.json(
      { error: summarizePlanError(error, "Failed to retrieve account plans") },
      { status: 500 }
    );
  }
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    if (!validateProvider(id)) {
      return NextResponse.json({ error: "Plan management is only available for Z.AI GLM providers" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const connectionIds = Array.isArray(body.connectionIds)
      ? [...new Set(body.connectionIds.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))]
      : typeof body.connectionId === "string" && body.connectionId.trim()
        ? [body.connectionId.trim()]
        : [];
    const planId = typeof body.planId === "string" ? body.planId.trim() : "";

    const prepareOriginal = body.action === "prepare_original_start_plan";
    if ((!planId && !prepareOriginal) || connectionIds.length === 0) {
      return NextResponse.json({ error: "planId or an original-plan preparation action, and connectionIds are required" }, { status: 400 });
    }
    if (connectionIds.length > MAX_BATCH_SIZE) {
      return NextResponse.json({ error: `At most ${MAX_BATCH_SIZE} accounts can be claimed at once` }, { status: 400 });
    }

    const batchId = randomUUID();
    const log = (connectionId = null) => ({
      event(step, outcome, details = {}) {
        const write = outcome === "failed" ? console.warn : console.info;
        write(`[Plan Management] ${step}: ${outcome}`, { batchId, ...(connectionId ? { connectionId } : {}), ...details });
      },
    });
    log().event("batch", "started", { provider: id, accounts: connectionIds.length, operation: prepareOriginal ? "original-preparation" : "explicit-claim" });
    const results = [];
    for (let index = 0; index < connectionIds.length; index += 1) {
      const connectionId = connectionIds[index];
      const diagnostics = log(connectionId);
      diagnostics.event("account", "started", { position: index + 1, total: connectionIds.length });
      const connection = await getProviderConnectionById(connectionId);
      const label = connection ? accountLabel(connection, index) : `Account ${index + 1}`;

      if (!connection || connection.provider !== id) {
        diagnostics.event("account", "failed", { reason: "Connection not found for this provider" });
        results.push({ connectionId, name: label, ok: false, error: "Connection not found for this provider" });
        continue;
      }

      const jwt = connection.providerSpecificData?.zcodeJwtToken?.trim();
      if (!jwt) {
        diagnostics.event("account", "failed", { reason: "ZCode OAuth login is required" });
        results.push({ connectionId, name: label, ok: false, error: "ZCode OAuth login is required" });
        continue;
      }

      try {
        // CloakBrowser captcha solver must share the claim's egress IP.
        const proxyOptions = await resolvePlanProxy(connection);
        const captchaProxyUrl = proxyOptions?.connectionProxyEnabled === true
          ? String(proxyOptions.connectionProxyUrl || "").trim()
          : "";
        const claimed = prepareOriginal
          ? await prepareOriginalStartPlan(connection, proxyOptions)
          : await claimZaiPlan(jwt, planId, proxyOptions, undefined, captchaProxyUrl, diagnostics);
        diagnostics.event("account", "completed", { status: claimed.status });
        results.push({
          connectionId,
          name: label,
          ok: true,
          planId: claimed.planId,
          status: claimed.status,
          message: prepareOriginal
            ? "Original daily Start Plan verified active"
            : claimed.status === "already_active"
              ? "Plan is already active"
              : claimed.status === "already_present"
                ? "Plan is already present; no claim sent"
                : claimed.status === "claimed_pending"
                  ? "Plan claimed; balance update is pending"
                  : "Plan claimed successfully",
        });
      } catch (error) {
        diagnostics.event("account", "failed", { reason: summarizePlanError(error, "Plan claim failed") });
        results.push({
          connectionId,
          name: label,
          ok: false,
          planId,
          error: summarizePlanError(error, "Plan claim failed"),
        });
      }

      if (index < connectionIds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, CLAIM_DELAY_MS));
      }
    }

    log().event("batch", "completed", {
      total: results.length,
      claimed: results.filter((result) => result.status === "claimed" || result.status === "claimed_pending").length,
      skipped: results.filter((result) => result.status === "already_active" || result.status === "already_present").length,
      failed: results.filter((result) => !result.ok).length,
    });
    return NextResponse.json({
      total: results.length,
      succeeded: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: summarizePlanError(error, "Failed to claim plans") },
      { status: 500 }
    );
  }
}
