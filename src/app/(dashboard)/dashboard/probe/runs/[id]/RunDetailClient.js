"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Drawer from "@/shared/components/Drawer";
import ProbeRail from "../../components/ProbeRail";
import ProbeResultPanel from "../../components/ProbeResultPanel";
import ProbeReportSummary from "../../components/ProbeReportSummary";
import { DEFAULT_PROBES, ORIGINAL_SUITE_IDS } from "../../components/probeConstants";

function statusOf(result) {
  if (result.status === "error") return "error";
  if (result.status === "skipped") return "skipped";
  if (typeof result.passed === "boolean") return result.passed ? "passed" : "failed";
  if (result.neutral) return "neutral";
  return result.status || "neutral";
}

function mergeRunResults(templates, results) {
  const templateById = new Map(templates.map((probe) => [probe.id, probe]));
  const resultById = new Map((results || []).map((row) => [row.probeId || row.id, row]));

  // Exact public-suite projection keeps historical 97/100-probe rows from
  // reappearing after the engine contract changed. Catalog templates provide
  // canonical English labels; fallback templates cover catalog outages.
  return ORIGINAL_SUITE_IDS.map((id) => {
    const probe = templateById.get(id) || DEFAULT_PROBES.find((item) => item.id === id);
    const result = resultById.get(id);
    if (!result) return { ...probe, status: "pending" };
    return { ...result, ...probe, status: statusOf(result) };
  });
}

/** Human wording for the engine verdict statuses. */
const VERDICT_TEXT = {
  clean_match: { headline: "Model verified — full match", tone: "good" },
  clean_match_family_only: { headline: "Same family — exact model unconfirmed", tone: "partial" },
  clean_match_submodel_mismatch: { headline: "Family matches — different sub-model", tone: "warn" },
  plain_mismatch: { headline: "Model does not match the claim", tone: "bad" },
  spoof_behavior_induced: { headline: "Behavior was steered (spoof detected)", tone: "bad" },
  spoof_selfclaim_forged: { headline: "Self-identification was faked", tone: "bad" },
  ambiguous: { headline: "Ambiguous evidence", tone: "partial" },
  insufficient_data: { headline: "Not enough data for a verdict", tone: "neutral" },
};

