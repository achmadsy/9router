"use client";

import { useState, useEffect, useCallback } from "react";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import CooldownTimer from "@/shared/components/CooldownTimer";

const UNITS = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 24 * 3600 * 1000 };

function parseDuration(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * (UNITS[unit] || 1000));
}

function formatRemaining(expiresAtMs) {
  const diff = expiresAtMs - Date.now();
  if (diff <= 0) return "expired";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function sourceBadge(source) {
  const map = {
    "upstream-header": { label: "Upstream", cls: "bg-blue-500/20 text-blue-400" },
    "manual-policy": { label: "Manual", cls: "bg-purple-500/20 text-purple-400" },
    "provider-reset": { label: "Provider", cls: "bg-cyan-500/20 text-cyan-400" },
    "legacy-backoff": { label: "Auto", cls: "bg-gray-500/20 text-gray-300" },
    "antigravity-quota": { label: "Quota", cls: "bg-amber-500/20 text-amber-400" },
    "antigravity-strike": { label: "Strike", cls: "bg-red-500/20 text-red-400" },
  };
  const b = map[source] || { label: source || "—", cls: "bg-gray-500/20 text-gray-300" };
  return <span className={`px-1.5 py-0.5 rounded text-xs ${b.cls}`}>{b.label}</span>;
}

export default function SelfAwarePage() {
  const [tab, setTab] = useState("board"); // board | policies
  // Lazy initializer — Date.now() must not run during render body on every pass
  const [now, setNow] = useState(() => Date.now());

  // Board state
  const [cooldowns, setCooldowns] = useState([]);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState(null);
  const [pendingReset, setPendingReset] = useState(null);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [resetAllPending, setResetAllPending] = useState(false);

  // Policies state
  const [policies, setPolicies] = useState([]);
  const [polLoading, setPolLoading] = useState(false);
  const [polError, setPolError] = useState(null);
  const [form, setForm] = useState({ provider: "", model: "", value: "60", unit: "s" });
  const [formMsg, setFormMsg] = useState(null);

  // Session cookie auth — dashboardGuard middleware validates the cookie;
  // same plain-fetch pattern as the rest of the dashboard pages.
  const loadCooldowns = useCallback(async ({ background = false } = {}) => {
    if (!background) setBoardLoading(true);
    try {
      const res = await fetch("/api/self-aware", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCooldowns(data.cooldowns || []);
      setBoardError(null);
    } catch (e) {
      setBoardError(e.message || "Failed to load cooldowns");
    } finally {
      if (!background) setBoardLoading(false);
    }
  }, []);

  const loadPolicies = useCallback(async () => {
    setPolLoading(true);
    try {
      const res = await fetch("/api/self-aware/policies", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPolicies(data.policies || []);
      setPolError(null);
    } catch (e) {
      setPolError(e.message || "Failed to load policies");
    } finally {
      setPolLoading(false);
    }
  }, []);

  // Initial + tab-scoped load. Loading flags flip inside the async fns after
  // the first await (network), not synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (tab === "board") {
        try {
          const res = await fetch("/api/self-aware", { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!cancelled) {
            setCooldowns(data.cooldowns || []);
            setBoardError(null);
          }
        } catch (e) {
          if (!cancelled) setBoardError(e.message || "Failed to load cooldowns");
        }
      } else {
        try {
          const res = await fetch("/api/self-aware/policies", { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!cancelled) {
            setPolicies(data.policies || []);
            setPolError(null);
          }
        } catch (e) {
          if (!cancelled) setPolError(e.message || "Failed to load policies");
        }
      }
    };
    run();
    return () => { cancelled = true; };
  }, [tab]);

  // Poll every 5s while visible; pause when hidden, refresh on visible
  useEffect(() => {
    if (tab !== "board") return undefined;
    const poll = () => {
      if (document.visibilityState === "visible") loadCooldowns({ background: true });
    };
    const id = setInterval(poll, 5000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [tab, loadCooldowns]);

  // Local 1s clock for countdowns + prune locally expired
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      setCooldowns((prev) => prev.filter((c) => {
        const exp = c.expiresAtMs || new Date(c.expiresAt).getTime();
        return exp > Date.now() - 5000; // keep briefly past expiry; poll reconciles
      }));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const handleResetOne = async (row) => {
    if (pendingReset) return;
    setPendingReset(row.id || `${row.provider}|${row.model}|${row.scopeType}|${row.scopeId}`);
    try {
      const res = await fetch("/api/self-aware/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          row.id
            ? { id: row.id }
            : { provider: row.provider, model: row.model, scopeType: row.scopeType, scopeId: row.scopeId }
        ),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCooldowns((prev) => prev.filter((c) => {
        if (row.id) return c.id !== row.id;
        return !(c.provider === row.provider && c.model === row.model &&
          c.scopeType === row.scopeType && c.scopeId === row.scopeId);
      }));
    } catch {
      // keep row; poll will reconcile
    } finally {
      setPendingReset(null);
    }
  };

  const handleResetAll = async () => {
    if (resetAllPending) return;
    setResetAllPending(true);
    try {
      const res = await fetch("/api/self-aware/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCooldowns([]);
      setConfirmResetAll(false);
    } catch {
      // ignore — next poll reconciles
    } finally {
      setResetAllPending(false);
    }
  };

  const handleSavePolicy = async (e) => {
    e.preventDefault();
    setFormMsg(null);
    const timeoutMs = parseDuration(form.value, form.unit);
    if (!form.provider) {
      setFormMsg("Provider is required");
      return;
    }
    if (timeoutMs == null) {
      setFormMsg("Enter a valid duration");
      return;
    }
    try {
      const res = await fetch("/api/self-aware/policies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: form.provider,
          model: form.model.trim(),
          timeoutMs,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setFormMsg({ ok: true, text: "Saved" });
      loadPolicies();
    } catch (err) {
      setFormMsg({ ok: false, text: err.message });
    }
  };

  const handleDeletePolicy = async (provider, model) => {
    try {
      const qs = new URLSearchParams({ provider, model });
      await fetch(`/api/self-aware/policies?${qs}`, { method: "DELETE" });
      loadPolicies();
    } catch {
      // ignore
    }
  };

  const providerLabel = (id) => AI_PROVIDERS[id]?.displayName || id;
  const activeCount = cooldowns.filter((c) => (c.expiresAtMs || new Date(c.expiresAt).getTime()) > now).length;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Self-Aware</h1>
          <p className="text-sm text-gray-400 mt-1">
            Upstream wait headers and manual wait settings. Existing automatic cooldown applies when neither is available.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setTab("board")}
            className={`px-3 py-1.5 rounded text-sm ${tab === "board" ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"}`}
          >
            Active cooldowns{tab === "board" && activeCount > 0 ? ` (${activeCount})` : ""}
          </button>
          <button
            onClick={() => setTab("policies")}
            className={`px-3 py-1.5 rounded text-sm ${tab === "policies" ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"}`}
          >
            Wait settings
          </button>
        </div>
      </div>

      {tab === "board" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-400">
              {boardLoading && cooldowns.length === 0 ? "Loading…" : `${cooldowns.length} active`}
            </span>
            <button
              onClick={() => (confirmResetAll ? handleResetAll() : setConfirmResetAll(true))}
              disabled={cooldowns.length === 0 || resetAllPending}
              className={`px-3 py-1.5 rounded text-sm border ${
                confirmResetAll
                  ? "border-red-500 bg-red-500/20 text-red-400"
                  : "border-white/10 text-gray-300 hover:text-white disabled:opacity-40"
              }`}
            >
              {confirmResetAll
                ? `Confirm reset all (${cooldowns.length})?`
                : resetAllPending
                  ? "Resetting…"
                  : "Reset All"}
            </button>
          </div>
          {confirmResetAll && (
            <div className="text-xs text-red-400">
              Clears {cooldowns.length} cooldown(s). Click again to confirm or{" "}
              <button className="underline" onClick={() => setConfirmResetAll(false)}>cancel</button>.
            </div>
          )}
          {boardError && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded p-3">
              {boardError}
            </div>
          )}
          {!boardError && cooldowns.length === 0 && !boardLoading && (
            <div className="text-sm text-gray-500 bg-white/5 rounded p-6 text-center">
              No active cooldowns
            </div>
          )}
          {cooldowns.length > 0 && (
            <div className="overflow-x-auto rounded border border-white/10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-white/10">
                    <th className="px-3 py-2">Provider</th>
                    <th className="px-3 py-2">Model</th>
                    <th className="px-3 py-2">Scope</th>
                    <th className="px-3 py-2">Source</th>
                    <th className="px-3 py-2">Status / reason</th>
                    <th className="px-3 py-2">Blocked until</th>
                    <th className="px-3 py-2">Remaining</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {cooldowns.map((c) => {
                    const expMs = c.expiresAtMs || new Date(c.expiresAt).getTime();
                    const key = c.id || `${c.provider}|${c.model}|${c.scopeType}|${c.scopeId}`;
                    const isPending = pendingReset === key;
                    return (
                      <tr key={key} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="px-3 py-2 text-white">{providerLabel(c.provider)}</td>
                        <td className="px-3 py-2 text-gray-300 font-mono text-xs">{c.model || "all"}</td>
                        <td className="px-3 py-2 text-gray-400 text-xs">
                          {c.scopeType === "proxy" ? (
                            <span title={c.scopeId}>
                              {c.proxyPoolName || (c.proxyPoolDeleted ? "Deleted proxy pool" : c.scopeId)}
                              {c.scopeId !== "direct" && (
                                <span className="ml-1 text-gray-500">({c.scopeId === "direct" ? "direct" : c.scopeId.slice(0, 8)})</span>
                              )}
                            </span>
                          ) : c.scopeType === "account" ? (
                            c.connectionName || c.scopeId
                          ) : (
                            "provider"
                          )}
                        </td>
                        <td className="px-3 py-2">{sourceBadge(c.source)}</td>
                        <td className="px-3 py-2 text-gray-400 text-xs max-w-[200px] truncate" title={c.reason || ""}>
                          {c.status ? `[${c.status}] ` : ""}{c.reason || "—"}
                        </td>
                        <td className="px-3 py-2 text-gray-300 text-xs whitespace-nowrap">
                          {new Date(expMs).toLocaleTimeString()}
                        </td>
                        <td className="px-3 py-2">
                          <CooldownTimer until={new Date(expMs).toISOString()} />
                        </td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => handleResetOne(c)}
                            disabled={isPending}
                            className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40"
                          >
                            {isPending ? "…" : "Reset"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "policies" && (
        <div className="space-y-6">
          <div className="bg-white/5 border border-white/10 rounded p-4 text-sm text-gray-300">
            Set wait time per provider/model. On 429 responses, duration comes from:
            upstream wait headers first, then this manual setting, then existing automatic cooldown.
            Useful when no header is returned or the automatic cooldown is too short.
          </div>

          <form onSubmit={handleSavePolicy} className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-xs text-gray-400">Provider</span>
              <select
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value })}
                className="mt-1 block w-44 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
              >
                <option value="">Select provider…</option>
                {Object.entries(AI_PROVIDERS).map(([id, p]) => (
                  <option key={id} value={id}>{p.displayName || id}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Model (blank = all)</span>
              <input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="model id or leave blank"
                className="mt-1 block w-52 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Wait</span>
              <div className="mt-1 flex gap-1">
                <input
                  type="number"
                  min="1"
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                  className="w-20 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
                />
                <select
                  value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                  className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
                >
                  <option value="s">seconds</option>
                  <option value="m">minutes</option>
                  <option value="h">hours</option>
                  <option value="d">days</option>
                </select>
              </div>
            </label>
            <button
              type="submit"
              disabled={polLoading}
              className="px-4 py-1.5 bg-white/10 hover:bg-white/15 text-white text-sm rounded disabled:opacity-40"
            >
              Save
            </button>
            {formMsg && (
              <span className={`text-xs ${formMsg.ok ? "text-green-400" : "text-red-400"}`}>{formMsg.text}</span>
            )}
          </form>

          {polError && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded p-3">{polError}</div>
          )}
          {policies.length === 0 && !polLoading && (
            <div className="text-sm text-gray-500 bg-white/5 rounded p-6 text-center">No wait settings</div>
          )}
          {policies.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-white/10">
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2">Model</th>
                  <th className="px-3 py-2">Wait</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={`${p.provider}|${p.model}`} className="border-b border-white/5">
                    <td className="px-3 py-2 text-white">{providerLabel(p.provider)}</td>
                    <td className="px-3 py-2 text-gray-300 font-mono text-xs">{p.model || "all"}</td>
                    <td className="px-3 py-2 text-gray-300">
                      {p.timeoutMs >= 86400000
                        ? `${Math.round(p.timeoutMs / 86400000)}d`
                        : p.timeoutMs >= 3600000
                          ? `${Math.round(p.timeoutMs / 3600000)}h`
                          : p.timeoutMs >= 60000
                            ? `${Math.round(p.timeoutMs / 60000)}m`
                            : `${Math.round(p.timeoutMs / 1000)}s`}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => handleDeletePolicy(p.provider, p.model)}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
