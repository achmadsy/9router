"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Card, Badge } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { diffProviderHeaderRows, mergeProviderHeaders } from "open-sse/utils/providerHeaderOverrides.js";

export default function CustomConfigCard({ providerId }) {
  const notify = useNotificationStore();
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState([{ name: "", value: "" }]);
  const [builtin, setBuiltin] = useState({});
  const [hasOverride, setHasOverride] = useState(false);
  const [profile, setProfile] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/providers/${providerId}/overrides`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        // Same case-insensitive replacement/deletion semantics as the executor.
        const builtinHeaders = data.builtinHeaders || {};
        const effective = mergeProviderHeaders(builtinHeaders, data.headers);
        const headerRows = Object.entries(effective).map(([name, value]) => ({ name, value }));
        setBuiltin(builtinHeaders);
        setRows(headerRows.length ? headerRows : [{ name: "", value: "" }]);
        setHasOverride(Object.keys(data.headers || {}).length > 0);
        setProfile(data.defaultProfile || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const setRow = (i, field, value) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  };

  const save = useCallback(async () => {
    // Missing defaults become null tombstones, not "inherit this header again".
    const { override, error } = diffProviderHeaderRows(builtin, rows);
    if (error) {
      notify.error(error);
      return;
    }
    const headers = override?.headers || {};

    setSaving(true);
    try {
      const res = await fetch(`/api/providers/${providerId}/overrides`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headers }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        notify.error(err.error || "Failed to save");
        return;
      }
      const saved = await res.json();
      const savedHeaders = saved.headers || {};
      const effective = mergeProviderHeaders(builtin, savedHeaders);
      const headerRows = Object.entries(effective).map(([name, value]) => ({ name, value }));
      setRows(headerRows.length ? headerRows : [{ name: "", value: "" }]);
      setHasOverride(Object.keys(savedHeaders).length > 0);
      notify.success("Custom headers saved");
    } catch {
      notify.error("Failed to save custom headers");
    } finally {
      setSaving(false);
    }
  }, [rows, builtin, providerId, notify]);

  const resetToBuiltin = () => {
    setRows(Object.entries(builtin).map(([name, value]) => ({ name, value })));
  };

  // Only render when there are defaults or saved edits (including deletions).
  if (Object.keys(builtin).length === 0 && !hasOverride) return null;

  return (
    <Card padding="xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[20px]">tune</span>
          <span className="text-sm font-semibold">Custom Headers</span>
          {hasOverride && (
            <Badge variant="success" size="sm">Active</Badge>
          )}
        </div>
        <span className="material-symbols-outlined text-text-muted">
          {expanded ? "expand_less" : "expand_more"}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-3 text-xs text-text-muted">
            {profile === "zcode-account-plan" && "Defaults below match ZCode account-plan inference. API-key connections use their own transport defaults. "}
            Delete + Save suppresses a header; Reset + Save restores current defaults. Authentication headers are managed automatically.
          </p>
          <div className="flex flex-col gap-2">
            {rows.map((row, i) => {
              const builtinName = Object.keys(builtin).find((name) => name.toLowerCase() === row.name.trim().toLowerCase());
              const overridden = builtinName !== undefined && row.value !== builtin[builtinName];
              return (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={row.name}
                    onChange={(e) => setRow(i, "name", e.target.value)}
                    placeholder="Header-Name"
                    spellCheck={false}
                    className="w-44 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
                  />
                  <input
                    value={row.value}
                    onChange={(e) => setRow(i, "value", e.target.value)}
                    placeholder="Value"
                    spellCheck={false}
                    title={overridden ? "Overridden" : builtinName !== undefined ? "Provider default" : ""}
                    className={`min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none ${
                      overridden ? "border-amber-400/60" : "border-border"
                    }`}
                  />
                  <button
                    type="button"
                    title="Remove header"
                    onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [{ name: "", value: "" }]))}
                    className="shrink-0 text-text-muted hover:text-red-500"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setRows((prev) => [...prev, { name: "", value: "" }])}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add header
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={resetToBuiltin}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-black/[0.03] dark:hover:bg-white/[0.03] disabled:opacity-50"
              >
                Reset
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={save}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

CustomConfigCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
