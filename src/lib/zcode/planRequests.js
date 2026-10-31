const REQUEST_INTERVAL_MS = 500;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_QUEUE_SIZE = 200;
const STATE_KEY = Symbol.for("9router.zcode.planRequests");

function abortError() {
  return new DOMException("Plan inspection cancelled", "AbortError");
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAtFromHeader(headers, now, fallbackMs) {
  const value = headers?.get?.("retry-after")?.trim();
  const timestamp = value && /^\d+(?:\.\d+)?$/.test(value)
    ? now + Number(value) * 1000
    : value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp >= now && timestamp <= 8.64e15
    ? Math.max(now + REQUEST_INTERVAL_MS, timestamp)
    : now + fallbackMs;
}

export function planCooldownError(retryAt, requestStarted = false) {
  const error = new Error(`Plan status unavailable: Z.AI requested a cooldown (HTTP 429). Try again after ${new Date(retryAt).toISOString()}.`);
  error.httpStatus = 429;
  error.retryAt = retryAt;
  error.requestStarted = requestStarted;
  return error;
}

export function planErrorDetails(error) {
  return {
    ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
    ...(Number.isFinite(error?.retryAt) ? { retryAt: error.retryAt } : {}),
  };
}

export function createPlanRequestCoordinator({
  intervalMs = REQUEST_INTERVAL_MS,
  fallbackMs = DEFAULT_COOLDOWN_MS,
  maxQueueSize = MAX_QUEUE_SIZE,
  now = () => Date.now(),
} = {}) {
  const queue = [];
  let running = false;
  let nextRequestAt = 0;
  let cooldownUntil = 0;

  const cooldown = () => cooldownUntil > now() ? cooldownUntil : null;
  const assertReady = () => {
    const retryAt = cooldown();
    if (retryAt) throw planCooldownError(retryAt);
  };

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          if (job.signal?.aborted) throw abortError();
          assertReady();
          const delay = nextRequestAt - now();
          if (delay > 0) await wait(delay, job.signal);
          if (job.signal?.aborted) throw abortError();
          assertReady();
          try {
            job.resolve(await job.task());
          } finally {
            nextRequestAt = now() + intervalMs;
          }
        } catch (error) {
          job.reject(error);
        } finally {
          job.cleanup();
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    cooldown,
    assertReady,
    observeResponse(response, endpoint) {
      if (response.status !== 429) return;
      const retryAt = retryAtFromHeader(response.headers, now(), fallbackMs);
      if (retryAt > cooldownUntil) {
        cooldownUntil = retryAt;
        console.warn("[Plan Management] cooldown: started", {
          endpoint, httpStatus: 429, retryAt,
        });
      }
      throw planCooldownError(cooldownUntil, true);
    },
    run(task, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(abortError());
      try { assertReady(); } catch (error) { return Promise.reject(error); }
      if (queue.length >= maxQueueSize) {
        return Promise.reject(new Error("Plan inspection queue is busy; wait for the current checks to finish"));
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const index = queue.indexOf(job);
          if (index < 0) return;
          queue.splice(index, 1);
          job.cleanup();
          reject(abortError());
        };
        const job = { task, signal, resolve, reject, cleanup: () => signal?.removeEventListener("abort", onAbort) };
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(job);
        void drain();
      });
    },
  };
}

export const planRequestCoordinator = globalThis[STATE_KEY] ||= createPlanRequestCoordinator();
