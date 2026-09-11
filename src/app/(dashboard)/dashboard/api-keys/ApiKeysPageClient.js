"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Toggle } from "@/shared/components";
import StatusAlert from "../endpoint/components/StatusAlert";
import Tooltip from "../endpoint/components/Tooltip";
import ApiKeyPolicyEditor from "./ApiKeyPolicyEditor";

const ACTIVE_CLASS = "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-700 dark:text-green-400";
const PAUSED_CLASS = "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-700 dark:text-yellow-400";

/**
 * Dedicated API Keys management page.
 * Metadata-only reads; one-time secret on create/reroll; per-key model/combo policy.
 */
export default function ApiKeysPageClient() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [oneTimeSecret, setOneTimeSecret] = useState(null);
  const [visibleSecrets, setVisibleSecrets] = useState(new Set());

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", accessMode: "all", targets: [] });
  const [creating, setCreating] = useState(false);

  const [policyKey, setPolicyKey] = useState(null);
  const [policyForm, setPolicyForm] = useState({ name: "", isActive: true, accessMode: "all", targets: [] });
  const [savingPolicy, setSavingPolicy] = useState(false);

  const [requireApiKey, setRequireApiKey] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(true);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/keys");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setKeys(data.keys || []);
    } catch (e) {
      setError(`Failed to load API keys: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load: loading already true; avoid sync setState-in-effect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [keysRes, settingsRes] = await Promise.all([
          fetch("/api/keys"),
          fetch("/api/settings"),
        ]);
        if (!keysRes.ok) throw new Error(`HTTP ${keysRes.status}`);
        const data = await keysRes.json();
        if (!cancelled) setKeys(data.keys || []);
        if (settingsRes.ok) {
          const settings = await settingsRes.json();
          if (!cancelled) setRequireApiKey(settings.requireApiKey || false);
        }
      } catch (e) {
        if (!cancelled) setError(`Failed to load API keys: ${e.message}`);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setSettingsLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleRequireApiKey = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireApiKey: value }),
      });
      if (res.ok) setRequireApiKey(value);
      else setStatus({ type: "error", message: `Failed to update require API key: HTTP ${res.status}` });
    } catch (e) {
      setStatus({ type: "error", message: `Failed to update require API key: ${e.message}` });
    }
  };

  const activeCount = useMemo(() => keys.filter((k) => k.isActive).length, [keys]);
  const pausedCount = keys.length - activeCount;

  const copySecret = async (secret, id) => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      setStatus({ type: "error", message: "Copy failed — select and copy manually." });
    }
  };

  const toggleSecretVisibility = (id) => {
    setVisibleSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!createForm.name.trim()) {
      setStatus({ type: "error", message: "Name is required" });
      return;
    }
    setCreating(true);
    setStatus(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createForm.name.trim(),
          accessMode: createForm.accessMode,
          targets: createForm.accessMode === "restricted" ? createForm.targets : [],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setOneTimeSecret(data.secret || data.key);
      setCreateOpen(false);
      setCreateForm({ name: "", accessMode: "all", targets: [] });
      await loadKeys();
    } catch (e2) {
      setStatus({ type: "error", message: `Create failed: ${e2.message}` });
    } finally {
      setCreating(false);
    }
  };

  const handleTogglePause = async (key) => {
    try {
      const res = await fetch(`/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !key.isActive }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadKeys();
      setStatus({
        type: "success",
        message: key.isActive
          ? `"${key.name}" paused. Existing sessions using this key will be rejected.`
          : `"${key.name}" is active again.`,
      });
    } catch (e) {
      setStatus({ type: "error", message: `Update failed: ${e.message}` });
    }
  };

  const openPolicyEditor = async (key) => {
    setPolicyKey(key);
    setPolicyForm({
      name: key.name || "",
      isActive: key.isActive !== false,
      accessMode: key.accessMode || "all",
      targets: key.targets || [],
    });
  };

  const handleSavePolicy = async (e) => {
    e.preventDefault();
    if (!policyKey) return;
    setSavingPolicy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/keys/${policyKey.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: policyForm.name,
          isActive: policyForm.isActive,
          accessMode: policyForm.accessMode,
          targets: policyForm.accessMode === "restricted" ? policyForm.targets : [],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setPolicyKey(null);
      await loadKeys();
      setStatus({ type: "success", message: "Key policy updated." });
    } catch (e2) {
      setStatus({ type: "error", message: `Save failed: ${e2.message}` });
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleDelete = async (key) => {
    if (!window.confirm(`Delete API key "${key.name}"? Historical usage is kept.`)) return;
    try {
      const res = await fetch(`/api/keys/${key.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadKeys();
      setStatus({ type: "success", message: `"${key.name}" deleted.` });
    } catch (e) {
      setStatus({ type: "error", message: `Delete failed: ${e.message}` });
    }
  };

  const handleReroll = async (key) => {
    if (!window.confirm(`Reroll secret for "${key.name}"? The old secret stops working immediately.`)) return;
    try {
      const res = await fetch(`/api/keys/${key.id}/reroll`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setOneTimeSecret(data.secret || data.key);
      await loadKeys();
    } catch (e) {
      setStatus({ type: "error", message: `Reroll failed: ${e.message}` });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-text-main">API Keys</h1>
          <p className="text-text-muted text-sm mt-1">
            Create dedicated keys with per-key model/combo access. Secrets are shown once at create/reroll.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium"
        >
          Create API Key
        </button>
      </div>

      {status && (
        <StatusAlert
          status={status}
          className="cursor-pointer"
        />
      )}
      {error && !status && <StatusAlert status={{ type: "error", message: error }} />}

      <div className="border border-border rounded-xl p-4 bg-surface/50">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="font-medium text-text-main">Require API key</p>
            <p className="text-sm text-text-muted">
              Requests without a valid key will be rejected
            </p>
          </div>
          <Toggle
            checked={requireApiKey}
            onChange={() => handleRequireApiKey(!requireApiKey)}
            disabled={settingsLoading}
          />
        </div>
        {!requireApiKey && !settingsLoading && (
          <div className="mt-3">
            <StatusAlert
              status={{
                type: "warning",
                message: "Require API key is disabled — clients can reach the gateway without a key.",
              }}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 text-sm text-text-muted flex-wrap">
        <span>
          <strong className="text-text-main">{activeCount}</strong> active
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <strong className="text-text-main">{pausedCount}</strong> paused
        </span>
        <Tooltip text="Paused keys are rejected at request time. Default (All) keys expose every current and future model/combo; restricted keys only expose selected ones." />
      </div>

      {loading ? (
        <p className="text-text-muted text-sm">Loading keys…</p>
      ) : keys.length === 0 ? (
        <div className="border border-border rounded-xl p-8 text-center">
          <p className="text-text-main font-medium mb-1">No API keys yet</p>
          <p className="text-text-muted text-sm mb-4">
            Create a key to call the gateway from CLI tools, scripts, or third-party apps.
          </p>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium"
          >
            Create your first key
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {keys.map((key) => {
            const isActive = key.isActive !== false;
            const targets = key.targets || [];
            const targetSummary = (key.accessMode || "all") === "all"
              ? "Default — all models & combos"
              : targets.length === 0
                ? "Restricted — deny-all (nothing selected)"
                : `Restricted — ${targets.filter((t) => t.targetType === "model").length} models, ${targets.filter((t) => t.targetType === "combo").length} combos`;
            return (
              <div key={key.id} className="border border-border rounded-xl p-4 space-y-2 bg-surface/50">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-text-main break-all">{key.name}</span>
                      <span className={isActive ? ACTIVE_CLASS : PAUSED_CLASS}>
                        {isActive ? "Active" : "Paused"}
                      </span>
                    </div>
                    <p className="text-text-muted text-xs mt-1 font-mono break-all">
                      {key.keyHint}
                    </p>
                    <p className="text-text-muted text-xs mt-0.5">{targetSummary}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Tooltip text="Copy does not apply — secret is only shown at create/reroll. Use reroll to mint a new secret." />
                    <button
                      type="button"
                      onClick={() => openPolicyEditor(key)}
                      className="px-2 py-1 rounded text-xs hover:bg-surface text-text-muted hover:text-text-main"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleReroll(key)}
                      className="px-2 py-1 rounded text-xs hover:bg-surface text-text-muted hover:text-text-main"
                    >
                      Reroll
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTogglePause(key)}
                      className="px-2 py-1 rounded text-xs hover:bg-surface text-text-muted hover:text-text-main"
                    >
                      {isActive ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(key)}
                      className="px-2 py-1 rounded text-xs hover:bg-red-500/10 text-red-500"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {(key.targets || []).length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {key.targets.map((t) => (
                      <span
                        key={`${t.targetType}:${t.targetId}`}
                        className="inline-flex items-center px-2 py-0.5 rounded bg-surface text-xs font-mono text-text-muted"
                      >
                        {t.targetType === "combo" ? "combo:" : ""}{t.targetId}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* One-time secret modal */}
      {oneTimeSecret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <div className="bg-surface border border-border rounded-xl p-5 max-w-lg w-full space-y-4">
            <h2 className="text-lg font-semibold text-text-main">API Key Created</h2>
            <StatusAlert
              status={{
                type: "warning",
                message: "Copy this key now. It is shown once and cannot be retrieved later. Reroll to mint a new secret.",
              }}
            />
            <div className="flex items-center gap-2">
              <code className="flex-1 p-2 rounded bg-surface border border-border text-xs break-all select-all">
                {visibleSecrets.has(oneTimeSecret) ? oneTimeSecret : "•".repeat(Math.min(oneTimeSecret.length, 48))}
              </code>
              <button
                type="button"
                onClick={() => toggleSecretVisibility(oneTimeSecret)}
                className="px-2 py-2 rounded hover:bg-surface text-text-muted"
                aria-label="Toggle visibility"
              >
                <span className="material-symbols-outlined text-[18px]">
                  {visibleSecrets.has(oneTimeSecret) ? "visibility_off" : "visibility"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => copySecret(oneTimeSecret, oneTimeSecret)}
                className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm"
              >
                {copiedId === oneTimeSecret ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setOneTimeSecret(null);
                  setVisibleSecrets(new Set());
                }}
                className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-surface"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <form onSubmit={handleCreate} className="bg-surface border border-border rounded-xl p-5 max-w-2xl w-full space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-text-main">Create API Key</h2>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1" htmlFor="ak-name">Name</label>
              <input
                id="ak-name"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. CI deploy key"
                required
              />
            </div>
            <div>
              <div className="text-sm font-medium text-text-main mb-1">Access</div>
              <label className="flex items-center gap-2 text-sm mb-1">
                <input
                  type="radio"
                  name="ak-access"
                  checked={createForm.accessMode === "all"}
                  onChange={() => setCreateForm((f) => ({ ...f, accessMode: "all" }))}
                />
                Default — all models & combos (recommended for local/CLI)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="ak-access"
                  checked={createForm.accessMode === "restricted"}
                  onChange={() => setCreateForm((f) => ({ ...f, accessMode: "restricted" }))}
                />
                Restricted — only selected models & combos
              </label>
            </div>
            <ApiKeyPolicyEditor
              accessMode={createForm.accessMode}
              targets={createForm.targets}
              onChange={(accessMode, targets) =>
                setCreateForm((f) => ({ ...f, accessMode, targets }))
              }
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-surface"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Policy editor modal */}
      {policyKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <form onSubmit={handleSavePolicy} className="bg-surface border border-border rounded-xl p-5 max-w-2xl w-full space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-text-main">Edit API Key</h2>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1" htmlFor="ak-edit-name">Name</label>
              <input
                id="ak-edit-name"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                value={policyForm.name}
                onChange={(e) => setPolicyForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </div>
            <div>
              <div className="text-sm font-medium text-text-main mb-1">Access</div>
              <label className="flex items-center gap-2 text-sm mb-1">
                <input
                  type="radio"
                  name="ak-edit-access"
                  checked={policyForm.accessMode === "all"}
                  onChange={() => setPolicyForm((f) => ({ ...f, accessMode: "all" }))}
                />
                Default — all models & combos
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="ak-edit-access"
                  checked={policyForm.accessMode === "restricted"}
                  onChange={() => setPolicyForm((f) => ({ ...f, accessMode: "restricted" }))}
                />
                Restricted — only selected
              </label>
            </div>
            <ApiKeyPolicyEditor
              accessMode={policyForm.accessMode}
              targets={policyForm.targets}
              onChange={(accessMode, targets) =>
                setPolicyForm((f) => ({ ...f, accessMode, targets }))
              }
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPolicyKey(null)}
                className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-surface"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingPolicy}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50"
              >
                {savingPolicy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
