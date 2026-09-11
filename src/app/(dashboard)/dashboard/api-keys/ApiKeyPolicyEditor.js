"use client";

import { useEffect, useMemo, useState } from "react";
import StatusAlert from "../endpoint/components/StatusAlert";
import Tooltip from "../endpoint/components/Tooltip";

/**
 * Model/combo multi-select for a restricted API key.
 * Default (All) = empty selection → key exposes every current/future model & combo.
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

  const selectedCount = selectedModels.size + selectedCombos.size;

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
        <div className="mt-3 space-y-4">
          <div>
            <div className="text-sm font-medium text-text-main mb-1">
              Models
              <span className="ml-1 text-text-muted text-xs">({selectedModels.size} selected)</span>
            </div>
            <div className="border border-border rounded-lg max-h-48 overflow-y-auto p-2 space-y-1">
              {options.models.length === 0 ? (
                <p className="text-text-muted text-xs">No models available.</p>
              ) : (
                options.models.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      className="accent-blue-600"
                      disabled={disabled}
                      checked={selectedModels.has(m.id)}
                      onChange={(e) => toggle(setSelectedModels, m.id, e.target.checked)}
                    />
                    <span className="font-mono text-xs break-all">{m.id}</span>
                    {m.owned_by && (
                      <span className="text-text-muted text-xs ml-auto shrink-0">{m.owned_by}</span>
                    )}
                  </label>
                ))
              )}
            </div>
          </div>
          <div>
            <div className="text-sm font-medium text-text-main mb-1">
              Combos
              <span className="ml-1 text-text-muted text-xs">({selectedCombos.size} selected)</span>
            </div>
            <div className="border border-border rounded-lg max-h-40 overflow-y-auto p-2 space-y-1">
              {options.combos.length === 0 ? (
                <p className="text-text-muted text-xs">No combos yet. Combo members are reachable only via the combo itself.</p>
              ) : (
                options.combos.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      className="accent-blue-600"
                      disabled={disabled}
                      checked={selectedCombos.has(c.name)}
                      onChange={(e) => toggle(setSelectedCombos, c.name, e.target.checked)}
                    />
                    <span className="font-medium">{c.name}</span>
                    <span className="text-text-muted text-xs">{c.models?.length || 0} models</span>
                  </label>
                ))
              )}
            </div>
          </div>
          {selectedCount === 0 && (
            <StatusAlert status={{ type: "warning", message: "No models or combos selected — this key is deny-all until you pick something." }} />
          )}
        </div>
      )}
    </div>
  );
}
