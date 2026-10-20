"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function RunsListClient() {
  const router = useRouter();
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/probe/runs?limit=100", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Run list failed with HTTP ${res.status}`);
      setRuns(Array.isArray(data.runs) ? data.runs : []);
    } catch (err) {
      setError(err.message || "Failed to load probe runs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer = null;
    const poll = async () => {
      if (stopped) return;
      await fetchRuns();
      if (!stopped) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchRuns]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto px-4 sm:px-6 py-6">
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-text-muted mb-1">
            <span>Probe</span><span>/</span><span className="text-text-main font-medium">Runs</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-main">Probe runs</h1>
          <p className="text-sm text-text-muted mt-1">Saved live progress and reports. Runs remain available after refresh or restart.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={fetchRuns} className="rounded-[8px] border border-border px-3 py-2 text-xs font-medium text-text-main hover:bg-bg-subtle">Refresh</button>
          <button type="button" onClick={() => router.push("/dashboard/probe")} className="rounded-[8px] bg-primary px-3 py-2 text-xs font-semibold text-white hover:opacity-90">New run</button>
        </div>
      </header>

      {error && <div role="alert" className="rounded-[12px] border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-300">{error}</div>}

      <section className="rounded-[12px] border border-border bg-bg-elevated overflow-hidden">
        {loading && runs.length === 0 ? (
          <div className="p-8 text-center text-sm text-text-muted">Loading runs…</div>
        ) : runs.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm font-medium text-text-main">No probe runs yet</p>
            <p className="text-xs text-text-muted mt-1">Start a run to create the first saved report.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {runs.map((run) => {
              const total = run.totalProbes || 0;
              const percent = total > 0 ? Math.round(((run.completedProbes || 0) / total) * 100) : 0;
              return (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => router.push(`/dashboard/probe/runs/${encodeURIComponent(run.id)}`)}
                  className="w-full px-4 py-4 text-left hover:bg-bg-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-text-main truncate">{run.targetModel || "Unknown model"}</span>
                        <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${run.status === "running" ? "bg-primary/10 text-primary" : run.status === "complete" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-bg-subtle text-text-muted"}`}>{run.status}</span>
                      </div>
                      <div className="text-[11px] text-text-muted font-mono truncate mt-1">{run.id}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold text-text-main">{run.completedProbes || 0} / {total || "?"}</div>
                      <div className="text-[11px] text-text-muted">{run.status === "running" ? `${percent}% · ` : ""}{new Date(run.createdAt).toLocaleString()}</div>
                    </div>
                  </div>
                  {run.status === "running" && total > 0 && (
                    <div className="h-1 mt-3 rounded-full bg-bg-subtle overflow-hidden">
                      <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
