"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Badge, Button, Modal } from "@/shared/components";
import Pagination from "@/shared/components/Pagination";

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
  const [operationMessage, setOperationMessage] = useState("");
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState({ page: 1, pageSize: 10, totalPages: 1, totalAccounts: 0, matchedAccounts: 0 });
  const [cooldownUntil, setCooldownUntil] = useState(null);
  const loadController = useRef(null);

  useEffect(() => {
    if (!cooldownUntil) return undefined;
    let timer;
    const checkExpiry = () => {
      const remaining = cooldownUntil - Date.now();
      if (remaining > 0) timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
      else setCooldownUntil((current) => current === cooldownUntil ? null : current);
    };
    timer = setTimeout(checkExpiry, Math.min(Math.max(0, cooldownUntil - Date.now()), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [cooldownUntil]);

  const loadAccounts = useCallback(async (signal, inspect = false, connectionId = "") => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/providers/${encodeURIComponent(providerId)}/zai-plans?${new URLSearchParams({ page: String(page), search, inspect: String(inspect), ...(connectionId ? { connectionId } : {}) })}`,
        { cache: "no-store", signal: controller.signal }
      );
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || "Failed to retrieve account plans");
      setAccounts((current) => connectionId
        ? (data.accounts || []).map((account) => account.connectionId === connectionId
          ? account : current.find((previous) => previous.connectionId === account.connectionId) || account)
        : data.accounts || []);
      setPagination({ page: data.page, pageSize: data.pageSize, totalPages: data.totalPages, totalAccounts: data.totalAccounts, matchedAccounts: data.matchedAccounts ?? data.totalAccounts });
      setCooldownUntil(data.cooldownUntil > Date.now() ? data.cooldownUntil : null);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(loadError.message || "Failed to retrieve account plans");
    } finally {
      signal?.removeEventListener("abort", abort);
      if (loadController.current === controller) setLoading(false);
    }
  }, [providerId, page, search]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setResults({});
      setOperationMessage("");
      loadAccounts(controller.signal);
    }, 0);
    return () => { clearTimeout(timer); controller.abort(); loadController.current?.abort(); };
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

  const claim = async (connectionIds, planId, key, action) => {
    if (claimingKey) {
      setOperationMessage("Another plan action is still running. Wait for its result before retrying.");
      return;
    }
    if (cooldownUntil) {
      setError("Z.AI requested a cooldown. No claim was sent; wait until the displayed retry time.");
      return;
    }
    setClaimingKey(key);
    setError("");
    setOperationMessage(action === "prepare_original_start_plan"
      ? "Preparing the original Start Plan and checking its balance…"
      : `Checking the selected offer for ${connectionIds.length} account(s)…`);
    setResults((current) => {
      const next = { ...current };
      for (const connectionId of connectionIds) next[connectionId] = { status: "pending", message: "Request queued; checking the account before submitting." };
      return next;
    });
    // API caps one batch at 50 connections; split larger groups client-side.
    const BATCH_SIZE = 50;
    const completed = [];
    try {
      for (let i = 0; i < connectionIds.length; i += BATCH_SIZE) {
        const response = await fetch(
          `/api/providers/${encodeURIComponent(providerId)}/zai-plans`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connectionIds: connectionIds.slice(i, i + BATCH_SIZE), planId, action }),
          }
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Plan request failed");
        const expectedIds = connectionIds.slice(i, i + BATCH_SIZE);
        const returnedResults = Array.isArray(data.results) ? data.results : [];
        if (expectedIds.some((connectionId) => !returnedResults.some((result) => result.connectionId === connectionId))) {
          throw new Error("The server did not return a result for every selected account; check the account balance before retrying");
        }
        completed.push(...returnedResults);
        setCooldownUntil(data.cooldownUntil || null);
        setResults((current) => {
          const next = { ...current };
          for (const result of returnedResults) next[result.connectionId] = result;
          return next;
        });
        if (data.cooldownUntil || data.results?.some((result) => result.status === "uncertain")) break;
      }
      const succeeded = completed.filter((result) => result.ok).length;
      const notAttempted = completed.filter((result) => result.status === "not_attempted").length;
      const uncertain = completed.filter((result) => result.status === "uncertain").length;
      const failed = completed.length - succeeded - notAttempted - uncertain;
      setOperationMessage(`Finished: ${succeeded} succeeded · ${failed} failed · ${notAttempted} not attempted · ${uncertain} uncertain.`);
      setResults((current) => {
        const next = { ...current };
        for (const connectionId of connectionIds) {
          if (next[connectionId]?.status === "pending") next[connectionId] = {
            status: "not_attempted", ok: false, error: "Not attempted: the batch stopped before this account was submitted.",
          };
        }
        return next;
      });
      await loadAccounts();
    } catch (claimError) {
      const reason = claimError.message || "Plan request failed";
      setError(reason);
      setOperationMessage("Plan action stopped. No automatic retry was sent; see the result below.");
      setResults((current) => {
        const next = { ...current };
        for (const connectionId of connectionIds) {
          if (next[connectionId]?.status === "pending") next[connectionId] = {
            ok: false, status: "unavailable", error: reason,
          };
        }
        return next;
      });
    } finally {
      setClaimingKey("");
    }
  };

  const handleClose = () => {
    if (claimingKey) return;
    loadController.current?.abort();
    onClose();
  };

  const waiting = cooldownUntil !== null;
  const navigationDisabled = loading || !!claimingKey;
  const actionsDisabled = navigationDisabled || waiting;
  const changePage = (nextPage) => {
    if (navigationDisabled || nextPage === pagination.page) return;
    setAccounts([]);
    setPage(nextPage);
  };
  const applySearch = (value) => {
    const nextSearch = value.trim();
    if (navigationDisabled || (nextSearch === search && pagination.page === 1)) return;
    setAccounts([]);
    setSearch(nextSearch);
    setPage(1);
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Z.AI Plan Management">
      <div className="flex max-h-[75vh] flex-col gap-4 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-text-muted">
            Browsing and searching do not check plans. Use Check This Page or Check Account. Recent checks are reused for up to one minute; claims are always checked again.
          </p>
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={() => loadAccounts(undefined, true)}
            disabled={actionsDisabled || accounts.length === 0}
          >
            Check This Page
          </Button>
        </div>

        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); applySearch(searchInput); }}>
          <label className="min-w-0 flex-1 text-xs text-text-muted">
            Search accounts
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Name or email"
              maxLength={200}
              disabled={navigationDisabled}
              className="mt-1 block w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <Button type="submit" size="sm" variant="secondary" disabled={navigationDisabled}>Search</Button>
          {(searchInput || search) && (
            <Button type="button" size="sm" variant="ghost" disabled={navigationDisabled}
              onClick={() => { setSearchInput(""); applySearch(""); }}>
              Clear
            </Button>
          )}
        </form>

        {waiting && (
          <div role="status" className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm text-warning">
            Z.AI requested a cooldown (HTTP 429). Plan checks and claims are paused until {new Date(cooldownUntil).toLocaleString()}.
            {" "}Any results shown below were checked earlier; unavailable checks do not mean an account has no offers.
          </div>
        )}

        {operationMessage && (
          <p role="status" aria-live="polite" className="rounded-lg border border-border bg-surface-secondary p-3 text-sm text-text-primary">
            {operationMessage}
          </p>
        )}

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
                  disabled={actionsDisabled}
                >
                  {claimingKey === `bulk:${offer.planId}` ? "Checking / claiming..." : "Claim Eligible on This Page"}
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
            <p className="py-8 text-center text-sm text-text-muted">{search ? "No accounts match your search." : "No accounts found."}</p>
          ) : accounts.map((account) => {
            const claimableOffers = accountClaimableOffers(account);
            const showAccountError = account.error && !(account.errorSource === "preview" && account.errorReasonCode === "preview_missing_data");
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
                    {account.checkedAt && <p className="text-xs text-text-muted">
                      {account.cached ? "Cached check" : "Checked"}: {new Date(account.checkedAt).toLocaleTimeString()}
                    </p>}
                    {account.inspectionStatus === "unchecked" && (
                      <p className="mt-1 text-xs text-text-muted">Not checked yet.</p>
                    )}
                  </div>
                  <Button size="sm" variant="secondary" className="shrink-0 whitespace-nowrap" disabled={actionsDisabled || !account.eligible}
                    onClick={() => loadAccounts(undefined, true, account.connectionId)}>
                    Check Account
                  </Button>
                </div>

                {account.balanceStatus === "stale" && (
                  <p className="mt-3 text-xs text-warning">Balance is stale (last successful check: {account.balanceCheckedAt ? new Date(account.balanceCheckedAt).toLocaleString() : "unknown"}). Claims require a fresh ownership check.</p>
                )}
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
                            <p className="text-xs text-text-muted">Source: {offer.source === "campaign" ? "Campaign delivery" : "Billing preview"} · eligibility is rechecked when claiming.</p>
                            {offer.description && <p className="text-xs text-text-muted">{offer.description}</p>}
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            icon="redeem"
                            onClick={() => claim([account.connectionId], offer.planId, key)}
                            disabled={actionsDisabled}
                          >
                            {claimingKey === key ? "Checking / claiming..." : "Claim"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {account.eligible && account.originalStartPlanActive !== true && (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-text-muted">
                      {account.originalStartPlanActive === false
                        ? "Original daily Start Plan (0817) is not active. "
                        : "Original Start Plan status has not been verified. You can check this account or run preparation. "}
                      Preparation enrolls the native project, then checks balance; it does not claim promotions or guarantee a grant.
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => claim([account.connectionId], undefined, `original:${account.connectionId}`, "prepare_original_start_plan")}
                      disabled={actionsDisabled}
                    >
                      {claimingKey === `original:${account.connectionId}` ? "Adding..." : "Add Start Plan"}
                    </Button>
                  </div>
                )}

                {account.eligible && account.inspectionStatus === "complete" && claimableOffers.length === 0 && !account.error && !account.campaignError && (
                  <p className="mt-3 text-xs text-text-muted">No claimable offers returned by this check. This does not establish campaign ineligibility.</p>
                )}
                {showAccountError && <p className="mt-3 text-xs text-warning">
                  {account.errorSource === "preview" ? "Billing preview unavailable: " : account.errorSource === "balance" ? "Balance check failed: " : account.errorSource === "campaign" ? "Campaign discovery failed: " : "Plan check failed: "}
                  {account.error}
                  {account.errorSource === "preview" && claimableOffers.some((offer) => offer.source === "campaign") && " The offer above came from a separate campaign delivery; claiming will verify it again."}
                </p>}
                {account.campaignError && account.campaignError !== account.error && <p className="mt-3 text-xs text-warning">Campaign discovery failed: {account.campaignError}</p>}
                {result && (
                  <p role="status" className={`mt-3 rounded border border-border p-2 text-sm ${result.status === "pending" ? "text-text-muted" : result.ok ? "text-success" : "text-error"}`}>
                    {result.status === "pending" ? result.message : result.ok ? result.message : `Action ${result.status === "not_attempted" ? "not attempted" : result.status === "uncertain" ? "uncertain" : "failed"}: ${result.error}`}
                  </p>
                )}
              </section>
            );
          })}
        </div>

        <div className="shrink-0 border-t border-border pt-2">
          <p className="text-center text-xs text-text-muted">
            Page {pagination.page} of {pagination.totalPages} · {pagination.matchedAccounts} {search ? `matching of ${pagination.totalAccounts}` : ""} accounts
          </p>
          <Pagination currentPage={pagination.page} pageSize={pagination.pageSize}
            totalItems={pagination.matchedAccounts} onPageChange={changePage}
            disabled={navigationDisabled} showBoundaryButtons className="gap-2 py-2" />
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
