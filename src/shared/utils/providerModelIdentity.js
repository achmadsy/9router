import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { isProviderCloneId, resolveRuntimeProviderId } from "open-sse/providers/clones.js";

export function getModelPickerProvider(providerId, connection, node) {
  const runtimeProvider = resolveRuntimeProviderId(providerId);
  const isClone = isProviderCloneId(providerId);
  const baseInfo = AI_PROVIDERS[runtimeProvider] || { name: providerId, color: "#666" };
  const alias = isClone
    ? (node?.prefix || connection?.providerSpecificData?.prefix || providerId)
    : getProviderAlias(providerId);
  const storageAlias = isClone ? providerId : alias;
  const name = isClone
    ? (node?.name || connection?.providerSpecificData?.nodeName || providerId)
    : baseInfo.name;

  return { runtimeProvider, alias, storageAlias, providerInfo: { ...baseInfo, name } };
}
