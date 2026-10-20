"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import SidecarHealthStrip from "./components/SidecarHealthStrip";
import ProbeConfigCard from "./components/ProbeConfigCard";
import ProbeRail from "./components/ProbeRail";
import ProbeResultPanel from "./components/ProbeResultPanel";
import ProbeReportSummary from "./components/ProbeReportSummary";
import { DEFAULT_PROBES } from "./components/probeConstants";

const FALLBACK_SUITE_VERSION = null;

function pendingProbes(templates) {
  return templates.map((probe) => ({ ...probe, status: "pending" }));
}

function validSuiteCatalog(data) {
  if (!data || typeof data.version !== "string" || !Array.isArray(data.probes) || data.probes.length === 0) {
    return false;
  }

  const ids = new Set();
  return data.probes.every((probe) => {
    if (
      !probe ||
      typeof probe.id !== "string" ||
      typeof probe.label !== "string" ||
      typeof probe.group !== "string" ||
      typeof probe.description !== "string" ||
      ids.has(probe.id)
    ) {
      return false;
    }
    ids.add(probe.id);
    return true;
  });
}

export default function ProbePageClient() {
  // Sidecar Health
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(true);

  // Target and judge catalogs are fetched explicitly through the protected Probe API.
  const [targetCatalog, setTargetCatalog] = useState({ models: [], loading: false, error: null });
  const [judgeCatalog, setJudgeCatalog] = useState({ models: [], loading: false, error: null });

  // Saved Profiles (24h TTL)
  const [profiles, setProfiles] = useState([]);
  const [selectedTargetProfileId, setSelectedTargetProfileId] = useState(null);
  const [selectedJudgeProfileId, setSelectedJudgeProfileId] = useState(null);

  // Target Configuration
  const [target, setTarget] = useState({
    source: "this_9router",
    endpoint: "",
    apiKey: "",
    model: "",
    claimedModel: "",
    customHeaders: [],
  });

  // Optional Custom Judge Configuration
  const [useCustomJudge, setUseCustomJudge] = useState(false);
  const [judge, setJudge] = useState({
    source: "this_9router",
    endpoint: "",
    apiKey: "",
    model: "",
    customHeaders: [],
  });

  // Run lifecycle state
  const [isRunning, setIsRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState(null);
  const [runError, setRunError] = useState(null);
  const [activeProbeId, setActiveProbeId] = useState(null);
  const [selectedProbeId, setSelectedProbeId] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Suite templates stay separate from mutable run results.
  const [suiteTemplates, setSuiteTemplates] = useState(DEFAULT_PROBES);
  const [suiteVersion, setSuiteVersion] = useState(FALLBACK_SUITE_VERSION);
  const [probes, setProbes] = useState(() => pendingProbes(DEFAULT_PROBES));

  // Final transient report
  const [report, setReport] = useState(null);

  // Server-persisted run history (survives refresh)
  const [runs, setRuns] = useState([]);
  const [viewingRun, setViewingRun] = useState(null);

  // Internal refs
  const abortControllerRef = useRef(null);
  const timerRef = useRef(null);
  const startTimeRef = useRef(null);
  const isRunningRef = useRef(false);
  const suiteTemplatesRef = useRef(DEFAULT_PROBES);
  const pollTimerRef = useRef(null);

  // Helper to upsert incoming probe record
  const updateProbeRecord = useCallback((incoming) => {
    if (!incoming || !incoming.id) return;
    setProbes((prev) => {
      const index = prev.findIndex((p) => p.id === incoming.id);
      if (index >= 0) {
        const next = [...prev];
        next[index] = { ...next[index], ...incoming };
        return next;
      }
      // New probe discovered from sidecar not in default list
      return [...prev, incoming];
    });
  }, []);

  // Normalize a finished ProbeResult (probe_result event, sidecar "progress"
  // payload, or report row) into a rail record update.
  const applyProbeResult = useCallback((r) => {
    if (!r || !(r.probeId || r.id)) return;
    let status = "neutral";
    if (r.status === "error") {
      status = "error";
    } else if (r.status === "skipped") {
      status = "skipped";
    } else if (typeof r.passed === "boolean") {
      status = r.passed ? "passed" : "failed";
    } else if (r.neutral) {
      status = "neutral";
    } else if (r.status) {
      status = r.status;
    }
    updateProbeRecord({
      id: r.probeId || r.id,
      label: r.label,
      group: r.group,
      neutral: Boolean(r.neutral),
      status,
      passed: r.passed,
      passReason: r.passReason,
      durationMs: r.durationMs,
      ttftMs: r.ttftMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      tps: r.tps,
      response: r.response,
      error: r.error,
    });
  }, [updateProbeRecord]);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/probe/runs?limit=20");
      if (res.ok) {
        const data = await res.json();
        setRuns(Array.isArray(data.runs) ? data.runs : []);
      }
    } catch {
      // History is best-effort; the page works without it.
    }
  }, []);

  const stopRunPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Load a persisted run into the rail/detail. While the run is still active
  // server-side, poll until it finishes — this is what makes a refresh
  // mid-run re-attach to live progress.
  const loadRun = useCallback(async (runId) => {
    try {
      const res = await fetch(`/api/probe/runs/${encodeURIComponent(runId)}`);
      if (!res.ok) return null;
      const data = await res.json();
      const run = data.run;
      if (!run) return null;

      setViewingRun(run);
      setRuns((prev) => prev.map((item) => (item.id === run.id ? { ...item, ...run } : item)));
      if (Array.isArray(run.results)) {
        for (const r of run.results) {
          applyProbeResult(r);
        }
      }
      if (run.status === "complete" && Array.isArray(run.results) && run.results.length > 0) {
        setReport({ results: run.results });
      }
      return run;
    } catch {
      return null;
    }
  }, [applyProbeResult]);

  const pollRunUntilDone = useCallback((runId) => {
    stopRunPolling();
    pollTimerRef.current = setInterval(async () => {
      const run = await loadRun(runId);
      if (!run || run.status !== "running") {
        stopRunPolling();
        fetchRuns();
      }
    }, 4000);
  }, [loadRun, stopRunPolling, fetchRuns]);

  // Fetch Sidecar Health (callable on demand)
  const fetchHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const res = await fetch("/api/probe/health");
      const data = await res.json().catch(() => ({}));
      setHealth(data);
    } catch {
      setHealth({ status: "offline", sidecar: { reachable: false, status: 503 } });
    } finally {
      setHealthLoading(false);
    }
  }, []);

  // Fetch Profiles (callable on demand)
  const fetchProfiles = useCallback(async () => {
    try {
      const res = await fetch("/api/probe/profiles");
      if (res.ok) {
        const data = await res.json();
        setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
      }
    } catch {
      // Fail-open: profiles list can be empty
    }
  }, []);

  // Initial load effect
  useEffect(() => {
    let ignore = false;
    const runIdFromUrl = new URLSearchParams(window.location.search).get("runId");

    // Health
    fetch("/api/probe/health")
      .then((res) => res.json())
      .then((data) => {
        if (!ignore) setHealth(data);
      })
      .catch(() => {
        if (!ignore) setHealth({ status: "offline", sidecar: { reachable: false, status: 503 } });
      })
      .finally(() => {
        if (!ignore) setHealthLoading(false);
      });

    // Authoritative suite catalog. Static definitions remain fallback only.
    fetch("/api/probe/suite")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (ignore || !validSuiteCatalog(data)) return;

        const templates = data.probes.map((probe) => ({ ...probe }));
        const validIds = new Set(templates.map((probe) => probe.id));
        suiteTemplatesRef.current = templates;
        setSuiteTemplates(templates);
        setSuiteVersion(data.version);
        if (!runIdFromUrl) {
          setProbes(pendingProbes(templates));
          setSelectedProbeId((id) => (validIds.has(id) ? id : null));
          setActiveProbeId((id) => (validIds.has(id) ? id : null));
        }
      })
      .catch(() => {});

    // Profiles
    fetch("/api/probe/profiles")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!ignore && data?.profiles) {
          setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
        }
      })
      .catch(() => {});

    // Persisted history + selected run. The run id in the URL gives every run
    // a stable detail view and lets refresh re-hydrate progress.
    fetch("/api/probe/runs?limit=20")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!ignore && Array.isArray(data?.runs)) setRuns(data.runs);
      })
      .catch(() => {});

    // Active Run check
    fetch("/api/probe/run")
      .then((res) => (res.ok ? res.json() : null))
      .then(async (data) => {
        if (ignore) return;
        const activeId = data?.active && data.run?.runId ? data.run.runId : null;
        const selectedRunId = runIdFromUrl || activeId;
        if (activeId) {
          isRunningRef.current = true;
          setActiveRunId(activeId);
          setIsRunning(true);
        }
        if (selectedRunId) {
          const run = await loadRun(selectedRunId);
          if (!ignore && run?.status === "running") pollRunUntilDone(selectedRunId);
        }
      })
      .catch(() => {});

    return () => {
      ignore = true;
      stopRunPolling();
    };
  }, [fetchRuns, loadRun, pollRunUntilDone, stopRunPolling]);

  // Elapsed timer handling
  useEffect(() => {
    if (isRunning) {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        if (startTimeRef.current) {
          setElapsedSec((Date.now() - startTimeRef.current) / 1000);
        }
      }, 100);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRunning]);

  // Profile Save
  const handleSaveProfile = async ({ name, type, target: targetData, judge: judgeData }) => {
    const isTargetType = type === "target";
    const src = isTargetType ? targetData : judgeData;

    const payload = {
      name,
      type,
      source: src?.source || "this_9router",
      model: src?.model || null,
      endpoint: src?.source === "custom" ? (src?.endpoint || null) : null,
      secrets: {
        ...(src?.apiKey ? { apiKey: src.apiKey } : {}),
        ...(src?.customHeaders?.length ? { customHeaders: src.customHeaders } : {}),
      },
    };

    const res = await fetch("/api/probe/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const created = await res.json();
      await fetchProfiles();
      if (isTargetType && created.profile?.id) {
        setSelectedTargetProfileId(created.profile.id);
      } else if (!isTargetType && created.profile?.id) {
        setSelectedJudgeProfileId(created.profile.id);
      }
    } else {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Failed to save profile");
    }
  };

  // Profile Delete
  const handleDeleteProfile = async (id) => {
    const res = await fetch(`/api/probe/profiles/${id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      if (selectedTargetProfileId === id) setSelectedTargetProfileId(null);
      if (selectedJudgeProfileId === id) setSelectedJudgeProfileId(null);
      await fetchProfiles();
    }
  };

  // Profile Selection Updates
  const handleSelectTargetProfile = (id) => {
    setSelectedTargetProfileId(id);
    if (!id) return;
    const found = profiles.find((p) => p.id === id);
    if (found) {
      setTarget((prev) => ({
        ...prev,
        source: found.source || (found.endpoint ? "custom" : "this_9router"),
        model: found.model || prev.model,
        endpoint: found.endpoint || prev.endpoint,
        apiKey: "", // Secrets remain encrypted on server
        customHeaders: [],
      }));
    }
  };

  const handleSelectJudgeProfile = (id) => {
    setSelectedJudgeProfileId(id);
    if (!id) return;
    const found = profiles.find((p) => p.id === id);
    if (found) {
      setJudge((prev) => ({
        ...prev,
        source: found.source || (found.endpoint ? "custom" : "this_9router"),
        model: found.model || prev.model,
        endpoint: found.endpoint || prev.endpoint,
        apiKey: "",
        customHeaders: [],
      }));
    }
  };

  const handleFetchModels = async (kind) => {
    const isTarget = kind === "target";
    const config = isTarget ? target : judge;
    const setCatalog = isTarget ? setTargetCatalog : setJudgeCatalog;
    const setConfig = isTarget ? setTarget : setJudge;

    setCatalog((current) => ({ ...current, loading: true, error: null }));
    try {
      const res = await fetch("/api/probe/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: config.source,
          ...(config.source === "custom" ? { endpoint: config.endpoint } : {}),
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          ...(config.customHeaders?.length ? { customHeaders: config.customHeaders } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Model discovery failed with HTTP ${res.status}`);
      const models = Array.isArray(data.models) ? data.models : [];
      setCatalog({ models, loading: false, error: null });
      if (models.length && !config.model) {
        setConfig((current) => ({ ...current, model: models[0].id }));
      }
    } catch (error) {
      setCatalog({ models: [], loading: false, error: error.message || "Model discovery failed" });
    }
  };

  // Cancel Probe Run
  const handleCancelRun = async () => {
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch { /* ignore */ }
    }

    if (activeRunId) {
      try {
        await fetch("/api/probe/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: activeRunId }),
        });
      } catch {
        // Ignore cancel errors
      }
    }

    isRunningRef.current = false;
    setIsRunning(false);
    setActiveRunId(null);
    setActiveProbeId(null);
  };

  // Start Probe Run
  const handleStartRun = async () => {
    setRunError(null);
    setReport(null);

    // Reset probe rail from active suite templates.
    setProbes(pendingProbes(suiteTemplatesRef.current));

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Build payload
    const body = {
      config: { suite: "full" },
    };

    if (selectedTargetProfileId) {
      body.targetProfileId = selectedTargetProfileId;
    } else {
      body.target = {
        source: target.source,
        model: target.model,
        ...(target.source === "custom" ? { endpoint: target.endpoint } : {}),
        ...(target.apiKey ? { apiKey: target.apiKey } : {}),
        ...(target.customHeaders?.length ? { customHeaders: target.customHeaders } : {}),
        claimedModel: target.claimedModel || target.model,
      };
    }

    if (useCustomJudge) {
      if (selectedJudgeProfileId) {
        body.judgeProfileId = selectedJudgeProfileId;
      } else {
        body.judge = {
          source: judge.source,
          model: judge.model,
          ...(judge.endpoint ? { endpoint: judge.endpoint } : {}),
          ...(judge.apiKey ? { apiKey: judge.apiKey } : {}),
          ...(judge.customHeaders?.length ? { customHeaders: judge.customHeaders } : {}),
        };
      }
    } else {
      // Default: judge configuration mirrors target
      if (selectedTargetProfileId) {
        body.judgeProfileId = selectedTargetProfileId;
      } else {
        body.judge = {
          source: target.source,
          model: target.model,
          ...(target.source === "custom" ? { endpoint: target.endpoint } : {}),
          ...(target.apiKey ? { apiKey: target.apiKey } : {}),
          ...(target.customHeaders?.length ? { customHeaders: target.customHeaders } : {}),
        };
      }
    }

    isRunningRef.current = true;
    setIsRunning(true);

    try {
      const res = await fetch("/api/probe/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Probe start rejected with HTTP ${res.status}`);
      }

      const runId = res.headers.get("x-probe-run-id");
      if (runId) {
        setActiveRunId(runId);
        window.history.replaceState(null, "", `${window.location.pathname}?runId=${encodeURIComponent(runId)}`);
        fetchRuns();
        pollRunUntilDone(runId);
      }

      // Consume bounded SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (!part.trim()) continue;

          // Parse event name and data lines
          const lines = part.split(/\r?\n/);
          let eventName = "message";
          let dataText = "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataText += (dataText ? "\n" : "") + line.slice(5).trim();
            }
          }

          if (!dataText) continue;

          let parsed = null;
          try {
            parsed = JSON.parse(dataText);
          } catch {
            continue;
          }

          // Handle event types
          if (eventName === "error") {
            setRunError(parsed.error || "Probe stream error received");
            continue;
          }

          const msgType = eventName || parsed.type || parsed.event;

          if (msgType === "probe_start" || parsed.step === "probe_start") {
            const probeId = parsed.probeId || parsed.id;
            setActiveProbeId(probeId);
            updateProbeRecord({
              id: probeId,
              label: parsed.label,
              group: parsed.group,
              status: "running",
            });
          } else if (msgType === "probe_progress" || parsed.step === "probe_progress") {
            const probeId = parsed.probeId || parsed.id;
            updateProbeRecord({
              id: probeId,
              label: parsed.label,
              group: parsed.group,
              ttftMs: parsed.ttftMs,
              inputTokens: parsed.inputTokens,
              outputTokens: parsed.outputTokens,
            });
          } else if (msgType === "progress" && parsed.result && typeof parsed.result === "object") {
            // Sidecar protocol: each live event wraps the finished ProbeResult.
            applyProbeResult(parsed.result);
          } else if (msgType === "probe_result" || parsed.step === "probe_result") {
            applyProbeResult(parsed);
          } else if (
            msgType === "report" ||
            msgType === "done" ||
            msgType === "complete" ||
            parsed.score !== undefined
          ) {
            // Sidecar wraps the report: { runId, report: {...} }.
            const reportPayload = parsed.report && typeof parsed.report === "object" ? parsed.report : parsed;
            setReport(reportPayload);
            if (Array.isArray(reportPayload.results)) {
              for (const r of reportPayload.results) {
                applyProbeResult(r);
              }
            }
          }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setRunError(err.message || "Probe execution aborted");
      }
    } finally {
      isRunningRef.current = false;
      setIsRunning(false);
      setActiveRunId(null);
      setActiveProbeId(null);
      fetchRuns();
    }
  };

  const selectedProbe = probes.find((p) => p.id === selectedProbeId) || null;
  const activeProbe = probes.find((p) => p.id === activeProbeId) || null;

  return (
    <div className="space-y-6 max-w-7xl mx-auto px-4 sm:px-6 py-6">
      {/* Page Title & Breadcrumb */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-text-muted mb-1">
            <span>Diagnostics</span>
            <span>/</span>
            <span className="text-text-main font-medium">Model Probe</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-main">
            LLM Probe Diagnostic Suite
          </h1>
          <p className="text-sm text-text-muted mt-1 max-w-3xl">
            Deep integrity verification, prompt injection defense, SSE stream standard compliance, and model identity fingerprinting.
          </p>
        </div>
      </div>

      {/* Sidecar Health Strip */}
      <SidecarHealthStrip
        health={health}
        loading={healthLoading}
        onRefresh={fetchHealth}
      />

      {/* Persisted runs: probe page → run detail, mirroring BazaarLink's runId model. */}
      {runs.length > 0 && (
        <section className="rounded-[12px] border border-border bg-bg-elevated overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-text-main">Probe runs</h2>
              <p className="text-xs text-text-muted mt-0.5">Saved results survive refresh. Select a run to inspect live progress and evidence.</p>
            </div>
            <button
              type="button"
              onClick={fetchRuns}
              className="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
            >
              Refresh
            </button>
          </div>
          <div className="divide-y divide-border max-h-64 overflow-y-auto">
            {runs.map((run) => {
              const selected = viewingRun?.id === run.id;
              const total = run.totalProbes || 0;
              const percent = total > 0 ? Math.round((run.completedProbes / total) * 100) : 0;
              return (
                <button
                  key={run.id}
                  type="button"
                  onClick={async () => {
                    stopRunPolling();
                    setReport(null);
                    setProbes(pendingProbes(suiteTemplatesRef.current));
                    setSelectedProbeId(null);
                    window.history.replaceState(null, "", `${window.location.pathname}?runId=${encodeURIComponent(run.id)}`);
                    const loaded = await loadRun(run.id);
                    if (loaded?.status === "running") pollRunUntilDone(run.id);
                  }}
                  className={`w-full px-4 py-3 text-left hover:bg-bg-subtle transition-colors ${selected ? "bg-primary/5" : ""}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-text-main truncate">{run.targetModel || "Unknown model"}</div>
                      <div className="text-[11px] text-text-muted font-mono truncate">{run.id}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`text-xs font-semibold ${run.status === "running" ? "text-primary" : run.status === "complete" ? "text-emerald-600 dark:text-emerald-400" : "text-text-muted"}`}>
                        {run.status === "running" ? `${run.completedProbes}/${total || "?"} · ${percent}%` : run.status}
                      </div>
                      <div className="text-[11px] text-text-muted">{new Date(run.createdAt).toLocaleString()}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Global Run Error Banner */}
      {runError && (
        <div
          role="alert"
          className="p-4 rounded-[12px] bg-red-500/10 border border-red-500/30 text-xs text-red-600 dark:text-red-300 flex items-start gap-3"
        >
          <span className="material-symbols-outlined text-[20px] text-red-500 shrink-0">
            error
          </span>
          <div className="flex-1 space-y-1">
            <h4 className="font-semibold text-red-700 dark:text-red-200">
              Probe Execution Error
            </h4>
            <p className="font-mono">{runError}</p>
          </div>
          <button
            type="button"
            onClick={() => setRunError(null)}
            className="text-text-muted hover:text-text-main cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Config Card */}
      <ProbeConfigCard
        target={target}
        onTargetChange={setTarget}
        judge={judge}
        onJudgeChange={setJudge}
        useCustomJudge={useCustomJudge}
        onToggleCustomJudge={() => setUseCustomJudge((v) => !v)}
        profiles={profiles}
        selectedTargetProfileId={selectedTargetProfileId}
        selectedJudgeProfileId={selectedJudgeProfileId}
        onSelectTargetProfile={handleSelectTargetProfile}
        onSelectJudgeProfile={handleSelectJudgeProfile}
        onSaveProfile={handleSaveProfile}
        onDeleteProfile={handleDeleteProfile}
        targetCatalog={targetCatalog}
        judgeCatalog={judgeCatalog}
        onFetchModels={handleFetchModels}
        probeCount={suiteTemplates.length}
        isRunning={isRunning}
        isOffline={!health?.sidecar?.reachable}
        onStartRun={handleStartRun}
        onCancelRun={handleCancelRun}
      />

      {/* Signature 100-Check Probe Rail */}
      <ProbeRail
        probes={probes}
        suiteVersion={suiteVersion}
        activeProbeId={activeProbeId}
        selectedProbeId={selectedProbeId}
        onSelectProbe={(p) => setSelectedProbeId(p.id)}
      />

      {/* Check Inspector Panel */}
      <ProbeResultPanel
        activeProbe={activeProbe}
        selectedProbe={selectedProbe}
        elapsedSec={elapsedSec}
        isRunning={isRunning}
      />

      {/* Final Transient Report (visible when report received) */}
      {report && (
        <ProbeReportSummary
          report={report}
          results={probes.filter((p) => p.status && p.status !== "pending")}
          onSelectProbe={(p) => setSelectedProbeId(p.id)}
        />
      )}
    </div>
  );
}
