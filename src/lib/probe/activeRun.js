let activeRun = null;

export function getActiveRun() {
  if (!activeRun) return null;
  return {
    runId: activeRun.runId,
    ownerId: activeRun.ownerId,
    startedAt: activeRun.startedAt,
  };
}

export function startActiveRun({ runId, ownerId, abortController }) {
  if (activeRun) {
    return {
      ok: false,
      status: 409,
      error: "A probe run is already in progress",
      activeRunId: activeRun.runId,
    };
  }

  activeRun = {
    runId,
    ownerId,
    startedAt: new Date().toISOString(),
    abortController,
  };

  return { ok: true, runId };
}

export function finishActiveRun(runId) {
  if (activeRun && activeRun.runId === runId) {
    activeRun = null;
  }
}

export function cancelActiveRun(runId, requesterId) {
  if (!activeRun) {
    return { ok: false, status: 404, error: "No active probe run" };
  }

  if (runId && activeRun.runId !== runId) {
    return { ok: false, status: 400, error: "Run ID mismatch" };
  }

  // Cancel ownership check: only the run owner or local CLI machine can cancel
  if (requesterId !== "cli:machine" && activeRun.ownerId !== requesterId) {
    return { ok: false, status: 403, error: "Forbidden: not the owner of this run" };
  }

  try {
    activeRun.abortController?.abort();
  } catch { /* best effort */ }

  const cancelledId = activeRun.runId;
  activeRun = null;

  return { ok: true, runId: cancelledId };
}

export function __testResetActiveRun() {
  activeRun = null;
}
