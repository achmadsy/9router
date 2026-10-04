import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getModelPickerProvider } from "@/shared/utils/providerModelIdentity";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

const cloneId = "codex-clone-u5xnt5pxmusmzbf3";
const connection = {
  provider: cloneId,
  providerSpecificData: { prefix: "cx-dup", nodeName: "codex-2" },
};

function pickerGroups({ customModels = [], modelAliases = {}, disabledModels = {} } = {}) {
  // Execute the component's actual grouping body without a JSX/DOM renderer.
  const source = readFileSync(new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url), "utf8");
  const start = source.indexOf("    const groups = {};");
  const end = source.indexOf("    return groups;", start) + "    return groups;".length;
  const build = new Function("context", `const { filteredActiveProviders, activeProviders, providerNodes,
    customModels, modelAliases, disabledModels, kindFilter, NO_AUTH_PROVIDER_IDS, PROVIDER_ORDER,
    AI_PROVIDERS, getModelPickerProvider, getProviderAlias, isOpenAICompatibleProvider,
    isAnthropicCompatibleProvider, getModelsByProviderId, getModelKind,
    cursorModels, clineModels, clinepassModels, zedModels } = context; ${source.slice(start, end)}`);
  return build({
    filteredActiveProviders: [connection], activeProviders: [connection], providerNodes: [],
    customModels, modelAliases, disabledModels, kindFilter: null,
    NO_AUTH_PROVIDER_IDS: [], PROVIDER_ORDER: [], AI_PROVIDERS: {},
    getModelPickerProvider, getProviderAlias, isOpenAICompatibleProvider,
    isAnthropicCompatibleProvider, getModelsByProviderId, getModelKind,
    cursorModels: [], clineModels: [], clinepassModels: [], zedModels: [],
  });
}

describe("model picker clone identity", () => {
  it("renders clone name and emits prefixed values from the actual picker grouping", () => {
    const group = pickerGroups()[cloneId];
    expect(group.name).toBe("codex-2");
    expect(group.models.find((m) => m.id === "gpt-6.1-sol").value).toBe("cx-dup/gpt-6.1-sol");
    expect(group.models.every((m) => m.value.startsWith("cx-dup/"))).toBe(true);
  });

  it("keeps custom and disabled models scoped to clone storage", () => {
    const group = pickerGroups({
      customModels: [
        { providerAlias: cloneId, id: "clone-custom" },
        { providerAlias: "cx", id: "base-custom" },
      ],
      modelAliases: { "clone-alias": `${cloneId}/clone-alias` },
      disabledModels: { [cloneId]: ["gpt-6.1-sol"], cx: ["gpt-5.5"] },
    })[cloneId];
    expect(group.models.find((m) => m.id === "clone-custom").value).toBe("cx-dup/clone-custom");
    expect(group.models.find((m) => m.id === "clone-alias").value).toBe("cx-dup/clone-alias");
    expect(group.models.some((m) => m.id === "base-custom")).toBe(false);
    expect(group.models.some((m) => m.id === "gpt-6.1-sol")).toBe(false);
    expect(group.models.some((m) => m.id === "gpt-5.5")).toBe(true);
  });

  it("uses the clone name and routing prefix while keeping storage isolated", () => {
    const identity = getModelPickerProvider(cloneId, connection);
    expect(identity.providerInfo.name).toBe("codex-2");
    expect(identity.runtimeProvider).toBe("codex");
    expect(identity.storageAlias).toBe(cloneId);
    expect(`${identity.alias}/gpt-6.1-sol`).toBe("cx-dup/gpt-6.1-sol");
  });

  it("prefers current node metadata over stale connection metadata", () => {
    const identity = getModelPickerProvider(cloneId, connection, {
      id: cloneId, name: "renamed-codex", prefix: "cx-new",
    });
    expect(identity.providerInfo.name).toBe("renamed-codex");
    expect(identity.alias).toBe("cx-new");
    expect(identity.storageAlias).toBe(cloneId);
  });

  it("never falls back to the base alias when clone metadata is missing", () => {
    const identity = getModelPickerProvider(cloneId);
    expect(identity.alias).toBe(cloneId);
    expect(identity.alias).not.toBe("cx");
  });

  it("keeps sibling clone prefixes and model storage separate", () => {
    const sibling = getModelPickerProvider("codex-clone-sibling", {
      providerSpecificData: { prefix: "cx-other", nodeName: "codex-3" },
    });
    expect(sibling.alias).toBe("cx-other");
    expect(sibling.storageAlias).toBe("codex-clone-sibling");
    expect(sibling.providerInfo.name).toBe("codex-3");
  });

  it("preserves built-in provider aliases and names", () => {
    const identity = getModelPickerProvider("codex");
    expect(identity.alias).toBe("cx");
    expect(identity.storageAlias).toBe("cx");
    expect(identity.providerInfo.name).toBe("OpenAI Codex");
  });

  it("inherits metadata for other provider clones without inheriting identity", () => {
    const identity = getModelPickerProvider("glm-clone-test", {
      providerSpecificData: { prefix: "glm-dup", nodeName: "glm-2" },
    });
    expect(identity.runtimeProvider).toBe("glm");
    expect(identity.alias).toBe("glm-dup");
    expect(identity.providerInfo.name).toBe("glm-2");
    expect(identity.storageAlias).toBe("glm-clone-test");
  });
});
