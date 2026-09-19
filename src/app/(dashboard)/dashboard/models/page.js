"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, CardSkeleton, Input } from "@/shared/components";

function modelKey(provider, model) {
  return `${provider}|${model}`;
}

function formatTokens(value) {
  return Number(value).toLocaleString();
}

export default function ModelsPage() {
  const [models, setModels] = useState([]);
  const [overrides, setOverrides] = useState(new Map());
  const [drafts, setDrafts] = useState({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const [modelsResponse, overridesResponse] = await Promise.all([
        fetch("/api/models"),
        fetch("/api/models/capabilities"),
      ]);
      if (!modelsResponse.ok || !overridesResponse.ok) throw new Error("Failed to load model metadata");
      const modelsData = await modelsResponse.json();
      const overridesData = await overridesResponse.json();
      const nextOverrides = new Map();
      for (const item of overridesData.overrides || []) {
        nextOverrides.set(modelKey(item.provider, item.model), item.caps || {});
      }
      setModels(modelsData.models || []);
      setOverrides(nextOverrides);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Async loader owns state updates after network I/O.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const filteredModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) =>
      `${model.provider} ${model.model} ${model.name || ""}`.toLowerCase().includes(needle));
  }, [models, query]);

  const draftFor = (model) => {
    const key = modelKey(model.provider, model.model);
    if (drafts[key]) return drafts[key];
    const override = overrides.get(key);
    return {
      contextWindow: String(override?.contextWindow ?? model.caps?.contextWindow ?? ""),
      maxOutput: String(override?.maxOutput ?? model.caps?.maxOutput ?? ""),
    };
  };

  const updateDraft = (model, field, value) => {
    const key = modelKey(model.provider, model.model);
    setDrafts((current) => ({ ...current, [key]: { ...draftFor(model), [field]: value } }));
  };

  const save = async (model) => {
    const key = modelKey(model.provider, model.model);
    const draft = draftFor(model);
    setSaving(key);
    setError("");
    try {
      const response = await fetch("/api/models/capabilities", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: model.provider,
          model: model.model,
          caps: {
            contextWindow: Number(draft.contextWindow),
            maxOutput: Number(draft.maxOutput),
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save model metadata");
      window.dispatchEvent(new Event("customModelChanged"));
      await load();
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(null);
    }
  };

  const reset = async (model) => {
    const key = modelKey(model.provider, model.model);
    setSaving(key);
    setError("");
    try {
      const response = await fetch(`/api/models/capabilities?provider=${encodeURIComponent(model.provider)}&model=${encodeURIComponent(model.model)}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to reset model metadata");
      window.dispatchEvent(new Event("customModelChanged"));
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      await load();
    } catch (resetError) {
      setError(resetError.message);
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <CardSkeleton />;

  return (
    <div className="space-y-4">
      <Card padding="md">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-main">Model token metadata</h2>
            <p className="text-sm text-text-muted mt-1">
              Set upstream context and output limits. Claude Code requests are raised to configured maximum output inflight.
            </p>
          </div>
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            icon="search"
            className="w-full sm:w-72"
          />
        </div>
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      </Card>

      <div className="space-y-3">
        {filteredModels.map((model) => {
          const key = modelKey(model.provider, model.model);
          const draft = draftFor(model);
          const overridden = overrides.has(key);
          return (
            <Card key={model.fullModel || key} padding="sm">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(220px,1fr)_180px_180px_auto] lg:items-end">
                <div className="min-w-0">
                  <p className="font-medium text-text-main truncate">{model.name || model.model}</p>
                  <p className="text-xs font-mono text-text-muted truncate">{model.provider}/{model.model}</p>
                  <p className="text-xs text-text-muted mt-1">
                    Resolved: {formatTokens(model.caps?.contextWindow || 0)} context / {formatTokens(model.caps?.maxOutput || 0)} output
                    {overridden ? " · overridden" : ""}
                  </p>
                </div>
                <Input
                  label="Context window"
                  type="number"
                  min="1"
                  step="1"
                  value={draft.contextWindow}
                  onChange={(event) => updateDraft(model, "contextWindow", event.target.value)}
                />
                <Input
                  label="Maximum output"
                  type="number"
                  min="1"
                  step="1"
                  value={draft.maxOutput}
                  onChange={(event) => updateDraft(model, "maxOutput", event.target.value)}
                />
                <div className="flex gap-2">
                  {overridden && (
                    <Button variant="ghost" size="sm" onClick={() => reset(model)} disabled={saving === key}>
                      Reset
                    </Button>
                  )}
                  <Button size="sm" onClick={() => save(model)} loading={saving === key} disabled={saving === key}>
                    Save
                  </Button>
                </div>
              </div>
            </Card>
          );
        })}
        {filteredModels.length === 0 && (
          <Card padding="lg" className="text-center text-sm text-text-muted">No models found.</Card>
        )}
      </div>
    </div>
  );
}
