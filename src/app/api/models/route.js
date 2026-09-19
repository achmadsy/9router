import { NextResponse } from "next/server";
import {
  getModelAliases,
  setModelAlias,
  getCustomModels,
  getProviderConnections,
  getProviderNodes,
} from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getModelCapabilityOverrides } from "@/lib/db/repos/modelCapabilityRepo.js";
import { AI_MODELS } from "@/shared/constants/config";
import {
  AI_PROVIDERS,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildProviderMetadata(nodes, connections) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const connectionsByProvider = new Map();
  for (const connection of connections) {
    if (!connectionsByProvider.has(connection.provider)) {
      connectionsByProvider.set(connection.provider, connection);
    }
  }

  return (provider, providerAlias) => {
    const node = nodesById.get(provider);
    const connection = connectionsByProvider.get(provider);
    const staticProvider = AI_PROVIDERS[provider];
    const compatibleLabel = isOpenAICompatibleProvider(provider)
      ? "OpenAI Compatible"
      : isAnthropicCompatibleProvider(provider)
        ? "Anthropic Compatible"
        : null;
    const providerName = node?.name
      || connection?.providerSpecificData?.nodeName
      || connection?.name
      || staticProvider?.name
      || compatibleLabel
      || providerAlias
      || provider;
    const providerPrefix = connection?.providerSpecificData?.prefix
      || node?.prefix
      || staticProvider?.alias
      || compatibleLabel
      || providerAlias
      || provider;
    return { providerName, providerPrefix };
  };
}

function matchesSearch(model, search) {
  if (!search) return true;
  return [model.providerName, model.providerPrefix, model.provider, model.model, model.name, model.alias]
    .some((value) => String(value || "").toLowerCase().includes(search));
}

function withCapabilities(model) {
  const c = getCapabilitiesForModel(model.provider, model.model);
  const { storedCaps, ...result } = model;
  return {
    ...result,
    caps: {
      vision: c.vision,
      search: c.search,
      reasoning: c.reasoning,
      contextWindow: c.contextWindow,
      maxOutput: c.maxOutput,
      ...(storedCaps || {}),
    },
  };
}

// GET /api/models - Get models with aliases. Existing callers without paging
// params retain the full-list response; the Models dashboard requests a bounded page.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const paginated = searchParams.has("page") || searchParams.has("pageSize") || searchParams.has("search");
    const requestedPage = positiveInteger(searchParams.get("page"), 1);
    const pageSize = Math.min(positiveInteger(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const search = String(searchParams.get("search") || "").trim().toLowerCase();

    const [modelAliases, disabled, customModels, nodes, connections, capabilityOverrides] = await Promise.all([
      getModelAliases(),
      getDisabledModels(),
      getCustomModels(),
      getProviderNodes(),
      getProviderConnections(),
      getModelCapabilityOverrides(),
    ]);
    const resolveProviderMetadata = buildProviderMetadata(nodes, connections);
    const overriddenModels = new Set(capabilityOverrides.map((item) => `${item.provider}|${item.model}`));

    // Build lightweight descriptors first. Paginated requests filter/slice these
    // before capability resolution, so only visible rows pay that work.
    const descriptors = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        return {
          ...m,
          ...resolveProviderMetadata(m.provider, providerAlias),
          fullModel,
          routedModel: `${providerAlias}/${m.model}`,
          alias: modelAliases[fullModel] || m.model,
          overridden: overriddenModels.has(`${m.provider}|${m.model}`),
        };
      });

    const seenFull = new Set(descriptors.map((m) => m.fullModel));
    for (const m of customModels) {
      if (!m?.id || (m.kind || m.type || "llm") !== "llm") continue;
      const fullModel = `${m.providerAlias}/${m.id}`;
      if (seenFull.has(fullModel)) continue;
      descriptors.push({
        provider: m.providerAlias,
        model: m.id,
        name: m.name || m.id,
        ...resolveProviderMetadata(m.providerAlias, m.providerAlias),
        fullModel,
        routedModel: fullModel,
        alias: modelAliases[fullModel] || m.id,
        overridden: overriddenModels.has(`${m.providerAlias}|${m.id}`),
        storedCaps: m.caps,
      });
    }

    if (!paginated) {
      return NextResponse.json({ models: descriptors.map(withCapabilities) });
    }

    const filtered = descriptors.filter((model) => matchesSearch(model, search));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const start = (page - 1) * pageSize;
    const models = filtered.slice(start, start + pageSize).map(withCapabilities);

    return NextResponse.json({
      models,
      pagination: { page, pageSize, total, totalPages },
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    await setModelAlias(model, alias);
    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
