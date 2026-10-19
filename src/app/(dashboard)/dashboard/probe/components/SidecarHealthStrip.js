"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";

export default function SidecarHealthStrip({ health, loading, onRefresh, className }) {
  const isOk = health?.status === "ok";
  const isDegraded = health?.status === "degraded";
  const isOffline = !health || (!isOk && !isDegraded);

  const sidecarData = health?.sidecar?.data || {};
  const version = sidecarData?.version || sidecarData?.engineVersion || null;
  const sidecarUrl = health?.sidecar?.url || "http://127.0.0.1:20129";

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-[12px] bg-surface border border-border-subtle shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "size-2.5 rounded-full shrink-0 transition-colors",
                isOk && "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]",
                isDegraded && "bg-amber-500",
                isOffline && "bg-red-500"
              )}
              aria-hidden="true"
            />
            <span className="text-xs font-semibold text-text-main">
              {isOk ? "Probe Engine Online" : isDegraded ? "Probe Engine Degraded" : "Probe Engine Offline"}
            </span>
          </div>

          <div className="hidden sm:block h-3.5 w-px bg-border-subtle" />

          <a
            href="https://github.com/achmadsy/LLMprobe-engine"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-brand-500 transition-colors underline-offset-2 hover:underline"
            title="Open LLMprobe-engine repository"
          >
            <span className="font-mono font-medium">LLMprobe-engine</span>
            {version && <span className="font-mono text-text-subtle">({version})</span>}
            <span className="material-symbols-outlined text-[14px]">open_in_new</span>
          </a>

          <span className="hidden md:inline-block font-mono text-[11px] text-text-subtle truncate max-w-xs">
            {sidecarUrl}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isOffline && (
            <Badge variant="error" size="sm">
              Disabled
            </Badge>
          )}
          {isOk && (
            <Badge variant="success" size="sm" dot>
              Ready
            </Badge>
          )}
          <Button
            variant="ghost"
            size="xs"
            onClick={onRefresh}
            loading={loading}
            icon="refresh"
            title="Refresh engine health status"
          >
            Check
          </Button>
        </div>
      </div>

      {isOffline && (
        <div
          role="alert"
          className="flex items-start gap-3 p-3.5 rounded-[10px] bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-300"
        >
          <span className="material-symbols-outlined text-[18px] text-red-500 shrink-0 mt-0.5">
            warning
          </span>
          <div className="flex-1 space-y-1">
            <p className="font-semibold text-red-700 dark:text-red-200">
              Probe sidecar is currently unreachable at {sidecarUrl}
            </p>
            <p className="text-text-muted">
              The probe runner requires the LLMprobe-engine sidecar service. Run commands remain disabled until the service is active.
              Deploy or start the sidecar container or local binary, then click Check.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

SidecarHealthStrip.propTypes = {
  health: PropTypes.shape({
    status: PropTypes.string,
    sidecar: PropTypes.shape({
      reachable: PropTypes.bool,
      status: PropTypes.number,
      url: PropTypes.string,
      data: PropTypes.object,
      error: PropTypes.string,
    }),
  }),
  loading: PropTypes.bool,
  onRefresh: PropTypes.func.isRequired,
  className: PropTypes.string,
};
