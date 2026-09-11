import { PROVIDER_MODELS } from "@/shared/constants/models";
import { authorizeResource, loadCombosForPolicy } from "@/lib/apiKeys/policy.js";
import { resolveApiKeyContext } from "@/sse/services/apiKeyPolicy.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format, filtered by API-key policy when a key is presented.
 */
export async function GET(request) {
  try {
    // Invalid/paused presented keys → 401 even when requireApiKey is false.
    const keyCtx = await resolveApiKeyContext(request);
    if (keyCtx.errorResponse) return keyCtx.errorResponse;
    const keyRow = keyCtx.keyRow;

    const models = [];
    const seen = new Set();
    // Preload combo aliases once; authorizeResource only needs the combo table for UUID↔name.
    const policyCombos = keyRow ? await loadCombosForPolicy() : [];

    async function addModel({ name, displayName, description, methods = ["generateContent"], policyId }) {
      if (seen.has(name)) return;
      if (keyRow && policyId) {
        const auth = await authorizeResource(keyRow, policyId, {
          getCombos: async () => policyCombos,
        });
        if (!auth.allowed) return;
      }
      seen.add(name);
      models.push({
        name,
        displayName,
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit: 128000,
        outputTokenLimit: 8192,
      });
    }

    for (const [provider, providerModels] of Object.entries(PROVIDER_MODELS)) {
      for (const model of providerModels) {
        await addModel({
          name: `models/${provider}/${model.id}`,
          displayName: model.name || model.id,
          description: `${provider} model: ${model.name || model.id}`,
          policyId: `${provider}/${model.id}`,
        });

        if (provider === "gemini") {
          await addModel({
            name: `models/${model.id}`,
            displayName: model.name || model.id,
            description: `Gemini model: ${model.name || model.id}`,
            methods: ["generateContent", "streamGenerateContent"],
            policyId: `gemini/${model.id}`,
          });
        }
      }
    }

    return Response.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
