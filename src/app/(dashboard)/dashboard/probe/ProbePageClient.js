"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import SidecarHealthStrip from "./components/SidecarHealthStrip";
import ProbeConfigCard from "./components/ProbeConfigCard";
import ProbeRail from "./components/ProbeRail";
import ProbeResultPanel from "./components/ProbeResultPanel";
import ProbeReportSummary from "./components/ProbeReportSummary";
import { DEFAULT_PROBES } from "./components/probeConstants";

export default function ProbePageClient() {
  // Sidecar Health
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(true);

  // Models catalog from /v1/models
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  // Saved Profiles (24h TTL)
  const [profiles, setProfiles] = useState([]);
  const [selectedTargetProfileId, setSelectedTargetProfileId] = useState(null);
  const [selectedJudgeProfileId, setSelectedJudgeProfileId] = useState(null);

  // Target Configuration
  const [target, setTarget] = useState({
    endpoint: "",
    apiKey: "",
    model: "",
    claimedModel: "",
    provider: "openai",
  });

  // Optional Custom Judge Configuration
  const [useCustomJudge, setUseCustomJudge] = useState(false);
  const [judge, setJudge] = useState({
    endpoint: "",
    apiKey: "",
    model: "",
    provider: "openai",
  });

  // Run lifecycle state
  const [isRunning, setIsRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState(null);
  const [runError, setRunError] = useState(null);
  const [activeProbeId, setActiveProbeId] = useState(null);
  const [selectedProbeId, setSelectedProbeId] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Live Probes state (initialized with 84 default probes in engine order)
  const [probes, setProbes] = useState(() => DEFAULT_PROBES.map((p) => ({ ...p, status: "pending" })));

  // Final transient report
  const [report, setReport] = useState(null);

  // Internal refs
  const abortControllerRef = useRef(null);
  const timerRef = useRef(null);
  const startTimeRef = useRef(null);

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

    // Asynchronously set default target endpoint from window origin
    const timerId = setTimeout(() => {
      if (!ignore && typeof window !== "undefined") {
        const defaultEndpoint = `${window.location.origin}/v1`;
        setTarget((prev) => (prev.endpoint ? prev : { ...prev, endpoint: defaultEndpoint }));
      }
    }, 0);

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

    // Profiles
    fetch("/api/probe/profiles")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!ignore && data?.profiles) {
          setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
        }
      })
      .catch(() => {});

    // Models
    fetch("/v1/models")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!ignore && json?.data) {
          const list = Array.isArray(json.data) ? json.data : [];
          setModels(list);
          if (list.length > 0) {
            setTarget((prev) => (prev.model ? prev : { ...prev, model: list[0].id }));
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!ignore) setModelsLoading(false);
      });

    // Active Run check
    fetch("/api/probe/run")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!ignore && data?.active && data.run?.runId) {
          setActiveRunId(data.run.runId);
          setIsRunning(true);
        }
      })
      .catch(() => {});

    return () => {
      ignore = true;
      clearTimeout(timerId);
    };
  }, []);

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
      provider: src?.provider || "openai",
      model: src?.model || null,
      endpoint: src?.endpoint || null,
      secrets: src?.apiKey ? { apiKey: src.apiKey } : {},
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
        provider: found.provider || prev.provider,
        model: found.model || prev.model,
        endpoint: found.endpoint || prev.endpoint,
        apiKey: "", // Secrets remain encrypted on server
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
        provider: found.provider || prev.provider,
        model: found.model || prev.model,
        endpoint: found.endpoint || prev.endpoint,
        apiKey: "",
      }));
    }
  };

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

    setIsRunning(false);
    setActiveRunId(null);
    setActiveProbeId(null);
  };

  // Start Probe Run
  const handleStartRun = async () => {
    setRunError(null);
    setReport(null);

    // Reset probe rail to pending
    setProbes(DEFAULT_PROBES.map((p) => ({ ...p, status: "pending" })));

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
        provider: target.provider || "openai",
        model: target.model,
        endpoint: target.endpoint,
        ...(target.apiKey ? { apiKey: target.apiKey } : {}),
        claimedModel: target.claimedModel || target.model,
      };
    }

    if (useCustomJudge) {
      if (selectedJudgeProfileId) {
        body.judgeProfileId = selectedJudgeProfileId;
      } else {
        body.judge = {
          provider: judge.provider || "openai",
          model: judge.model,
          ...(judge.endpoint ? { endpoint: judge.endpoint } : {}),
          ...(judge.apiKey ? { apiKey: judge.apiKey } : {}),
        };
      }
    } else {
      // Default: judge configuration mirrors target
      if (selectedTargetProfileId) {
        body.judgeProfileId = selectedTargetProfileId;
      } else {
        body.judge = {
          provider: target.provider || "openai",
          model: target.model,
          endpoint: target.endpoint,
          ...(target.apiKey ? { apiKey: target.apiKey } : {}),
        };
      }
    }

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
      if (runId) setActiveRunId(runId);

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
          } else if (msgType === "probe_result" || parsed.step === "probe_result") {
            const probeId = parsed.probeId || parsed.id;
            let status = "neutral";
            if (parsed.status === "error") {
              status = "error";
            } else if (parsed.status === "skipped") {
              status = "skipped";
            } else if (typeof parsed.passed === "boolean") {
              status = parsed.passed ? "passed" : "failed";
            } else if (parsed.neutral) {
              status = "neutral";
            } else if (parsed.status) {
              status = parsed.status;
            }

            updateProbeRecord({
              id: probeId,
              label: parsed.label,
              group: parsed.group,
              neutral: Boolean(parsed.neutral),
              status,
              passed: parsed.passed,
              passReason: parsed.passReason,
              durationMs: parsed.durationMs,
              ttftMs: parsed.ttftMs,
              inputTokens: parsed.inputTokens,
              outputTokens: parsed.outputTokens,
              tps: parsed.tps,
              response: parsed.response,
              error: parsed.error,
            });
          } else if (
            msgType === "report" ||
            msgType === "done" ||
            msgType === "complete" ||
            parsed.score !== undefined
          ) {
            setReport(parsed);
            if (Array.isArray(parsed.results)) {
              for (const r of parsed.results) {
                const probeId = r.probeId || r.id;
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
                  id: probeId,
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
      setIsRunning(false);
      setActiveRunId(null);
      setActiveProbeId(null);
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
        models={models}
        modelsLoading={modelsLoading}
        isRunning={isRunning}
        isOffline={!health?.sidecar?.reachable}
        onStartRun={handleStartRun}
        onCancelRun={handleCancelRun}
      />

      {/* Signature 100-Check Probe Rail */}
      <ProbeRail
        probes={probes}
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
