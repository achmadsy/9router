import { finishActiveRun } from "./activeRun.js";
import { appendProbeRunResults, finishProbeRun } from "@/lib/db/repos/probeRunsRepo.js";

export const MAX_EVENT_BYTES = 64 * 1024; // 64 KB per SSE event
export const MAX_ERROR_CHARS = 500; // 500 characters max error message
export const MAX_STREAM_BYTES = 10 * 1024 * 1024; // 10 MB total

export function boundErrorMessage(msg) {
  if (!msg) return "Unknown error";
  const str = String(msg).trim();
  if (str.length <= MAX_ERROR_CHARS) return str;
  return str.slice(0, MAX_ERROR_CHARS) + "... [truncated]";
}

/**
 * Parse one complete SSE event ("event: x\ndata: {...}") and persist run state.
 * DB writes are fire-and-forget: streaming must never block on storage, and
 * progress rows are idempotent (keyed by probeId) so a missed write is healed
 * by the next event or the final report.
 */
async function persistSseEvent(runId, eventName, dataText) {
  let parsed = null;
  try { parsed = JSON.parse(dataText); } catch {
    // Sidecar bounds SSE data at 32 KiB; a large final report can be truncated
    // into invalid JSON. All result rows were already persisted from progress
    // events, so the complete event name alone is enough to close the run.
    if (eventName === "complete") await finishProbeRun(runId, "complete");
    return;
  }
  if (!parsed || typeof parsed !== "object") return;

  if (eventName === "progress" && parsed.result && typeof parsed.result === "object") {
    await appendProbeRunResults(runId, [parsed.result], parsed.total ?? null);
  } else if (eventName === "complete" && parsed.report) {
    // Persist score/identity metadata separately from result rows so the
    // verdict card survives refresh; truncated JSON still closes the run.
    await finishProbeRun(
      runId,
      "complete",
      Array.isArray(parsed.report.results) ? parsed.report.results : [],
      parsed.report,
    );
  } else if (eventName === "canceled") {
    await finishProbeRun(runId, "canceled");
  } else if (eventName === "error") {
    await finishProbeRun(runId, "error");
  }
}

/**
 * Creates a TransformStream that bounds SSE events and optionally owns run
 * lifecycle cleanup. A detached persistence branch owns lifecycle; the browser
 * branch does not, so refreshing the page never cancels or frees a live run.
 */
export function createBoundedSseStream(
  runId,
  { persist = false, manageLifecycle = true } = {},
) {
  let buffer = "";
  let totalBytes = 0;
  let terminated = false;
  let persistQueue = Promise.resolve();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const transform = new TransformStream({
    transform(chunk, controller) {
      if (terminated) return;

      totalBytes += chunk.byteLength || chunk.length || 0;
      if (totalBytes > MAX_STREAM_BYTES) {
        terminated = true;
        const errEvent = `event: error\ndata: ${JSON.stringify({
          error: "Stream size limit exceeded (10MB)",
        })}\n\n`;
        controller.enqueue(encoder.encode(errEvent));
        controller.terminate();
        if (manageLifecycle) finishActiveRun(runId);
        return;
      }

      buffer += decoder.decode(chunk, { stream: true });

      // Split on SSE event boundary (\n\n or \r\n\r\n)
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || ""; // last piece might be incomplete

      // Guard against an event growing unbounded across chunks
      if (buffer.length > MAX_EVENT_BYTES) {
        terminated = true;
        const errEvent = `event: error\ndata: ${JSON.stringify({
          error: "Single SSE event size exceeded 64KB limit",
        })}\n\n`;
        controller.enqueue(encoder.encode(errEvent));
        controller.terminate();
        if (manageLifecycle) finishActiveRun(runId);
        return;
      }

      for (const part of parts) {
        if (!part.trim()) continue;
        if (part.length > MAX_EVENT_BYTES) {
          terminated = true;
          const errEvent = `event: error\ndata: ${JSON.stringify({
            error: "Single SSE event size exceeded 64KB limit",
          })}\n\n`;
          controller.enqueue(encoder.encode(errEvent));
          controller.terminate();
          if (manageLifecycle) finishActiveRun(runId);
          return;
        }

        if (persist) {
          let eventName = "message";
          const dataLines = [];
          for (const line of part.split(/\r?\n/)) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length > 0) {
            persistQueue = persistQueue
              .then(() => persistSseEvent(runId, eventName, dataLines.join("\n")))
              .catch(() => {});
          }
        }

        controller.enqueue(encoder.encode(`${part}\n\n`));
      }
    },
    async flush(controller) {
      if (!terminated && buffer.trim()) {
        if (buffer.length <= MAX_EVENT_BYTES) {
          controller.enqueue(encoder.encode(`${buffer}\n\n`));
        }
      }
      await persistQueue;
      if (manageLifecycle) finishActiveRun(runId);
    },
    // Sidecar crashed / socket dropped mid-stream: flush() never runs on an
    // errored or cancelled transform, so release the active-run slot here or
    // every later run would 409 until process restart.
    cancel() {
      if (manageLifecycle) finishActiveRun(runId);
    },
  });

  return transform;
}
