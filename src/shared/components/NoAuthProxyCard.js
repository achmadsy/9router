"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [rotatePoolIds, setRotatePoolIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      const pools = poolData.proxyPools || [];
      setProxyPools(pools);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setRotateStrategy(override.rotateStrategy || "none");
      const savedIds = Array.isArray(override.rotatePoolIds)
        ? override.rotatePoolIds.filter((id) => pools.some((p) => p.id === id))
        : [];
      setRotatePoolIds(savedIds.length > 0 ? savedIds : pools.map((p) => p.id));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const save = useCallback(async (poolId, strategy, nextRotatePoolIds) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = poolId;
      if (strategy === "none") {
        delete override.rotateStrategy;
        delete override.rotatePoolIds;
      } else {
        override.rotateStrategy = strategy;
        if (Array.isArray(nextRotatePoolIds) && nextRotatePoolIds.length > 0) {
          override.rotatePoolIds = nextRotatePoolIds;
        } else {
          delete override.rotatePoolIds;
        }
      }
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxy config error:", e);
    } finally {
      setSaving(false);
    }
  }, [providerId]);

  const handlePoolChange = (newPoolId) => {
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy, rotatePoolIds);
  };

  const handleStrategyChange = (newStrategy) => {
    setRotateStrategy(newStrategy);
    save(proxyPoolId, newStrategy, rotatePoolIds);
  };

  const toggleRotatePool = (poolId) => {
    const next = rotatePoolIds.includes(poolId)
      ? rotatePoolIds.filter((id) => id !== poolId)
      : [...rotatePoolIds, poolId];
    // Keep pool-list order stable for round-robin
    const ordered = proxyPools.map((p) => p.id).filter((id) => next.includes(id));
    setRotatePoolIds(ordered);
    save(proxyPoolId, rotateStrategy, ordered);
  };

  const canRotate = proxyPools.length >= 2;
  const isRotation = rotateStrategy !== "none";
  const selectedRotatePoolCount = rotatePoolIds.length;

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <Select
        label="Proxy Pool"
        value={proxyPoolId}
        onChange={(e) => handlePoolChange(e.target.value)}
        disabled={saving || isRotation}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
        hint={isRotation ? "Pool selector is ignored when rotation is active — selected pools below are used." : undefined}
      />

      <div className="flex flex-col gap-2 mt-4">
        <label className="text-sm font-medium text-text-main">Rotation Strategy</label>
        <select
          value={rotateStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
          disabled={saving}
          className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
        >
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value} disabled={s.value !== "none" && !canRotate}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">
          {!canRotate
            ? `Need at least 2 active proxy pools for rotation.`
            : isRotation
              ? rotateStrategy === "round-robin"
                ? `Rotating through ${selectedRotatePoolCount} selected pool(s) in list order. Position is saved and survives restarts.`
                : `Picking a random pool from ${selectedRotatePoolCount} selected pool(s) each request.`
              : `Uses the selected pool above. Set to Round-robin or Random to rotate across selected pools.`}
        </p>
      </div>

      {isRotation && proxyPools.length > 0 && (
        <div className="flex flex-col gap-2 mt-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-text-main">Rotation Pools</label>
            <span className="text-xs text-text-muted">{selectedRotatePoolCount}/{proxyPools.length} selected</span>
          </div>
          <div className="flex flex-col gap-1 max-h-[180px] overflow-y-auto pr-1">
            {proxyPools.map((pool) => (
              <label
                key={pool.id}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-main hover:bg-black/[0.03] dark:hover:bg-white/[0.03] cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={rotatePoolIds.includes(pool.id)}
                  onChange={() => toggleRotatePool(pool.id)}
                  disabled={saving}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <span className="truncate">{pool.name}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-text-muted">
            Unchecked pools are ignored for rotation. Order follows the pool list (newest first).
          </p>
        </div>
      )}
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
