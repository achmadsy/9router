import { resolveRuntimeProviderId } from "open-sse/providers/clones.js";

export const GROUPED_QUOTA_PROVIDER_IDS = new Set([
  "glm",
  "grok-cli",
  "kiro",
]);

export function getQuotaProviderGroupId(connection) {
  const runtimeProvider = resolveRuntimeProviderId(connection?.provider);
  return GROUPED_QUOTA_PROVIDER_IDS.has(runtimeProvider)
    ? runtimeProvider
    : null;
}

/**
 * Keep grouped providers atomic while preserving the first-seen card order.
 * Non-grouped connections remain one card each.
 */
export function groupQuotaConnections(connections = []) {
  const items = [];
  const groupedItems = new Map();

  for (const connection of connections) {
    const provider = getQuotaProviderGroupId(connection);
    if (!provider) {
      items.push({ type: "single", connection });
      continue;
    }

    let item = groupedItems.get(provider);
    if (!item) {
      item = { type: "group", provider, connections: [] };
      groupedItems.set(provider, item);
      items.push(item);
    }
    item.connections.push(connection);
  }

  return items;
}
