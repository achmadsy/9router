"use client";

import { useEffect, useMemo, useState } from "react";
import StatusAlert from "../endpoint/components/StatusAlert";
import Tooltip from "../endpoint/components/Tooltip";

/**
 * Model/combo multi-select for a restricted API key.
 * Default (All) = empty selection → key exposes every current/future model & combo.
 * Models + combos are one searchable list (combos were previously double-listed
 * because buildModelsList embeds combos as models with owned_by: "combo").
 */
export default function ApiKeyPolicyEditor({
  accessMode = "all",
  targets = [],
  onChange,
  disabled = false,
  className = "",
}) {
  const [options, setOptions] = useState(null);
  const [error, setError] = useState("");
  const [selectedModels, setSelectedModels] = useState(
    () => new Set(targets.filter((t) => t.targetType === "model").map((t) => t.targetId))
  );
  const [selectedCombos, setSelectedCombos] = useState(
    () => new Set(targets.filter((t) => t.targetType === "combo").map((t) => t.targetId))
  );
  const [query, setQuery] = useState("");

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch("/api/keys/access-options");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!ignore) setOptions({ models: data.models || [], combos: data.combos || [] });
      } catch (e) {
        if (!ignore) setError(`Failed to load access options: ${e.message}`);
      }
    })();
    return () => { ignore = true; };
  }, []);

  useEffect(() => {
    const next = [
      ...[...selectedModels].map((id) => ({ targetType: "model", targetId: id })),
      ...[...selectedCombos].map((id) => ({ targetType: "combo", targetId: id })),
    ];
    onChange?.(accessMode, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModels, selectedCombos, accessMode]);

  const toggle = (setFn, id, checked) => {
    setFn((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  // Combos already appear inside the models catalog (owned_by: "combo").
  // Prefer the richer combo rows and drop those duplicates from model options.
  const comboOptions = useMemo(() => {
    if (!options) return [];
    return (options.combos || []).map((c) => ({
      type: "combo",
      id: c.name || c.id,
      label: c.name || c.id,
      meta: c.models?.length ? `${c.models.length} models` : null,
    }));
  }, [options]);

  const modelOptions = useMemo(() => {
    if (!options) return [];
    const comboIds = new Set(comboOptions.map((c) => c.id));
    return (options.models || [])
      .filter((m) => m.owned_by !== "combo" && !comboIds.has(m.id))
      .map((m) => ({
        type: "model",
        id: m.id,
        label: m.id,
        meta: m.owned_by || null,
      }));
  }, [options, comboOptions]);

  const filteredItems = useMemo(() => {
    const all = [...comboOptions, ...modelOptions].sort((a, b) => a.label.localeCompare(b.label));
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        (i.meta && String(i.meta).toLowerCase().includes(q))
    );
  }, [comboOptions, modelOptions, query]);

  const selectedCount = selectedModels.size + selectedCombos.size;
  const totalOptions = comboOptions.length + modelOptions.length;

  const isChecked = (item) =>
    item.type === "model" ? selectedModels.has(item.id) : selectedCombos.has(item.id);

  const handleCheck = (item, checked) => {
    if (item.type === "model") toggle(setSelectedModels, item.id, checked);
    else toggle(setSelectedCombos, item.id, checked);
  };

  if (options === null) {
    return (
      <div className={`py-4 ${className}`}>
        {error ? (
          <StatusAlert status={{ type: "error", message: error }} />
        ) : (
          <p className="text-text-muted text-sm">Loading access options…</p>
        )}
      </div>
    );
  }

  return (
    <div className={className}>
      <StatusAlert status={{ type: "info", message: "Default exposes every current and future model/combo. Restricted keys only see selected items." }} />
      {accessMode === "restricted" && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm font-medium text-text-main">
              Models &amp; combos
              <span className="ml-1 text-text-muted text-xs">
                ({selectedCount} selected · {totalOptions} available)
              </span>
            </div>
            <Tooltip text="One searchable list. Combos appear once (badge); member models stay individually selectable for direct calls." />
          </div>
          <input
            type="search"
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            placeholder="Search models & combos…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={disabled}
            aria-label="Search models and combos"
          />
          <div className="border border-border rounded-lg max-h-56 overflow-y-auto p-2 space-y-0.5">
            {filteredItems.length === 0 ? (
              <p className="text-text-muted text-xs py-2">
                No matches. {totalOptions === 0 ? "No models or combos available yet." : "Try a different search."}
              </p>
            ) : (
              filteredItems.map((item) => (
                <label
                  key={`${item.type}:${item.id}`}
                  className="flex items-center gap-2 text-sm cursor-pointer rounded px-1 py-0.5 hover:bg-surface/60"
                >
                  <input
                    type="checkbox"
                    className="accent-blue-600"
                    disabled={disabled}
                    checked={isChecked(item)}
                    onChange={(e) => handleCheck(item, e.target.checked)}
                  />
                  {item.type === "combo" && (
                    <span className="inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold uppercase tracking-wide bg-purple-500/15 text-purple-600 dark:text-purple-400 shrink-0">
                      combo
                    </span>
                  )}
                  <span
                    className={
                      item.type === "combo"
                        ? "font-medium text-xs break-all"
                        : "font-mono text-xs break-all"
                    }
                  >
                    {item.label}
                  </span>
                  {item.meta && (
                    <span className="text-text-muted text-xs ml-auto shrink-0">{item.meta}</span>
                  )}
                </label>
              ))
            )}
          </div>
          {selectedCount === 0 && (
            <StatusAlert status={{ type: "warning", message: "No models or combos selected — this key is deny-all until you pick something." }} />
          )}
        </div>
      )}
    </div>
  );
}
