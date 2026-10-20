"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ProbeRail from "../../components/ProbeRail";
import ProbeResultPanel from "../../components/ProbeResultPanel";
import ProbeReportSummary from "../../components/ProbeReportSummary";
import { DEFAULT_PROBES } from "../../components/probeConstants";

function statusOf(result) {
  if (result.status === "error") return "error";
  if (result.status === "skipped") return "skipped";
  if (typeof result.passed === "boolean") return result.passed ? "passed" : "failed";
  if (result.neutral) return "neutral";
  return result.status || "neutral";
}

function mergeRunResults(templates, results) {
  const byId = new Map((results || []).map((row) => [row.probeId || row.id, row]));
  const merged = templates.map((probe) => {
    const result = byId.get(probe.id);
    if (!result) return { ...probe, status: "pending" };
    byId.delete(probe.id);
    return { ...probe, ...result, id: probe.id, status: statusOf(result) };
  });
  for (const result of byId.values()) {
    merged.push({ ...result, id: result.probeId || result.id, status: statusOf(result) });
  }
  return merged;
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
        <button type="button" onClick={() => router.push("/dashboard/probe")} className="text-sm text-primary hover:underline">Back to Probe runs</button>
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
          <button type="button" onClick={() => router.push("/dashboard/probe")} className="text-xs text-primary hover:underline mb-2">Back to Probe runs</button>
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

      <ProbeResultPanel
        activeProbe={isRunning ? nextPending : null}
        selectedProbe={selectedProbe}
        elapsedSec={0}
        isRunning={isRunning}
      />

      {!isRunning && completeResults.length > 0 && (
        <ProbeReportSummary
          report={{ startedAt: run.createdAt, completedAt: run.finishedAt }}
          results={completeResults}
          onSelectProbe={(probe) => setSelectedProbeId(probe.id)}
        />
      )}
    </div>
  );
}
