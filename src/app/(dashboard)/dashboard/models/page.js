"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, CardSkeleton, Input } from "@/shared/components";
import Pagination from "@/shared/components/Pagination";

const DEFAULT_PAGE_SIZE = 20;

function modelKey(provider, model) {
  return `${provider}|${model}`;
}

function formatTokens(value) {
  return Number(value).toLocaleString();
}

export default function ModelsPage() {
  const [models, setModels] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [pagination, setPagination] = useState({ page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (signal) => {
    try {
      setError("");
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (debouncedQuery) params.set("search", debouncedQuery);
      const response = await fetch(`/api/models?${params}`, { signal });
      if (!response.ok) throw new Error("Failed to load model metadata");
      const data = await response.json();
      setModels(data.models || []);
      setPagination(data.pagination || { page, pageSize, total: 0, totalPages: 1 });
      if (data.pagination?.page && data.pagination.page !== page) setPage(data.pagination.page);
    } catch (loadError) {
      if (loadError.name !== "AbortError") setError(loadError.message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [debouncedQuery, page, pageSize]);

  useEffect(() => {
    const controller = new AbortController();
    // Async loader owns state updates after network I/O.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const draftFor = (model) => {
    const key = modelKey(model.provider, model.model);
    if (drafts[key]) return drafts[key];
    return {
      contextWindow: String(model.caps?.contextWindow ?? ""),
      maxOutput: String(model.caps?.maxOutput ?? ""),
    };
  };

  const updateDraft = (model, field, value) => {
    const key = modelKey(model.provider, model.model);
    setDrafts((current) => ({ ...current, [key]: { ...draftFor(model), [field]: value } }));
  };

  const clearDraft = (key) => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
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
      clearDraft(key);
      await load();
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
      clearDraft(key);
      await load();
    } catch (resetError) {
      setError(resetError.message);
    } finally {
      setSaving(null);
    }
  };

  const handleSearchChange = (event) => {
    setQuery(event.target.value);
  };

  const handlePageSizeChange = (nextPageSize) => {
    setPageSize(nextPageSize);
    setPage(1);
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
            onChange={handleSearchChange}
            placeholder="Search provider or model"
            icon="search"
            className="w-full sm:w-80"
          />
        </div>
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      </Card>

      <div className="space-y-3">
        {models.map((model) => {
          const key = modelKey(model.provider, model.model);
          const draft = draftFor(model);
          return (
            <Card key={model.fullModel || key} padding="sm">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(220px,1fr)_180px_180px_auto] lg:items-end">
                <div className="min-w-0">
                  <p className="font-medium text-text-main truncate">{model.name || model.model}</p>
                  <p className="text-xs text-text-muted truncate">{model.providerName || model.provider}</p>
                  <p className="text-xs font-mono text-text-muted truncate">
                    {model.providerPrefix || model.provider}/{model.model}
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    Resolved: {formatTokens(model.caps?.contextWindow || 0)} context / {formatTokens(model.caps?.maxOutput || 0)} output
                    {model.overridden ? " · overridden" : ""}
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
                  {model.overridden && (
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
        {models.length === 0 && (
          <Card padding="lg" className="text-center text-sm text-text-muted">No models found.</Card>
        )}
      </div>

      <Pagination
        currentPage={pagination.page}
        pageSize={pagination.pageSize}
        totalItems={pagination.total}
        onPageChange={setPage}
        onPageSizeChange={handlePageSizeChange}
      />
    </div>
  );
}
