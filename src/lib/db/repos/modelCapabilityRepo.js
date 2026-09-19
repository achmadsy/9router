import { makeKv } from "../helpers/kvStore.js";

const capabilityKv = makeKv("modelCapabilityOverrides");

function key(provider, model) {
  return `${provider}|${model}`;
}

export async function getModelCapabilityOverrides() {
  const all = await capabilityKv.getAll();
  return Object.entries(all).map(([storedKey, caps]) => {
    const separator = storedKey.indexOf("|");
    return {
      provider: separator >= 0 ? storedKey.slice(0, separator) : "",
      model: separator >= 0 ? storedKey.slice(separator + 1) : storedKey,
      caps,
    };
  });
}

export async function setModelCapabilityOverride(provider, model, caps) {
  await capabilityKv.set(key(provider, model), caps);
}

export async function deleteModelCapabilityOverride(provider, model) {
  await capabilityKv.remove(key(provider, model));
}
