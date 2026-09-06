import { EventEmitter } from "events";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config.js";
import { captureException, captureMessage, matchesIssueKeyword, redactSensitiveText, scrubSensitiveData } from "@/lib/sentry.js";

const consoleLevels = ["log", "info", "warn", "error", "debug"];

if (!global._consoleLogBufferState) {
  global._consoleLogBufferState = {
    logs: [],
    patched: false,
    originals: {},
    emitter: new EventEmitter(),
  };
  global._consoleLogBufferState.emitter.setMaxListeners(50);
}

const state = global._consoleLogBufferState;

// Ensure emitter exists (handles hot reload with stale global)
if (!state.emitter) {
  state.emitter = new EventEmitter();
  state.emitter.setMaxListeners(50);
}

if (!state.pendingLines) state.pendingLines = [];
if (!state.flushTimer) state.flushTimer = null;

const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH_LINES = 50;

function flushPendingLines() {
  state.flushTimer = null;
  if (!state.pendingLines.length) return;

  const lines = state.pendingLines.splice(0, state.pendingLines.length);
  state.emitter.emit("lines", lines);
}

function scheduleFlush() {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(flushPendingLines, FLUSH_INTERVAL_MS);
  state.flushTimer?.unref?.();
}

function toLogLine(level, args) {
  return args.map(formatArg).join(" ");
}

// Strip ANSI escape codes so terminal colors don't bleed into UI
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, "");
}

function formatArg(arg) {
  let str;
  if (typeof arg === "string") str = stripAnsi(arg);
  else if (arg instanceof Error) str = stripAnsi(arg.stack || arg.message || String(arg));
  else {
    try {
      const scrubbed = typeof scrubSensitiveData === "function" ? scrubSensitiveData(arg) : arg;
      str = stripAnsi(JSON.stringify(scrubbed));
    } catch {
      str = stripAnsi(String(arg));
    }
  }
  return typeof redactSensitiveText === "function" ? redactSensitiveText(str) : str;
}

function appendLine(line) {
  state.logs.push(line);
  const maxLines = CONSOLE_LOG_CONFIG.maxLines;
  if (state.logs.length > maxLines) {
    state.logs = state.logs.slice(-maxLines);
  }
  state.pendingLines.push(line);
  if (state.pendingLines.length >= MAX_BATCH_LINES) {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    flushPendingLines();
  } else {
    scheduleFlush();
  }
}

export function initConsoleLogCapture() {
  if (state.patched) return;

  for (const level of consoleLevels) {
    state.originals[level] = console[level];
    console[level] = (...args) => {
      const line = toLogLine(level, args);
      appendLine(line);
      state.originals[level](...args);

      try {
        if (level === "error") {
          // Skip lines already handled by dedicated Sentry reporters (logger.js, zcode executor, etc.)
          if (!line.includes("❌ [") && !line.includes("✗ ERROR") && !line.includes("[ZCode Captcha]")) {
            const firstArg = args[0];
            if (firstArg instanceof Error) {
              captureException(firstArg, { tags: { source: "console.error" } });
            } else {
              captureMessage(line, "error", { tags: { source: "console.error" } });
            }
          }
        } else if (level === "warn") {
          if (!line.includes("⚠️  [") && !line.includes("[ZCode Captcha]")) {
            if (matchesIssueKeyword(line)) {
              captureMessage(line, "warning", { tags: { source: "console.warn" } });
            }
          }
        }
      } catch {
        // fail-open: console capture must never break application logging
      }
    };
  }

  state.patched = true;
}

export function getConsoleLogs() {
  return state.logs;
}

export function clearConsoleLogs() {
  state.logs = [];
  state.emitter.emit("clear");
}

export function getConsoleEmitter() {
  return state.emitter;
}
