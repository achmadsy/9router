"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import { STATUS_META, CATEGORY_MAP, getProbeDisplayGroup } from "./probeConstants";

function formatMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export default function ProbeResultPanel({
  activeProbe,
  selectedProbe,
  elapsedSec,
  isRunning,
  asDrawerContent = false,
  className,
}) {
  const displayProbe = selectedProbe || activeProbe;
  const status = displayProbe?.status || "pending";
  const statusMeta = STATUS_META[status] || STATUS_META.pending;
  const categoryMeta = displayProbe ? CATEGORY_MAP[getProbeDisplayGroup(displayProbe)] : null;

  const body = displayProbe ? (
    <div className="space-y-4">
      {/* Probe Overview Banner */}
      <div className="p-3 rounded-[10px] bg-surface-2 border border-border-subtle flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-text-main">
              {displayProbe.label}
            </h4>
            {categoryMeta && (
              <Badge variant={categoryMeta.badgeVariant || "default"} size="sm">
                {categoryMeta.label}
              </Badge>
            )}
          </div>
          <p className="font-mono text-xs text-text-subtle mt-0.5">
            {displayProbe.id}
          </p>
        </div>

        {displayProbe.neutral && (
          <span className="text-[11px] font-medium text-purple-600 dark:text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded">
            Neutral Identity Evidence
          </span>
        )}
      </div>

      {/* About this probe */}
      {displayProbe.description && (
        <div className="space-y-1">
          <span className="font-semibold text-text-subtle text-[10px] uppercase font-mono block">About this probe</span>
          <p className="text-xs text-text-muted leading-relaxed">
            {displayProbe.description}
          </p>
        </div>
      )}

      {/* Question sent to the model */}
      {displayProbe.prompt && (
        <div className="space-y-1">
          <span className="font-semibold text-text-subtle text-[10px] uppercase font-mono block">Question</span>
          <pre className="p-3 rounded-[8px] bg-surface-2 border border-border-subtle text-[11px] font-mono text-text-main whitespace-pre-wrap break-words max-h-40 overflow-y-auto custom-scrollbar">
            {displayProbe.prompt}
          </pre>
        </div>
      )}

      {/* Expected / reference response */}
      {displayProbe.expected && (
        <div className="space-y-1">
          <span className="font-semibold text-text-subtle text-[10px] uppercase font-mono block">Expected</span>
          <pre className="p-3 rounded-[8px] bg-emerald-500/5 border border-emerald-500/20 text-[11px] font-mono text-text-main whitespace-pre-wrap break-words max-h-32 overflow-y-auto custom-scrollbar">
            {displayProbe.expected}
          </pre>
        </div>
      )}

      {/* Metric Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="p-2.5 rounded-[8px] bg-bg border border-border-subtle">
          <span className="text-text-subtle text-[10px] block uppercase font-mono">
            Duration
          </span>
          <span className="font-semibold font-mono text-text-main">
            {formatMs(displayProbe.durationMs)}
          </span>
        </div>
        <div className="p-2.5 rounded-[8px] bg-bg border border-border-subtle">
          <span className="text-text-subtle text-[10px] block uppercase font-mono">
            TTFT
          </span>
          <span className="font-semibold font-mono text-text-main">
            {formatMs(displayProbe.ttftMs)}
          </span>
        </div>
        <div className="p-2.5 rounded-[8px] bg-bg border border-border-subtle">
          <span className="text-text-subtle text-[10px] block uppercase font-mono">
            Tokens In/Out
          </span>
          <span className="font-semibold font-mono text-text-main">
            {typeof displayProbe.inputTokens === "number" ? displayProbe.inputTokens : "—"} /{" "}
            {typeof displayProbe.outputTokens === "number" ? displayProbe.outputTokens : "—"}
          </span>
        </div>
        <div className="p-2.5 rounded-[8px] bg-bg border border-border-subtle">
          <span className="text-text-subtle text-[10px] block uppercase font-mono">
            Speed
          </span>
          <span className="font-semibold font-mono text-text-main">
            {typeof displayProbe.tps === "number" ? `${displayProbe.tps.toFixed(1)} tps` : "—"}
          </span>
        </div>
      </div>

      {/* Pass Reason / Evaluation Result */}
      {displayProbe.passReason && (
        <div className="p-3 rounded-[8px] bg-bg border border-border-subtle text-xs space-y-1">
          <span className="font-semibold text-text-subtle text-[10px] uppercase font-mono block">
            Evaluation Verdict
          </span>
          <p className="text-text-main leading-relaxed">
            {displayProbe.passReason}
          </p>
        </div>
      )}

      {/* Error Message */}
      {displayProbe.error && (
        <div className="p-3 rounded-[8px] bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-300 space-y-1">
          <span className="font-semibold text-[10px] uppercase font-mono block text-red-700 dark:text-red-200">
            Check Error
          </span>
          <p className="font-mono text-[11px] break-words">
            {displayProbe.error}
          </p>
        </div>
      )}

      {/* Response Payload Preview */}
      {displayProbe.response && (
        <div className="space-y-1">
          <span className="font-semibold text-text-subtle text-[10px] uppercase font-mono block">
            Model Response
          </span>
          <pre className="p-3 rounded-[8px] bg-surface-2 border border-border-subtle text-[11px] font-mono text-text-main overflow-x-auto max-h-64 custom-scrollbar whitespace-pre-wrap break-words">
            {typeof displayProbe.response === "string"
              ? displayProbe.response
              : JSON.stringify(displayProbe.response, null, 2)}
          </pre>
        </div>
      )}
    </div>
  ) : (
    <div className="py-8 text-center text-text-muted space-y-2">
      <span className="material-symbols-outlined text-[32px] text-text-subtle">
        touch_app
      </span>
      <p className="text-xs">
        Select any check in the probe rail to view detailed latency, token metrics, and response evidence.
      </p>
    </div>
  );

  // Drawer content renders without the Card chrome (the Drawer supplies it).
  if (asDrawerContent) {
    return <div className={className}>{body}</div>;
  }

  return (
    <Card
      title="Check Inspector"
      subtitle={isRunning ? "Live execution stream" : "Inspect probe results & response snippets"}
      icon="troubleshoot"
      className={className}
      action={
        displayProbe ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold font-mono border",
              statusMeta.bgClass,
              statusMeta.borderClass,
              statusMeta.textClass
            )}
          >
            <span className="material-symbols-outlined text-[14px]">
              {statusMeta.icon}
            </span>
            {statusMeta.label}
          </span>
        ) : null
      }
    >
      {/* Live Active Strip (when running) */}
      {isRunning && activeProbe && (
        <div className="mb-4 p-3 rounded-[10px] bg-brand-500/10 border border-brand-500/30 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="material-symbols-outlined text-[18px] text-brand-500 animate-spin motion-reduce:animate-none">
              progress_activity
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-brand-600 dark:text-brand-400 uppercase tracking-wider">
                  Active Probe
                </span>
                <span className="text-xs font-semibold text-text-main truncate">
                  {activeProbe.label}
                </span>
              </div>
              <span className="font-mono text-[11px] text-text-muted">
                {activeProbe.id}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 font-mono text-xs">
            {typeof activeProbe.ttftMs === "number" && (
              <div className="text-right">
                <span className="text-text-subtle text-[10px] block">TTFT</span>
                <span className="font-semibold text-text-main">{formatMs(activeProbe.ttftMs)}</span>
              </div>
            )}
            <div className="text-right">
              <span className="text-text-subtle text-[10px] block">Elapsed</span>
              <span className="font-semibold text-brand-600 dark:text-brand-400">
                {elapsedSec.toFixed(1)}s
              </span>
            </div>
          </div>
        </div>
      )}

      {body}
    </Card>
  );
}