function IdentityCard({ summary }) {
  if (!summary?.identityAssessment) return null;
  const identity = summary.identityAssessment;
  const verdict = identity.verdict || {};
  const key = verdict.status || identity.status;
  const text = VERDICT_TEXT[key] || { headline: key, tone: "neutral" };
  const toneClass = {
    good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    partial: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    bad: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    neutral: "border-border bg-surface-2 text-text-muted",
  }[text.tone] || "border-border bg-surface-2 text-text-muted";

  const confidencePct = typeof identity.confidence === "number" ? Math.round(identity.confidence * 100) : null;
  const candidates = Array.isArray(identity.predictedCandidates) ? identity.predictedCandidates.slice(0, 5) : [];

  return (
    <section className="rounded-[14px] bg-surface border border-border-subtle p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text-main">Model Identity Verification</h2>
          <p className="text-xs text-text-muted mt-0.5">
            {identity.claimedModel ? <>Claimed model: <span className="font-mono">{identity.claimedModel}</span></> : "No claimed model"}
          </p>
        </div>
        {confidencePct !== null && (
          <div className="text-right">
            <div className="text-2xl font-bold text-text-main leading-none">{confidencePct}%</div>
            <div className="text-[11px] text-text-muted mt-0.5">Family confidence</div>
          </div>
        )}
      </div>

      <div className={`rounded-[10px] border p-3 text-sm font-semibold ${toneClass}`}>
        {text.headline}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <div className="p-2.5 rounded-[8px] bg-bg border border-border-subtle">
          <span className="text-text-subtle text-[10px] block uppercase font-mono">Inferred family</span>
          <span className="font-semibold text-text-main break-words">{identity.predictedFamily || "—"}</span>
        </div>
        <div className="p-2.5 rounded-[8px] bg-bg border border-border-subtle">
          <span className="text-text-subtle text-[10px] block uppercase font-mono">Verdict status</span>
          <span className="font-semibold text-text-main break-words">{key || "—"}</span>
        </div>
        <div className="p-2.5 rounded-[8px] bg-bg border border-border-subtle">
          <span className="text-text-subtle text-[10px] block uppercase font-mono">Verdict confidence</span>
          <span className="font-semibold text-text-main break-words">{verdict.confidence || "—"}</span>
        </div>
      </div>

      {candidates.length > 0 && (
        <div className="space-y-1">
          <span className="font-semibold text-text-subtle text-[10px] uppercase font-mono block">Closest sub-models</span>
          <div className="space-y-1">
            {candidates.map((candidate) => (
              <div key={candidate.modelId} className="flex items-center justify-between text-xs bg-surface-2 rounded-[8px] px-2.5 py-1.5">
                <span className="font-medium text-text-main truncate">{candidate.displayName || candidate.modelId}</span>
                <span className="font-mono text-text-muted shrink-0">{Math.round((candidate.score || 0) * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(verdict.reasoning) && verdict.reasoning.length > 0 && (
        <div className="space-y-1">
          <span className="font-semibold text-text-subtle text-[10px] uppercase font-mono block">Why this verdict</span>
          <ul className="text-xs text-text-muted space-y-1 list-disc pl-4">
            {verdict.reasoning.map((line, index) => <li key={index}>{line}</li>)}
          </ul>
        </div>
      )}

      {Array.isArray(identity.riskFlags) && identity.riskFlags.length > 0 && (
        <div className="rounded-[8px] border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <span className="font-semibold uppercase font-mono text-[10px] block mb-1">Behavior warnings</span>
          <ul className="space-y-1 list-disc pl-4">
            {identity.riskFlags.map((flag, index) => <li key={index}>{flag}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function RunDetailClient({ runId }) {
  const router = useRouter();
  const [run, setRun] = useState(null);
  const [templates, setTemplates] = useState(DEFAULT_PROBES);
  const [suiteVersion, setSuiteVersion] = useState(null);
  const [selectedProbeId, setSelectedProbeId] = useState(null);
  const [error, setError] = useState(null);

  const fetchRun = useCallback(async () => {
    const res = await fetch(`/api/probe/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Run lookup failed with HTTP ${res.status}`);
    setRun(data.run);
    return data.run;
  }, [runId]);

  useEffect(() => {
    let stopped = false;
    let timer = null;

    fetch("/api/probe/suite", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!stopped && Array.isArray(data?.probes) && data.probes.length > 0) {
          setTemplates(data.probes);
          setSuiteVersion(data.version || null);
        }
      })
      .catch(() => {});

    const poll = async () => {
      try {
        const next = await fetchRun();
        if (!stopped && next.status === "running") {
          timer = setTimeout(poll, 3000);
        }
      } catch (err) {
        if (!stopped) setError(err.message || "Failed to load probe run");
      }
    };
    poll();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchRun]);

  const probes = useMemo(
    () => mergeRunResults(templates, run?.results),
    [templates, run?.results],
  );
  const selectedProbe = probes.find((probe) => probe.id === selectedProbeId) || null;
  const nextPending = probes.find((probe) => probe.status === "pending") || null;
  const isRunning = run?.status === "running";
  const completeResults = probes.filter((probe) => probe.status !== "pending" && probe.status !== "running");

  const handleCancel = async () => {
    await fetch("/api/probe/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    }).catch(() => {});
    await fetchRun().catch(() => {});
  };

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        <button type="button" onClick={() => router.push("/dashboard/probe/runs")} className="text-sm text-primary hover:underline">Back to Probe runs</button>
        <div role="alert" className="rounded-[12px] border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-300">{error}</div>
      </div>
    );
  }

  if (!run) {
    return <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 text-sm text-text-muted">Loading probe run…</div>;
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto px-4 sm:px-6 py-6">
      <header className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <button type="button" onClick={() => router.push("/dashboard/probe/runs")} className="text-xs text-primary hover:underline mb-2">Back to Probe runs</button>
          <h1 className="text-2xl font-bold tracking-tight text-text-main">{run.targetModel || "Probe run"}</h1>
          <p className="text-xs text-text-muted font-mono mt-1">{run.id}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs font-semibold rounded-full px-3 py-1.5 ${isRunning ? "bg-primary/10 text-primary" : run.status === "complete" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-bg-subtle text-text-muted"}`}>
            {run.status}
          </span>
          {isRunning && (
            <button type="button" onClick={handleCancel} className="text-xs font-semibold rounded-[8px] border border-red-500/30 px-3 py-1.5 text-red-600 hover:bg-red-500/10">Cancel run</button>
          )}
        </div>
      </header>

      {run.score !== null && run.score !== undefined && (
        <div className="rounded-[14px] bg-surface border border-border-subtle p-5 flex items-center gap-6">
          <div>
            <div className="text-3xl font-bold text-text-main leading-none">{run.score}<span className="text-lg text-text-muted"> / {run.scoreMax ?? 100}</span></div>
            <div className="text-[11px] text-text-muted mt-1">Endpoint integrity score</div>
          </div>
          <div className="h-10 w-px bg-border" />
          <div className="text-xs text-text-muted">
            {completeResults.length} checks recorded
            {run.summary?.totalInputTokens ? ` · ${run.summary.totalInputTokens} in / ${run.summary.totalOutputTokens ?? 0} out tokens` : ""}
          </div>
        </div>
      )}

      <IdentityCard summary={run.summary} />

      <div className="rounded-[12px] border border-border bg-bg-elevated p-4">
        <div className="flex justify-between text-xs text-text-muted mb-2">
          <span>Live progress</span>
          <span>{run.completedProbes || 0} / {run.totalProbes || probes.length} ({run.totalProbes ? Math.round(((run.completedProbes || 0) / run.totalProbes) * 100) : 0}%)</span>
        </div>
        <div className="h-2 rounded-full bg-bg-subtle overflow-hidden">
          <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${run.totalProbes ? Math.min(100, ((run.completedProbes || 0) / run.totalProbes) * 100) : 0}%` }} />
        </div>
        {isRunning && nextPending && <p className="text-xs text-text-muted mt-2">Next: {nextPending.label}</p>}
      </div>

      <ProbeRail
        probes={probes}
        suiteVersion={suiteVersion}
        activeProbeId={isRunning ? nextPending?.id : null}
        selectedProbeId={selectedProbeId}
        onSelectProbe={(probe) => setSelectedProbeId(probe.id)}
      />

      {!isRunning && completeResults.length > 0 && (
        <ProbeReportSummary
          report={{ startedAt: run.createdAt, completedAt: run.finishedAt }}
          results={completeResults}
          onSelectProbe={(probe) => setSelectedProbeId(probe.id)}
        />
      )}

      {/* Right-side probe detail drawer (original-page interaction pattern). */}
      <Drawer
        isOpen={Boolean(selectedProbe)}
        onClose={() => setSelectedProbeId(null)}
        title={selectedProbe ? `${selectedProbe.label}` : "Check Inspector"}
        width="lg"
      >
        {selectedProbe && (
          <ProbeResultPanel
            selectedProbe={selectedProbe}
            elapsedSec={0}
            isRunning={false}
            asDrawerContent
          />
        )}
      </Drawer>
    </div>
  );
}
