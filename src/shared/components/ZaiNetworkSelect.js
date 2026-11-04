"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";

export default function ZaiNetworkSelect({ value, onChange, disabled = false, onboarding = false }) {
  const [pools, setPools] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/proxy-pools?isActive=true&metadataOnly=true", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error("Could not load proxy pools");
        setPools((data.proxyPools || []).filter((pool) => !pool.type || pool.type === "http"));
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, []);

  return (
    <div className="space-y-1">
      <label className="block text-xs text-text-muted">
        {onboarding ? "OAuth and Start Plan network" : "Plan Management network"}
        <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}
          className="mt-1 block w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary disabled:opacity-50">
          <option value="account">{onboarding ? "Server default (environment proxy or direct)" : "Use each account’s proxy / server default"}</option>
          <option value="direct">Direct — server IP, bypass environment proxy</option>
          {pools.map((pool) => <option key={pool.id} value={pool.id}>Proxy pool: {pool.name}</option>)}
        </select>
      </label>
      <p className="text-xs text-text-muted">
        {onboarding
          ? "Selected pool covers server-side OAuth, credential exchange and optional Start Plan preparation, then is assigned to the saved account. The authorization browser uses its own network."
          : "Applies to checks, Add Start Plan and claims in this dialog only; does not change the saved account proxy or inference route."}
        {" "}HTTP(S) proxies only. Selected proxies never fall back to direct.
      </p>
      {value === "direct" && <p className="text-xs text-warning">Direct access exposes the server’s public IP to Z.AI. This is an explicit override, not an automatic retry.{onboarding && " Saved for Plan Management only; inference keeps its existing default network policy."}</p>}
      {error && <p className="text-xs text-warning">{error}. No proxy was selected automatically.</p>}
    </div>
  );
}

ZaiNetworkSelect.propTypes = {
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
  onboarding: PropTypes.bool,
};
