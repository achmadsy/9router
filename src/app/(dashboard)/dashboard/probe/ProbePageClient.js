"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import SidecarHealthStrip from "./components/SidecarHealthStrip";
import ProbeConfigCard from "./components/ProbeConfigCard";
import { DEFAULT_PROBES } from "./components/probeConstants";

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

  // Suite templates drive probe count shown before starting a run.
  const [suiteTemplates, setSuiteTemplates] = useState(DEFAULT_PROBES);

  // Internal refs
  const abortControllerRef = useRef(null);
  const isRunningRef = useRef(false);

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
    if (runIdFromUrl) {
      window.location.replace(`/dashboard/probe/runs/${encodeURIComponent(runIdFromUrl)}`);
      return () => { ignore = true; };
    }

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
        setSuiteTemplates(templates);
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

    // Active Run check keeps the start button honest; open it from Probe > Runs.
    fetch("/api/probe/run")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!ignore && data?.active && data.run?.runId) {
          isRunningRef.current = true;
          setActiveRunId(data.run.runId);
          setIsRunning(true);
        }
      })
      .catch(() => {});

    return () => { ignore = true; };
  }, []);

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
  };

  // Start Probe Run
  const handleStartRun = async () => {
    setRunError(null);

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
      if (!runId) throw new Error("Probe server did not return a run id");

      // Server persistence owns the sidecar stream. Release this page's branch
      // and navigate to the dedicated run detail route, which polls stored live
      // progress and survives refresh/reconnect.
      await res.body?.cancel().catch(() => {});
      window.location.assign(`/dashboard/probe/runs/${encodeURIComponent(runId)}`);
      return;
    } catch (err) {
      if (err.name !== "AbortError") {
        setRunError(err.message || "Probe execution aborted");
      }
    } finally {
      isRunningRef.current = false;
      setIsRunning(false);
      setActiveRunId(null);
    }
  };

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
        targetCatalog={targetCatalog}
        judgeCatalog={judgeCatalog}
        onFetchModels={handleFetchModels}
        probeCount={suiteTemplates.length}
        isRunning={isRunning}
        isOffline={!health?.sidecar?.reachable}
        onStartRun={handleStartRun}
        onCancelRun={handleCancelRun}
      />

    </div>
  );
}
