"use client";

import { useMemo } from "react";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { PROBE_CATEGORIES, STATUS_META, getProbeDisplayGroup } from "./probeConstants";

export default function ProbeRail({
  probes,
  suiteVersion,
  activeProbeId,
  selectedProbeId,
  onSelectProbe,
  className,
}) {
  // Group probes by category in engine order
  const groupedProbes = useMemo(() => {
    const map = new Map();
    for (const cat of PROBE_CATEGORIES) {
      map.set(cat.id, {
        category: cat,
        items: [],
      });
    }

    for (const probe of probes) {
      const groupKey = getProbeDisplayGroup(probe);
      const bucket = map.get(groupKey);
      if (bucket) {
        bucket.items.push(probe);
      } else {
        // Fallback bucket
        const qualityBucket = map.get("quality");
        if (qualityBucket) qualityBucket.items.push(probe);
      }
    }

    return Array.from(map.values());
  }, [probes]);

  // Overall counts
  const totalCount = probes.length;
  const completedCount = probes.filter((p) => p.status && p.status !== "pending" && p.status !== "running").length;
  const passedCount = probes.filter((p) => p.status === "passed").length;
  const failedCount = probes.filter((p) => p.status === "failed").length;
  const neutralCount = probes.filter((p) => p.status === "neutral").length;
  const errorCount = probes.filter((p) => p.status === "error").length;
  const percentComplete = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // Active probe text for screen reader aria-live
  const activeProbe = probes.find((p) => p.id === activeProbeId);

  return (
    <div
      className={cn(
        "rounded-[14px] bg-surface border border-border-subtle p-5 shadow-[var(--shadow-soft)] space-y-5",
        className
      )}
      role="region"
      aria-label="Probe rail checks"
    >
      {/* Header & Overall Metric */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border-subtle">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-brand-500">
              radar
            </span>
            <h3 className="text-base font-semibold text-text-main tracking-tight">
              {totalCount}-Check Probe Rail
            </h3>
            <span className="px-2 py-0.5 text-[11px] font-mono font-semibold rounded-full bg-surface-2 text-text-muted">
              {completedCount} / {totalCount} ({percentComplete}%)
            </span>
          </div>
          <p className="text-xs text-text-muted">
            Engine pipeline execution order{suiteVersion ? ` (${suiteVersion})` : ""}. Click any check to inspect payload and response.
          </p>
        </div>

        {/* Status count pills */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {passedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold font-mono">
              <span className="material-symbols-outlined text-[13px]">check_circle</span>
              {passedCount}
            </span>
          )}
          {failedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400 font-semibold font-mono">
              <span className="material-symbols-outlined text-[13px]">cancel</span>
              {failedCount}
            </span>
          )}
          {neutralCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 dark:text-purple-400 font-semibold font-mono">
              <span className="material-symbols-outlined text-[13px]">lens</span>
              {neutralCount}
            </span>
          )}
          {errorCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-semibold font-mono">
              <span className="material-symbols-outlined text-[13px]">error</span>
              {errorCount}
            </span>
          )}
        </div>
      </div>

      {/* Screen Reader Live Announcement */}
      <div className="sr-only" aria-live="polite">
        {activeProbe
          ? `Current probe: ${activeProbe.label} in group ${getProbeDisplayGroup(activeProbe)}`
          : `Probe rail: ${completedCount} of ${totalCount} completed.`}
      </div>

      {/* Overall Progress Bar */}
      <div className="space-y-1">
        <div className="w-full h-1.5 rounded-full bg-surface-3 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-brand-500 to-emerald-500 transition-all duration-300 ease-out"
            style={{ width: `${percentComplete}%` }}
          />
        </div>
      </div>

      {/* Category Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 pb-2 text-[11px] text-text-muted border-b border-border-subtle">
        <span className="font-semibold text-text-subtle uppercase tracking-wider text-[10px]">
          Groups:
        </span>
        {PROBE_CATEGORIES.map((cat) => (
          <div key={cat.id} className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full shrink-0"
              style={{ backgroundColor: cat.color }}
              aria-hidden="true"
            />
            <span className="font-medium text-text-main">{cat.label}</span>
            {cat.neutral && (
              <span className="text-[9px] text-text-subtle font-mono">(Evidence)</span>
            )}
          </div>
        ))}
      </div>

      {/* Grouped Rail Matrix */}
      <div className="space-y-4">
        {groupedProbes.map(({ category, items }) => {
          if (items.length === 0) return null;
          const groupCompleted = items.filter(
            (p) => p.status && p.status !== "pending" && p.status !== "running"
          ).length;

          return (
            <div key={category.id} className="space-y-2">
              {/* Group Title Strip */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-sm shrink-0"
                    style={{ backgroundColor: category.color }}
                    aria-hidden="true"
                  />
                  <span className="font-semibold text-text-main tracking-tight">
                    {category.label}
                  </span>
                  <span className="text-text-subtle font-mono text-[10px]">
                    ({groupCompleted}/{items.length})
                  </span>
                </div>
              </div>

              {/* Responsive Rail Strip */}
              <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-14 xl:grid-cols-19 gap-1.5">
                {items.map((probe) => {
                  const status = probe.status || "pending";
                  const meta = STATUS_META[status] || STATUS_META.pending;
                  const isRunning = status === "running" || probe.id === activeProbeId;
                  const isSelected = probe.id === selectedProbeId;

                  return (
                    <button
                      key={probe.id}
                      type="button"
                      tabIndex={0}
                      onClick={() => onSelectProbe(probe)}
                      aria-label={`${category.label}: ${probe.label} — ${meta.label}`}
                      title={`${probe.label} (${probe.id})\nStatus: ${meta.label}${
                        probe.durationMs ? `\nDuration: ${probe.durationMs}ms` : ""
                      }`}
                      className={cn(
                        "group relative flex items-center justify-center h-8 rounded-[7px] border transition-all cursor-pointer select-none",
                        "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 dark:focus:ring-offset-surface",
                        meta.bgClass,
                        meta.borderClass,
                        meta.textClass,
                        isSelected && "ring-2 ring-brand-500 ring-offset-1 font-bold shadow-sm",
                        isRunning && "ring-1 ring-brand-500 border-brand-500 animate-pulse motion-reduce:animate-none"
                      )}
                    >
                      {/* Icon glyph */}
                      <span
                        className={cn(
                          "material-symbols-outlined text-[15px] leading-none transition-transform group-hover:scale-110",
                          isRunning && "animate-spin motion-reduce:animate-none"
                        )}
                      >
                        {meta.icon}
                      </span>

                      {/* Small index or status indicator dot */}
                      {isSelected && (
                        <span
                          className="absolute -top-1 -right-1 size-2 rounded-full bg-brand-500 ring-1 ring-white dark:ring-surface"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

ProbeRail.propTypes = {
  suiteVersion: PropTypes.string,
  probes: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.string,
      group: PropTypes.string,
      status: PropTypes.string,
      durationMs: PropTypes.number,
      ttftMs: PropTypes.number,
      inputTokens: PropTypes.number,
      outputTokens: PropTypes.number,
    })
  ).isRequired,
  activeProbeId: PropTypes.string,
  selectedProbeId: PropTypes.string,
  onSelectProbe: PropTypes.func.isRequired,
  className: PropTypes.string,
};
