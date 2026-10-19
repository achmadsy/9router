"use client";

import { useState, useId } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Select from "@/shared/components/Select";
import Badge from "@/shared/components/Badge";
import Modal from "@/shared/components/Modal";

export default function ProbeConfigCard({
  target,
  onTargetChange,
  judge,
  onJudgeChange,
  useCustomJudge,
  onToggleCustomJudge,
  profiles,
  selectedTargetProfileId,
  selectedJudgeProfileId,
  onSelectTargetProfile,
  onSelectJudgeProfile,
  onSaveProfile,
  onDeleteProfile,
  models,
  modelsLoading,
  isRunning,
  isOffline,
  onStartRun,
  onCancelRun,
  className,
}) {
  const [showTargetKey, setShowTargetKey] = useState(false);
  const [showJudgeKey, setShowJudgeKey] = useState(false);
  const [customModelMode, setCustomModelMode] = useState(false);

  // Profile save modal state
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileModalType, setProfileModalType] = useState("target");
  const [newProfileName, setNewProfileName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  // Run confirmation modal for cost warning
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);

  const targetUrlHintId = useId();
  const apiKeyHintId = useId();

  const targetProfiles = profiles.filter((p) => p.type === "target");
  const judgeProfiles = profiles.filter((p) => p.type === "judge");

  const modelOptions = models.map((m) => ({
    value: m.id,
    label: m.id,
  }));

  const handleOpenSaveProfile = (type) => {
    setProfileModalType(type);
    const defaultName = type === "target"
      ? (target.model ? `${target.model} (Target)` : "Target Profile")
      : (judge.model ? `${judge.model} (Judge)` : "Judge Profile");
    setNewProfileName(defaultName);
    setProfileModalOpen(true);
  };

  const handleConfirmSaveProfile = async () => {
    if (!newProfileName.trim()) return;
    setSavingProfile(true);
    try {
      await onSaveProfile({
        name: newProfileName.trim(),
        type: profileModalType,
        target: profileModalType === "target" ? target : undefined,
        judge: profileModalType === "judge" ? judge : undefined,
      });
      setProfileModalOpen(false);
      setNewProfileName("");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleTriggerRun = () => {
    setConfirmModalOpen(true);
  };

  const handleConfirmRun = () => {
    setConfirmModalOpen(false);
    onStartRun();
  };

  return (
    <Card
      title="Probe Configuration"
      subtitle="Configure target LLM endpoint for deep behavioral verification"
      icon="settings_input_component"
      className={className}
      action={
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Badge variant="warning" dot size="sm">
              Run Active
            </Badge>
          ) : (
            <Badge variant="default" size="sm">
              Full Suite (84+ probes)
            </Badge>
          )}
        </div>
      }
    >
      <div className="space-y-6">
        {/* Target Profile Selector */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-end justify-between gap-3 p-3 rounded-[10px] bg-surface-2 border border-border-subtle">
          <div className="flex-1 min-w-0">
            <label className="text-xs font-semibold text-text-muted uppercase tracking-wider block mb-1">
              Target Profile (24h TTL)
            </label>
            <div className="flex items-center gap-2">
              <select
                value={selectedTargetProfileId || ""}
                onChange={(e) => onSelectTargetProfile(e.target.value || null)}
                disabled={isRunning}
                className="w-full py-1.5 px-3 text-xs bg-surface border border-border rounded-[8px] text-text-main focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="">(Custom / Ad-hoc configuration)</option>
                {targetProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.model ? `[${p.model}]` : ""}
                  </option>
                ))}
              </select>
              {selectedTargetProfileId && (
                <Button
                  variant="ghost"
                  size="xs"
                  icon="delete"
                  disabled={isRunning}
                  onClick={() => onDeleteProfile(selectedTargetProfileId)}
                  title="Delete saved target profile"
                >
                  Delete
                </Button>
              )}
            </div>
          </div>
          <Button
            variant="outline"
            size="xs"
            icon="bookmark_add"
            disabled={isRunning || !target.endpoint || !target.model}
            onClick={() => handleOpenSaveProfile("target")}
          >
            Save Target Profile
          </Button>
        </div>

        {/* Target Parameters Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Target URL */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="target-endpoint" className="text-sm font-medium text-text-main">
              Target Endpoint URL <span className="text-red-500">*</span>
            </label>
            <Input
              id="target-endpoint"
              placeholder="http://localhost:20128/v1"
              value={target.endpoint}
              onChange={(e) => onTargetChange({ ...target, endpoint: e.target.value })}
              disabled={isRunning || Boolean(selectedTargetProfileId)}
              icon="dns"
              aria-describedby={targetUrlHintId}
            />
            <p id={targetUrlHintId} className="text-[11px] text-text-subtle">
              OpenAI-compatible base URL. Defaults to current 9Router /v1 gateway.
            </p>
          </div>

          {/* Target API Key (Masked) */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="target-api-key" className="text-sm font-medium text-text-main">
              Target API Key {selectedTargetProfileId ? "(stored in profile)" : ""}
            </label>
            <div className="relative">
              <input
                id="target-api-key"
                type={showTargetKey ? "text" : "password"}
                placeholder={selectedTargetProfileId ? "••••••••••••••••" : "sk-... or gateway key"}
                value={selectedTargetProfileId ? "" : target.apiKey}
                onChange={(e) => onTargetChange({ ...target, apiKey: e.target.value })}
                disabled={isRunning || Boolean(selectedTargetProfileId)}
                autoComplete="off"
                spellCheck="false"
                aria-describedby={apiKeyHintId}
                className="w-full py-2.5 pl-9 pr-10 text-sm text-text-main bg-surface-2 rounded-[10px] border border-transparent placeholder-text-muted/70 focus:outline-none focus:ring-2 focus:ring-brand-500/30 font-mono disabled:opacity-50"
              />
              <span className="material-symbols-outlined absolute left-3 top-2.5 text-[18px] text-text-muted pointer-events-none">
                key
              </span>
              {!selectedTargetProfileId && (
                <button
                  type="button"
                  onClick={() => setShowTargetKey((v) => !v)}
                  className="absolute right-2.5 top-2.5 text-text-muted hover:text-text-main p-0.5 rounded cursor-pointer"
                  title={showTargetKey ? "Hide API key" : "Show API key"}
                  tabIndex={-1}
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {showTargetKey ? "visibility_off" : "visibility"}
                  </span>
                </button>
              )}
            </div>
            <p id={apiKeyHintId} className="text-[11px] text-text-subtle">
              In-memory only. Never written to storage, logs, or URLs.
            </p>
          </div>

          {/* Target Model */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="target-model-select" className="text-sm font-medium text-text-main">
                Target Model <span className="text-red-500">*</span>
              </label>
              <button
                type="button"
                onClick={() => setCustomModelMode((v) => !v)}
                className="text-[11px] text-brand-500 hover:underline cursor-pointer"
              >
                {customModelMode ? "Pick from catalog" : "Enter custom model ID"}
              </button>
            </div>

            {customModelMode || modelOptions.length === 0 ? (
              <Input
                placeholder="e.g. gpt-4o, claude-3-5-sonnet, deepseek-chat"
                value={target.model}
                onChange={(e) => onTargetChange({ ...target, model: e.target.value })}
                disabled={isRunning || Boolean(selectedTargetProfileId)}
                icon="memory"
              />
            ) : (
              <Select
                id="target-model-select"
                options={modelOptions}
                value={target.model}
                onChange={(e) => onTargetChange({ ...target, model: e.target.value })}
                placeholder={modelsLoading ? "Loading models..." : "Select model from /v1/models"}
                disabled={isRunning || Boolean(selectedTargetProfileId) || modelsLoading}
              />
            )}
          </div>

          {/* Claimed Model */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="claimed-model-input" className="text-sm font-medium text-text-main">
              Claimed Model Identity
            </label>
            <Input
              id="claimed-model-input"
              placeholder={target.model || "e.g. gpt-4o (defaults to target model)"}
              value={target.claimedModel}
              onChange={(e) => onTargetChange({ ...target, claimedModel: e.target.value })}
              disabled={isRunning}
              icon="fingerprint"
            />
            <p className="text-[11px] text-text-subtle">
              Diagnostic baseline used to detect model spoofing and capability drift.
            </p>
          </div>
        </div>

        {/* Optional Custom Judge Section */}
        <div className="rounded-[12px] border border-border-subtle bg-bg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-text-muted">
                gavel
              </span>
              <div>
                <h4 className="text-xs font-semibold text-text-main uppercase tracking-wider">
                  Judge Configuration
                </h4>
                <p className="text-[11px] text-text-muted">
                  LLM judge grades subjective reasoning, refusal boundary, and exfiltration checks.
                </p>
              </div>
            </div>

            <Button
              variant={useCustomJudge ? "secondary" : "outline"}
              size="xs"
              onClick={onToggleCustomJudge}
              disabled={isRunning}
            >
              {useCustomJudge ? "Use Target as Judge" : "Customize Judge"}
            </Button>
          </div>

          {useCustomJudge ? (
            <div className="space-y-4 pt-2 border-t border-border-subtle">
              {/* Judge Profile Selector */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-end justify-between gap-3 p-2.5 rounded-[8px] bg-surface-2 border border-border-subtle">
                <div className="flex-1 min-w-0">
                  <label className="text-[11px] font-semibold text-text-muted uppercase tracking-wider block mb-1">
                    Judge Profile
                  </label>
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedJudgeProfileId || ""}
                      onChange={(e) => onSelectJudgeProfile(e.target.value || null)}
                      disabled={isRunning}
                      className="w-full py-1 px-2.5 text-xs bg-surface border border-border rounded-[6px] text-text-main"
                    >
                      <option value="">(Custom judge)</option>
                      {judgeProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} [{p.model}]
                        </option>
                      ))}
                    </select>
                    {selectedJudgeProfileId && (
                      <Button
                        variant="ghost"
                        size="xs"
                        icon="delete"
                        disabled={isRunning}
                        onClick={() => onDeleteProfile(selectedJudgeProfileId)}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  icon="bookmark_add"
                  disabled={isRunning || !judge.model}
                  onClick={() => handleOpenSaveProfile("judge")}
                >
                  Save Judge Profile
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Input
                  label="Judge Model"
                  placeholder="e.g. gpt-4o or claude-3-5-sonnet"
                  value={judge.model}
                  onChange={(e) => onJudgeChange({ ...judge, model: e.target.value })}
                  disabled={isRunning || Boolean(selectedJudgeProfileId)}
                  icon="smart_toy"
                />

                <Input
                  label="Judge Provider"
                  placeholder="openai, anthropic, or openrouter"
                  value={judge.provider}
                  onChange={(e) => onJudgeChange({ ...judge, provider: e.target.value })}
                  disabled={isRunning || Boolean(selectedJudgeProfileId)}
                  icon="hub"
                />

                <Input
                  label="Judge Endpoint (Optional)"
                  placeholder="Leave empty for provider default"
                  value={judge.endpoint}
                  onChange={(e) => onJudgeChange({ ...judge, endpoint: e.target.value })}
                  disabled={isRunning || Boolean(selectedJudgeProfileId)}
                  icon="link"
                />

                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-main">
                    Judge API Key
                  </label>
                  <div className="relative">
                    <input
                      type={showJudgeKey ? "text" : "password"}
                      placeholder="sk-..."
                      value={selectedJudgeProfileId ? "" : judge.apiKey}
                      onChange={(e) => onJudgeChange({ ...judge, apiKey: e.target.value })}
                      disabled={isRunning || Boolean(selectedJudgeProfileId)}
                      autoComplete="off"
                      className="w-full py-2.5 pl-3 pr-10 text-sm text-text-main bg-surface-2 rounded-[10px] border border-transparent font-mono disabled:opacity-50"
                    />
                    {!selectedJudgeProfileId && (
                      <button
                        type="button"
                        onClick={() => setShowJudgeKey((v) => !v)}
                        className="absolute right-2.5 top-2.5 text-text-muted hover:text-text-main p-0.5 rounded cursor-pointer"
                        tabIndex={-1}
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          {showJudgeKey ? "visibility_off" : "visibility"}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-text-muted italic">
              Target model will act as judge for self-grading and evaluation passes.
            </p>
          )}
        </div>

        {/* Cost & Quota Disclaimer */}
        <div className="flex items-start gap-3 p-3.5 rounded-[10px] bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-300">
          <span className="material-symbols-outlined text-[18px] text-amber-500 shrink-0 mt-0.5">
            toll
          </span>
          <div className="space-y-0.5">
            <p className="font-semibold text-amber-800 dark:text-amber-200">
              Full Suite Resource Commitment Warning
            </p>
            <p className="text-text-muted">
              Running the full probe suite executes ~84–100 sequential LLM calls and consumes input/output tokens over 2–5 minutes.
              Verify upstream quota and rate limits before executing.
            </p>
          </div>
        </div>

        {/* Run Controls */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border-subtle">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span className="material-symbols-outlined text-[16px]">info</span>
            <span>Suite results are transient and cleared on refresh.</span>
          </div>

          <div className="flex items-center gap-3">
            {isRunning ? (
              <Button
                variant="danger"
                size="md"
                icon="stop_circle"
                onClick={onCancelRun}
              >
                Cancel Probe Run
              </Button>
            ) : (
              <Button
                variant="primary"
                size="md"
                icon="play_arrow"
                disabled={isOffline || !target.endpoint || !target.model}
                onClick={handleTriggerRun}
              >
                Start Probe Run
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Profile Save Modal */}
      <Modal
        isOpen={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
        title={`Save ${profileModalType === "target" ? "Target" : "Judge"} Profile`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setProfileModalOpen(false)} disabled={savingProfile}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleConfirmSaveProfile} loading={savingProfile}>
              Save Profile (24h)
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-text-muted">
            Profiles store endpoint and encrypted credentials in local database with a 24-hour expiration TTL.
          </p>
          <Input
            label="Profile Name"
            placeholder="e.g. Production GPT-4o"
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.target.value)}
            required
            autoFocus
          />
        </div>
      </Modal>

      {/* Run Confirmation Modal */}
      <Modal
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        title="Confirm Full Probe Suite Execution"
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon="rocket_launch" onClick={handleConfirmRun}>
              Confirm & Start Probes
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-text-muted">
          <p>
            You are about to launch an active behavioral audit against:
          </p>
          <div className="p-3 rounded-[8px] bg-surface-2 font-mono text-xs text-text-main space-y-1">
            <div><span className="text-text-muted">Model:</span> {target.model}</div>
            <div><span className="text-text-muted">Endpoint:</span> {target.endpoint}</div>
            {target.claimedModel && <div><span className="text-text-muted">Claimed:</span> {target.claimedModel}</div>}
          </div>
          <p>
            This suite tests <strong>Quality</strong>, <strong>Security injection</strong>, <strong>Integrity & SSE</strong>, and <strong>Identity fingerprinting</strong> across ~84 tests.
          </p>
        </div>
      </Modal>
    </Card>
  );
}

ProbeConfigCard.propTypes = {
  target: PropTypes.shape({
    endpoint: PropTypes.string,
    apiKey: PropTypes.string,
    model: PropTypes.string,
    claimedModel: PropTypes.string,
    provider: PropTypes.string,
  }).isRequired,
  onTargetChange: PropTypes.func.isRequired,
  judge: PropTypes.shape({
    endpoint: PropTypes.string,
    apiKey: PropTypes.string,
    model: PropTypes.string,
    provider: PropTypes.string,
  }).isRequired,
  onJudgeChange: PropTypes.func.isRequired,
  useCustomJudge: PropTypes.bool.isRequired,
  onToggleCustomJudge: PropTypes.func.isRequired,
  profiles: PropTypes.arrayOf(PropTypes.object).isRequired,
  selectedTargetProfileId: PropTypes.string,
  selectedJudgeProfileId: PropTypes.string,
  onSelectTargetProfile: PropTypes.func.isRequired,
  onSelectJudgeProfile: PropTypes.func.isRequired,
  onSaveProfile: PropTypes.func.isRequired,
  onDeleteProfile: PropTypes.func.isRequired,
  models: PropTypes.arrayOf(PropTypes.object).isRequired,
  modelsLoading: PropTypes.bool.isRequired,
  isRunning: PropTypes.bool.isRequired,
  isOffline: PropTypes.bool.isRequired,
  onStartRun: PropTypes.func.isRequired,
  onCancelRun: PropTypes.func.isRequired,
  className: PropTypes.string,
};
