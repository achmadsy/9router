"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Badge, Button, Modal } from "@/shared/components";

function accountClaimableOffers(account) {
  return (account.offers || []).filter((offer) => offer.claimable);
}

function formatUnits(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat().format(value) : "—";
}

export default function ZaiPlanManagementModal({ isOpen, onClose, providerId }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [claimingKey, setClaimingKey] = useState("");
  const [results, setResults] = useState({});

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/providers/${encodeURIComponent(providerId)}/zai-plans`,
        { cache: "no-store" }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to retrieve account plans");
      setAccounts(data.accounts || []);
    } catch (loadError) {
      setError(loadError.message || "Failed to retrieve account plans");
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = setTimeout(() => {
      setResults({});
      loadAccounts();
    }, 0);
    return () => clearTimeout(timer);
  }, [isOpen, loadAccounts]);

  const planGroups = useMemo(() => {
    const groups = new Map();
    for (const account of accounts) {
      for (const offer of accountClaimableOffers(account)) {
        const group = groups.get(offer.planId) || { offer, connectionIds: [] };
        group.connectionIds.push(account.connectionId);
        groups.set(offer.planId, group);
      }
    }
    return [...groups.values()];
  }, [accounts]);

  const claim = async (connectionIds, planId, key) => {
    if (claimingKey) return;
    setClaimingKey(key);
    setError("");
    // API caps one batch at 50 connections; split larger groups client-side.
    const BATCH_SIZE = 50;
    try {
      for (let i = 0; i < connectionIds.length; i += BATCH_SIZE) {
        const response = await fetch(
          `/api/providers/${encodeURIComponent(providerId)}/zai-plans`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connectionIds: connectionIds.slice(i, i + BATCH_SIZE), planId }),
          }
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Plan claim failed");
        setResults((current) => {
          const next = { ...current };
          for (const result of data.results || []) next[result.connectionId] = result;
          return next;
        });
      }
      await loadAccounts();
    } catch (claimError) {
      setError(claimError.message || "Plan claim failed");
    } finally {
      setClaimingKey("");
    }
  };

  const handleClose = () => {
    if (claimingKey) return;
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Z.AI Plan Management">
      <div className="flex max-h-[75vh] flex-col gap-4 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-text-muted">
            Offers are retrieved independently for each OAuth account under this provider.
          </p>
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={loadAccounts}
            disabled={loading || !!claimingKey}
          >
            Refresh
          </Button>
        </div>

        {planGroups.length > 0 && (
          <div className="space-y-2 rounded-lg border border-border bg-surface-secondary p-3">
            <p className="text-xs font-medium text-text-primary">Bulk claim by offer</p>
            {planGroups.map(({ offer, connectionIds }) => (
              <div key={offer.planId} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text-primary">{offer.name}</p>
                  <p className="text-xs text-text-muted">
                    Offered to {connectionIds.length} account{connectionIds.length === 1 ? "" : "s"}
                  </p>
                </div>
                <Button
                  size="sm"
                  icon="redeem"
                  onClick={() => claim(connectionIds, offer.planId, `bulk:${offer.planId}`)}
                  disabled={!!claimingKey}
                >
                  {claimingKey === `bulk:${offer.planId}` ? "Claiming..." : "Claim All Eligible"}
                </Button>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-error/20 bg-error/10 p-3 text-sm text-error">
            {error}
          </div>
        )}

        <div className="space-y-3 overflow-y-auto pr-1">
          {loading && accounts.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted">Retrieving account plans...</p>
          ) : accounts.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted">No accounts found.</p>
          ) : accounts.map((account) => {
            const claimableOffers = accountClaimableOffers(account);
            const result = results[account.connectionId];
            return (
              <section key={account.connectionId} className="rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-text-primary">{account.name}</p>
                      <Badge variant={account.isActive ? "success" : "default"}>
                        {account.isActive ? "Active" : "Inactive"}
                      </Badge>
                      {!account.eligible && <Badge variant="warning">OAuth required</Badge>}
                    </div>
                    {account.email && <p className="truncate text-xs text-text-muted">{account.email}</p>}
                  </div>
                </div>

                {(account.activePlans || []).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {account.activePlans.map((plan) => (
                      <Badge key={plan.planId} variant={plan.status === "active" ? "success" : "default"}>
                        {plan.name}: {plan.status || "unknown"}
                      </Badge>
                    ))}
                  </div>
                )}

                {(account.balances || []).length > 0 && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {account.balances.map((balance, index) => (
                      <div key={`${balance.name}:${index}`} className="rounded bg-surface-secondary px-2 py-1.5 text-xs text-text-muted">
                        <span className="font-medium text-text-primary">{balance.name}</span>
                        {" · "}{formatUnits(balance.remaining)} / {formatUnits(balance.total)} remaining
                      </div>
                    ))}
                  </div>
                )}

                {claimableOffers.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {claimableOffers.map((offer) => {
                      const key = `${account.connectionId}:${offer.planId}`;
                      return (
                        <div key={offer.planId} className="flex items-center justify-between gap-3 rounded-lg bg-surface-secondary p-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-text-primary">{offer.name}</p>
                            <p className="text-xs text-text-muted">{offer.planId}</p>
                            {offer.description && <p className="text-xs text-text-muted">{offer.description}</p>}
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            icon="redeem"
                            onClick={() => claim([account.connectionId], offer.planId, key)}
                            disabled={!!claimingKey}
                          >
                            {claimingKey === key ? "Claiming..." : "Claim"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {account.eligible && claimableOffers.length === 0 && !account.error && (
                  <p className="mt-3 text-xs text-text-muted">No claimable offers for this account.</p>
                )}
                {account.error && <p className="mt-3 text-xs text-warning">{account.error}</p>}
                {result && (
                  <p className={`mt-3 text-xs ${result.ok ? "text-success" : "text-error"}`}>
                    {result.ok ? result.message : result.error}
                  </p>
                )}
              </section>
            );
          })}
        </div>

        <Button variant="secondary" onClick={handleClose} fullWidth disabled={!!claimingKey}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

ZaiPlanManagementModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  providerId: PropTypes.string.isRequired,
};
