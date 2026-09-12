// Dynamic provider clones (duplicates of registry providers).
// App stores them as providerNodes (type: "provider-clone"). Clone ids embed
// the base provider so sync call sites (getExecutor, PROVIDERS lookups) can
// resolve without a DB hit: `${baseProvider}-clone-${uuid}`.
//
// Clones isolate credentials: connections use provider = clone.id while the
// runtime still uses the base provider's transport, models, and executor.

const CLONE_MARK = "-clone-";

/** True when this id was produced by makeProviderCloneId. */
export function isProviderCloneId(providerId) {
  return typeof providerId === "string" && providerId.indexOf(CLONE_MARK) > 0;
}

/** Build a stable clone node/connection id from a registry provider id. */
export function makeProviderCloneId(baseProvider) {
  if (!baseProvider || typeof baseProvider !== "string") {
    throw new Error("makeProviderCloneId: baseProvider is required");
  }
  if (baseProvider.includes(CLONE_MARK)) {
    throw new Error("makeProviderCloneId: nested clones are not supported");
  }
  const suffix = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${baseProvider}${CLONE_MARK}${suffix}`;
}

/**
 * Map a clone id back to its base registry/provider-node id.
 * Non-clone ids pass through unchanged.
 */
export function resolveRuntimeProviderId(providerId) {
  if (typeof providerId !== "string") return providerId;
  const i = providerId.indexOf(CLONE_MARK);
  return i > 0 ? providerId.slice(0, i) : providerId;
}
