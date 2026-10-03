import { getProviderNodeById } from "@/models";
import { isProviderCloneId, resolveRuntimeProviderId } from "open-sse/providers/clones.js";

export function readAsParam(request, body) {
  const fromUrl = new URL(request.url).searchParams.get("as");
  return fromUrl !== null ? fromUrl : body?.as ?? null;
}

export function applySavedProvider(data, saved) {
  return {
    ...data,
    provider: saved.provider,
    ...(saved.providerSpecificData ? {
      providerSpecificData: { ...data.providerSpecificData, ...saved.providerSpecificData },
    } : {}),
  };
}

export function sessionDestination(session, asParam, baseProvider) {
  const target = session?.targetProviderId || baseProvider;
  if (asParam != null && asParam !== target) {
    const error = new Error("OAuth destination does not match the login session");
    error.status = 400;
    throw error;
  }
  return target;
}

export async function saveOAuthConnection(data, asParam) {
  const saved = await resolveSavedProviderId(asParam, data.provider);
  const { createProviderConnection } = await import("@/models");
  return createProviderConnection(applySavedProvider(data, saved));
}

// OAuth uses the base transport, but duplicate providers own separate credential pools.
export async function resolveSavedProviderId(asParam, baseProvider) {
  const canonicalProvider = (id) => id === "kimi-coding" ? "kimi" : id;
  if (asParam == null || asParam === baseProvider) {
    return { provider: baseProvider, providerSpecificData: null };
  }

  if (typeof asParam === "string" && isProviderCloneId(asParam)) {
    const node = await getProviderNodeById(asParam);
    if (node?.type === "provider-clone" &&
        canonicalProvider(node.baseProvider) === canonicalProvider(baseProvider) &&
        resolveRuntimeProviderId(asParam) === node.baseProvider) {
      return {
        provider: asParam,
        providerSpecificData: {
          baseProvider: node.baseProvider,
          prefix: node.prefix,
          nodeName: node.name,
        },
      };
    }
  }

  const error = new Error("Invalid OAuth destination; restart login from the selected provider");
  error.status = 400;
  throw error;
}
