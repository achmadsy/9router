import { NextResponse } from "next/server";
import { getApiKeys, createApiKey } from "@/lib/localDb";
import { getApiKeyTokenUsage } from "@/lib/db/repos/usageRepo.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { API_KEY_ACCESS_MODE, parseTokenLimitInput } from "@/lib/apiKeys/constants.js";
import { normalizeTargets } from "@/lib/apiKeys/policy.js";
import { parsePolicyInput } from "@/lib/apiKeys/validate.js";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys (metadata only; never secrets)
export async function GET() {
  try {
    const keys = await getApiKeys();
    // Attach current-window usage for limited keys so the UI can show progress.
    const withUsage = await Promise.all(
      keys.map(async (k) => {
        if (!k.tokenLimit) return k;
        try {
          const usage = await getApiKeyTokenUsage(k.id, k.tokenLimitPeriod);
          return { ...k, tokenUsage: usage.totalTokens };
        } catch {
          return k;
        }
      })
    );
    return NextResponse.json({ keys: withUsage });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key. Plaintext also encrypted at rest for later show/copy.
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const policy = parsePolicyInput(body);
    if (policy.error) {
      return NextResponse.json({ error: policy.error }, { status: 400 });
    }

    const accessMode = policy.accessMode === API_KEY_ACCESS_MODE.RESTRICTED
      ? API_KEY_ACCESS_MODE.RESTRICTED
      : API_KEY_ACCESS_MODE.ALL;
    const targets = accessMode === API_KEY_ACCESS_MODE.RESTRICTED
      ? normalizeTargets(policy.targets || body.targets || [])
      : [];

    const tokenLimit = parseTokenLimitInput(body);
    if (tokenLimit.error) {
      return NextResponse.json({ error: tokenLimit.error }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const created = await createApiKey(name, machineId, {
      accessMode,
      targets,
      tokenLimit: tokenLimit.tokenLimit,
      tokenLimitPeriod: tokenLimit.tokenLimitPeriod,
    });

    return NextResponse.json({
      // One-time plaintext — never stored. Prefer `secret`; keep `key` for older clients.
      secret: created.key,
      key: created.key,
      keyHint: created.keyHint,
      name: created.name,
      id: created.id,
      machineId: created.machineId,
      accessMode: created.accessMode,
      targets,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
