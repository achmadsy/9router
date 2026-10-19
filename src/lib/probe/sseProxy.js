import { finishActiveRun } from "./activeRun.js";

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
 * Creates a TransformStream that bounds SSE events and ensures cleanup on finish/abort.
 */
export function createBoundedSseStream(runId) {
  let buffer = "";
  let totalBytes = 0;
  let terminated = false;
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
        finishActiveRun(runId);
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
        finishActiveRun(runId);
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
          finishActiveRun(runId);
          return;
        }

        controller.enqueue(encoder.encode(`${part}\n\n`));
      }
    },
    flush(controller) {
      if (!terminated && buffer.trim()) {
        if (buffer.length <= MAX_EVENT_BYTES) {
          controller.enqueue(encoder.encode(`${buffer}\n\n`));
        }
      }
      finishActiveRun(runId);
    },
    // Sidecar crashed / socket dropped mid-stream: flush() never runs on an
    // errored or cancelled transform, so release the active-run slot here or
    // every later run would 409 until process restart.
    cancel() {
      finishActiveRun(runId);
    },
  });

  return transform;
}
