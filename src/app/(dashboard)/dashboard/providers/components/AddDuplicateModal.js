"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal, Select } from "@/shared/components";
import {
  AI_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
} from "@/shared/constants/providers";
import { resolveRuntimeProviderId } from "open-sse/providers/clones.js";

function buildSourceOptions(providerNodes) {
  const registry = [
    ...Object.entries(OAUTH_PROVIDERS),
    ...Object.entries(APIKEY_PROVIDERS),
    ...Object.entries(FREE_TIER_PROVIDERS),
    ...Object.entries(FREE_PROVIDERS),
    ...Object.entries(WEB_COOKIE_PROVIDERS),
  ];

  const seen = new Set();
  const options = [];

  for (const [id, info] of registry) {
    if (!info || info.hidden || info.noAuth) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      value: id,
      label: `${info.name || id} (source)`,
      kind: "registry",
    });
  }

  for (const node of providerNodes || []) {
    if (!node?.id || !node?.prefix) continue;
    if (node.type === "provider-clone") continue;
    const label = node.name || node.type;
    options.push({
      value: node.id,
      label: `${label} (${node.prefix}/*)`,
      kind: node.type === "openai-compatible" ? "openai-compatible"
        : node.type === "anthropic-compatible" ? "anthropic-compatible"
        : node.type === "custom-embedding" ? "custom-embedding"
        : "unknown",
    });
  }

  return options.sort((a, b) => a.label.localeCompare(b.label));
}

function defaultPrefixFor(sourceValue, sourceOptions, providerNodes) {
  if (!sourceValue) return "";
  const fromNodes = (providerNodes || []).find((n) => n.id === sourceValue);
  if (fromNodes?.prefix) return `${fromNodes.prefix}-dup`;
  const base = resolveRuntimeProviderId(sourceValue);
  const info = AI_PROVIDERS[base];
  const alias = info?.alias || base;
  return alias ? `${alias}-dup` : "";
}

export default function AddDuplicateModal({ isOpen, onClose, onCreated, providerNodes }) {
  const sourceOptions = useMemo(
    () => buildSourceOptions(providerNodes),
    [providerNodes],
  );

  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSourceChange = (value) => {
    setSourceId(value);
    setError("");
    const suggested = defaultPrefixFor(value, sourceOptions, providerNodes);
    if (suggested) setPrefix((prev) => prev || suggested);
  };

  const handleClose = () => {
    setSourceId("");
    setName("");
    setPrefix("");
    setError("");
    onClose();
  };

  const selected = sourceOptions.find((o) => o.value === sourceId) || null;
  const canSubmit =
    !!sourceId &&
    !!name.trim() &&
    !!prefix.trim() &&
    !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      const isRegistry = selected?.kind === "registry";
      const payload = isRegistry
        ? {
            type: "provider-clone",
            baseProvider: sourceId,
            name: name.trim(),
            prefix: prefix.trim(),
          }
        : {
            type: selected?.kind || "openai-compatible",
            name: name.trim(),
            prefix: prefix.trim(),
            ...(selected?.kind === "openai-compatible"
              ? {
                  apiType: "chat",
                  baseUrl: "https://api.openai.com/v1",
                }
              : {}),
            ...(selected?.kind === "anthropic-compatible"
              ? {
                  baseUrl: "https://api.anthropic.com/v1",
                }
              : {}),
            ...(selected?.kind === "custom-embedding"
              ? {
                  baseUrl: "https://api.openai.com/v1",
                }
              : {}),
          };

      // Copy baseUrl/apiType from source node when duplicating a custom node
      if (!isRegistry) {
        const srcNode = (providerNodes || []).find((n) => n.id === sourceId);
        if (srcNode) {
          if (srcNode.baseUrl) payload.baseUrl = srcNode.baseUrl;
          if (srcNode.apiType) payload.apiType = srcNode.apiType;
        }
      }

      const res = await fetch("/api/provider-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create duplicate");
        return;
      }
      onCreated?.(data.node);
      handleClose();
    } catch {
      setError("Failed to create duplicate");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Add Duplicate" onClose={handleClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          Clone an existing provider under a new name and model prefix. Connections
          (API keys / OAuth) are isolated — the source provider is untouched.
        </p>
        <Select
          label="Source provider"
          options={sourceOptions}
          value={sourceId}
          onChange={(e) => handleSourceChange(e.target.value)}
          placeholder="Select a provider to duplicate"
        />
        <Input
          label="New name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="codex-test1"
          hint="Must be unique among providers and connections."
        />
        <Input
          label="Model prefix"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder="cx-test"
          hint="Required. Models are exposed as prefix/* (e.g. cx-test/gpt-5.5). Must not collide with built-in aliases or other prefixes."
        />
        {error ? (
          <p className="text-sm text-red-500">{error}</p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? "Creating..." : "Create Duplicate"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AddDuplicateModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreated: PropTypes.func,
  providerNodes: PropTypes.array,
};
