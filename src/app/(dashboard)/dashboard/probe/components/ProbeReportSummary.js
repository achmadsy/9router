"use client";

import { useState, useMemo } from "react";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import { PROBE_CATEGORIES, STATUS_META, VERDICT_MAP, getProbeDisplayGroup } from "./probeConstants";

function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function ProbeReportSummary({
  report,
  results,
  onSelectProbe,
  className,
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const score = report?.score ?? 0;
  const scoreMax = report?.scoreMax ?? 100;
  const scorePercent = scoreMax > 0 ? Math.round((score / scoreMax) * 100) : 0;

  const identity = report?.identityAssessment || {};
  const verdictKey = identity.status || identity.verdict || "abstain";
  const verdictMeta = VERDICT_MAP[verdictKey] || VERDICT_MAP.abstain;
  const riskFlags = Array.isArray(identity.riskFlags) ? identity.riskFlags : [];

  // Aggregates
  const totalDurationMs = report?.completedAt && report?.startedAt
    ? new Date(report.completedAt) - new Date(report.startedAt)
    : results.reduce((acc, r) => acc + (r.durationMs || 0), 0);

  const totalInputTokens = report?.totalInputTokens ??
    results.reduce((acc, r) => acc + (r.inputTokens || 0), 0);

  const totalOutputTokens = report?.totalOutputTokens ??
    results.reduce((acc, r) => acc + (r.outputTokens || 0), 0);

  // Category statistics
  const categoryStats = useMemo(() => {
    return PROBE_CATEGORIES.map((cat) => {
      const items = results.filter((r) => getProbeDisplayGroup(r) === cat.id);
      const passed = items.filter((r) => r.status === "passed").length;
      const failed = items.filter((r) => r.status === "failed").length;
      const neutral = items.filter((r) => r.status === "neutral").length;
      const total = items.length;
      const rate = total > 0 && !cat.neutral ? Math.round((passed / total) * 100) : null;
      return {
        ...cat,
        total,
        passed,
        failed,
        neutral,
        rate,
      };
    });
  }, [results]);

  // Filtered rows for results table
  const filteredResults = useMemo(() => {
    return results.filter((r) => {
      if (groupFilter !== "all" && getProbeDisplayGroup(r) !== groupFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesId = r.id?.toLowerCase().includes(q);
        const matchesLabel = r.label?.toLowerCase().includes(q);
        const matchesReason = r.passReason?.toLowerCase().includes(q);
        if (!matchesId && !matchesLabel && !matchesReason) return false;
      }
      return true;
    });
  }, [results, groupFilter, statusFilter, searchQuery]);

  // Client-side JSON download
  const handleDownloadJson = () => {
    const payload = {
      ...report,
      exportedAt: new Date().toISOString(),
      results,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const modelTag = (report?.modelId || "model").replace(/[^a-zA-Z0-9_-]/g, "_");
    a.href = url;
    a.download = `probe-report-${modelTag}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className={cn("space-y-6", className)}>
      {/* Persistent report banner */}
      <div className="flex items-center justify-between gap-3 p-3.5 rounded-[12px] bg-brand-500/10 border border-brand-500/20 text-xs text-brand-700 dark:text-brand-300">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="material-symbols-outlined text-[20px] text-brand-500 shrink-0">
            history
          </span>
          <span className="truncate">
            <strong>Saved report:</strong> Results remain available after refresh from Probe runs.
          </span>
        </div>
        <Button
          variant="primary"
          size="xs"
          icon="download"
          onClick={handleDownloadJson}
        >
          Download JSON
        </Button>
      </div>

      {/* Top Score & Identity Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Endpoint Score Card */}
        <Card className="flex flex-col justify-between">
          <div>
            <span className="text-xs font-semibold text-text-subtle uppercase tracking-wider block font-mono">
              Endpoint Integrity Score
            </span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-4xl font-extrabold tracking-tight text-text-main font-mono">
                {score}
              </span>
              <span className="text-base text-text-muted font-mono font-medium">
                / {scoreMax}
              </span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-border-subtle flex items-center justify-between text-xs text-text-muted">
            <span>Pass compliance</span>
            <span className="font-mono font-semibold text-text-main">{scorePercent}%</span>
          </div>
        </Card>

        {/* Identity Assessment Card */}
        <Card className="flex flex-col justify-between md:col-span-2">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-text-subtle uppercase tracking-wider block font-mono">
                Model Identity Verdict
              </span>
              <Badge variant={verdictMeta.badgeVariant} size="md">
                {verdictMeta.label}
              </Badge>
            </div>

            <div className="space-y-1">
              <h4 className="text-base font-semibold text-text-main">
                {identity.predictedFamily
                  ? `Classified Family: ${identity.predictedFamily}`
                  : verdictMeta.label}
              </h4>
              <p className="text-xs text-text-muted">
                {verdictMeta.description}
              </p>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-border-subtle flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-3 font-mono text-text-muted">
              {identity.claimedModel && (
                <span>Claimed: <strong className="text-text-main">{identity.claimedModel}</strong></span>
              )}
              {typeof identity.confidence === "number" && (
                <span>Confidence: <strong className="text-text-main">{(identity.confidence * 100).toFixed(1)}%</strong></span>
              )}
            </div>
            {identity.status && (
              <span className="font-mono text-[11px] text-text-subtle">
                status: {identity.status}
              </span>
            )}
          </div>
        </Card>
      </div>

      {/* Risk Flags Banner (if detected) */}
      {riskFlags.length > 0 && (
        <div className="p-4 rounded-[12px] bg-red-500/10 border border-red-500/25 space-y-2">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
            <span className="material-symbols-outlined text-[20px] text-red-500">
              shield_with_heart
            </span>
            <h4 className="text-xs font-bold uppercase tracking-wider">
              Diagnostic Risk Flags Detected ({riskFlags.length})
            </h4>
          </div>
          <div className="flex flex-wrap gap-2">
            {riskFlags.map((flag, idx) => (
              <span
                key={idx}
                className="px-2.5 py-1 rounded-full text-xs font-mono font-semibold bg-red-500/20 text-red-700 dark:text-red-200 border border-red-500/30"
              >
                {flag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Resource & Duration Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3.5 rounded-[10px] bg-surface border border-border-subtle">
          <span className="text-[11px] text-text-subtle uppercase tracking-wider font-mono block">
            Suite Runtime
          </span>
          <span className="text-lg font-bold font-mono text-text-main mt-0.5 block">
            {formatDuration(totalDurationMs)}
          </span>
        </div>
        <div className="p-3.5 rounded-[10px] bg-surface border border-border-subtle">
          <span className="text-[11px] text-text-subtle uppercase tracking-wider font-mono block">
            Input Tokens
          </span>
          <span className="text-lg font-bold font-mono text-text-main mt-0.5 block">
            {totalInputTokens.toLocaleString()}
          </span>
        </div>
        <div className="p-3.5 rounded-[10px] bg-surface border border-border-subtle">
          <span className="text-[11px] text-text-subtle uppercase tracking-wider font-mono block">
            Output Tokens
          </span>
          <span className="text-lg font-bold font-mono text-text-main mt-0.5 block">
            {totalOutputTokens.toLocaleString()}
          </span>
        </div>
        <div className="p-3.5 rounded-[10px] bg-surface border border-border-subtle">
          <span className="text-[11px] text-text-subtle uppercase tracking-wider font-mono block">
            Checks Executed
          </span>
          <span className="text-lg font-bold font-mono text-text-main mt-0.5 block">
            {results.length}
          </span>
        </div>
      </div>

      {/* Category Summary Grid */}
      <Card
        title="Category Breakdown"
        subtitle="Evaluation score and completion rate across 7 engine probe groups"
        icon="donut_small"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {categoryStats.map((cat) => (
            <div
              key={cat.id}
              className="p-3 rounded-[10px] bg-bg border border-border-subtle space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span
                    className="size-2 rounded-full shrink-0"
                    style={{ backgroundColor: cat.color }}
                    aria-hidden="true"
                  />
                  <span className="text-xs font-semibold text-text-main">
                    {cat.label}
                  </span>
                </div>
                {cat.rate !== null ? (
                  <span className="font-mono text-xs font-bold text-text-main">
                    {cat.rate}%
                  </span>
                ) : (
                  <span className="text-[10px] font-mono text-text-subtle">
                    Evidence
                  </span>
                )}
              </div>

              <div className="w-full h-1 rounded-full bg-surface-3 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${cat.rate !== null ? cat.rate : 100}%`,
                    backgroundColor: cat.color,
                  }}
                />
              </div>

              <div className="flex items-center justify-between text-[10px] font-mono text-text-muted">
                <span>Total: {cat.total}</span>
                <span className="flex items-center gap-1.5">
                  {cat.passed > 0 && <span className="text-emerald-500">+{cat.passed}</span>}
                  {cat.failed > 0 && <span className="text-red-500">-{cat.failed}</span>}
                  {cat.neutral > 0 && <span className="text-purple-500">~{cat.neutral}</span>}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Full Results Table */}
      <Card
        title="Comprehensive Check Log"
        subtitle="Individual probe test records, timings, and verification results"
        icon="table_rows"
      >
        {/* Filter controls */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-4">
          <div className="flex-1 max-w-sm">
            <Input
              placeholder="Search checks by ID, name, or verdict..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              icon="search"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              className="py-1.5 px-3 text-xs bg-surface-2 border border-border-subtle rounded-[8px] text-text-main font-medium focus:outline-none"
            >
              <option value="all">All Groups</option>
              {PROBE_CATEGORIES.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.label}
                </option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="py-1.5 px-3 text-xs bg-surface-2 border border-border-subtle rounded-[8px] text-text-main font-medium focus:outline-none"
            >
              <option value="all">All Statuses</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="neutral">Neutral Evidence</option>
              <option value="error">Error</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto custom-scrollbar border border-border-subtle rounded-[10px]">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-surface-2 text-text-muted font-semibold border-b border-border-subtle font-mono uppercase text-[10px] tracking-wider">
                <th className="py-2.5 px-3">Check</th>
                <th className="py-2.5 px-3">Group</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3">Duration</th>
                <th className="py-2.5 px-3">TTFT</th>
                <th className="py-2.5 px-3">Tokens</th>
                <th className="py-2.5 px-3 text-right">Inspect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {filteredResults.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-text-muted">
                    No probe records matched the active filter.
                  </td>
                </tr>
              ) : (
                filteredResults.map((row) => {
                  const status = row.status || "pending";
                  const meta = STATUS_META[status] || STATUS_META.pending;

                  return (
                    <tr
                      key={row.id}
                      onClick={() => onSelectProbe(row)}
                      className="hover:bg-surface-2/60 transition-colors cursor-pointer group"
                    >
                      <td className="py-2.5 px-3 font-medium text-text-main">
                        <div>{row.label || row.id}</div>
                        <div className="font-mono text-[10px] text-text-subtle">{row.id}</div>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="capitalize text-text-muted font-medium">
                          {getProbeDisplayGroup(row)}
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold",
                            meta.bgClass,
                            meta.textClass
                          )}
                        >
                          <span className="material-symbols-outlined text-[12px]">
                            {meta.icon}
                          </span>
                          {meta.label}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-text-muted">
                        {row.durationMs ? `${row.durationMs}ms` : "—"}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-text-muted">
                        {row.ttftMs ? `${row.ttftMs}ms` : "—"}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-text-muted">
                        {typeof row.inputTokens === "number" ? row.inputTokens : "—"} /{" "}
                        {typeof row.outputTokens === "number" ? row.outputTokens : "—"}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <span className="material-symbols-outlined text-[16px] text-text-subtle group-hover:text-brand-500 transition-colors">
                          chevron_right
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

ProbeReportSummary.propTypes = {
  report: PropTypes.shape({
    baseUrl: PropTypes.string,
    modelId: PropTypes.string,
    score: PropTypes.number,
    scoreMax: PropTypes.number,
    startedAt: PropTypes.string,
    completedAt: PropTypes.string,
    totalInputTokens: PropTypes.number,
    totalOutputTokens: PropTypes.number,
    identityAssessment: PropTypes.shape({
      status: PropTypes.string,
      verdict: PropTypes.string,
      confidence: PropTypes.number,
      claimedModel: PropTypes.string,
      predictedFamily: PropTypes.string,
      predictedCandidates: PropTypes.array,
      riskFlags: PropTypes.array,
      evidence: PropTypes.array,
    }),
  }),
  results: PropTypes.arrayOf(PropTypes.object).isRequired,
  onSelectProbe: PropTypes.func.isRequired,
  className: PropTypes.string,
};