ProbeResultPanel.propTypes = {
  activeProbe: PropTypes.shape({
    id: PropTypes.string,
    label: PropTypes.string,
    group: PropTypes.string,
    status: PropTypes.string,
    durationMs: PropTypes.number,
    ttftMs: PropTypes.number,
    inputTokens: PropTypes.number,
    outputTokens: PropTypes.number,
    tps: PropTypes.number,
    passReason: PropTypes.string,
    error: PropTypes.string,
    response: PropTypes.any,
  }),
  selectedProbe: PropTypes.shape({
    id: PropTypes.string,
    label: PropTypes.string,
    group: PropTypes.string,
    description: PropTypes.string,
    prompt: PropTypes.string,
    expected: PropTypes.string,
    status: PropTypes.string,
    neutral: PropTypes.bool,
    durationMs: PropTypes.number,
    ttftMs: PropTypes.number,
    inputTokens: PropTypes.number,
    outputTokens: PropTypes.number,
    tps: PropTypes.number,
    passReason: PropTypes.string,
    error: PropTypes.string,
    response: PropTypes.any,
  }),
  elapsedSec: PropTypes.number.isRequired,
  isRunning: PropTypes.bool.isRequired,
  asDrawerContent: PropTypes.bool,
  className: PropTypes.string,
};
