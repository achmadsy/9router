"use client";

import { useId, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import Modal from "@/shared/components/Modal";
import SegmentedControl from "@/shared/components/SegmentedControl";

const SOURCE_OPTIONS = [
  { value: "this_9router", label: "This 9Router", icon: "hub" },
  { value: "custom", label: "Custom endpoint", icon: "public" },
];

function EndpointFields({
  kind,
  value,
  onChange,
  catalog,
  catalogLoading,
  catalogError,
  onFetchModels,
  disabled,
  profileSelected,
}) {
  const [showKey, setShowKey] = useState(false);
  const [showHeaderValues, setShowHeaderValues] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  const listId = useId();
  const isSelf = value.source === "this_9router";

  const update = (patch) => onChange({ ...value, ...patch });
  const customHeaders = Array.isArray(value.customHeaders) ? value.customHeaders : [];
  const updateHeader = (index, patch) => {
    update({
      customHeaders: customHeaders.map((header, currentIndex) =>
        currentIndex === index ? { ...header, ...patch } : header
      ),
    });
  };
  const addHeader = () => {
    if (customHeaders.length < 16) {
      update({ customHeaders: [...customHeaders, { name: "", value: "" }] });
    }
  };
  const removeHeader = (index) => {
    update({ customHeaders: customHeaders.filter((_, currentIndex) => currentIndex !== index) });
  };
  const changeSource = (source) => {
    if (source !== value.source) {
      update({ source, endpoint: source === "custom" ? "" : value.endpoint });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text-main">Source</span>
        <SegmentedControl
          options={SOURCE_OPTIONS}
          value={value.source}
          onChange={changeSource}
          size="sm"
          className="self-start"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          label={`${kind} Endpoint URL`}
          placeholder="https://api.example.com/v1"
          value={value.endpoint}
          onChange={(event) => update({ endpoint: event.target.value })}
          disabled={disabled || profileSelected || isSelf}
          icon="dns"
          hint={isSelf ? "Current 9Router /v1 gateway. Server resolves its trusted URL." : "Public OpenAI-compatible base URL."}
          required={!isSelf}
        />

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-main">
            {kind} API Key {profileSelected ? "(stored in profile)" : ""}
          </label>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              placeholder={profileSelected ? "••••••••••••••••" : "sk-... or gateway key"}
              value={profileSelected ? "" : value.apiKey}
              onChange={(event) => update({ apiKey: event.target.value })}
              disabled={disabled || profileSelected}
              autoComplete="off"
              spellCheck="false"
              className="w-full py-2.5 pl-9 pr-10 text-sm text-text-main bg-surface-2 rounded-[10px] border border-transparent placeholder-text-muted/70 focus:outline-none focus:ring-2 focus:ring-brand-500/30 font-mono disabled:opacity-50"
            />
            <span className="material-symbols-outlined absolute left-3 top-2.5 text-[18px] text-text-muted pointer-events-none">key</span>
            {!profileSelected && (
              <button
                type="button"
                onClick={() => setShowKey((visible) => !visible)}
                className="absolute right-2.5 top-2.5 text-text-muted hover:text-text-main p-0.5 rounded cursor-pointer"
                title={showKey ? "Hide API key" : "Show API key"}
              >
                <span className="material-symbols-outlined text-[18px]">{showKey ? "visibility_off" : "visibility"}</span>
              </button>
            )}
          </div>
          <p className="text-[11px] text-text-subtle">Sent only to 9Router. Never returned by profile APIs.</p>
        </div>
      </div>

      <div className="rounded-[10px] border border-border-subtle bg-surface-2/40 p-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h5 className="text-sm font-medium text-text-main">Additional headers</h5>
            <p className="text-[11px] text-text-subtle">
              Sent to upstream gateway for model discovery and probes. Authorization and connection headers are blocked.
            </p>
          </div>
          {!profileSelected && (
            <div className="flex items-center gap-1">
              {customHeaders.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHeaderValues((visible) => !visible)}
                  disabled={disabled}
                  className="p-1.5 rounded-[7px] text-text-muted hover:text-text-main hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                  title={showHeaderValues ? "Hide header values" : "Show header values"}
                  aria-label={showHeaderValues ? "Hide header values" : "Show header values"}
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {showHeaderValues ? "visibility_off" : "visibility"}
                  </span>
                </button>
              )}
              <Button
                variant="outline"
                size="xs"
                icon="add"
                disabled={disabled || customHeaders.length >= 16}
                onClick={addHeader}
              >
                Add header
              </Button>
            </div>
          )}
        </div>

        {profileSelected ? (
          <div className="flex items-center gap-2 py-2 text-xs text-text-muted">
            <span className="material-symbols-outlined text-[17px]">lock</span>
            Header values stay encrypted in profile and are never returned to browser.
          </div>
        ) : customHeaders.length ? (
          <div className="space-y-2">
            {customHeaders.map((header, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] gap-2 items-center">
                <input
                  type="text"
                  placeholder="Header name"
                  value={header.name}
                  onChange={(event) => updateHeader(index, { name: event.target.value })}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck="false"
                  aria-label={`${kind} additional header ${index + 1} name`}
                  className="w-full py-2 px-3 text-[16px] sm:text-xs font-mono text-text-main bg-surface border border-border-subtle rounded-[8px] focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50"
                />
                <input
                  type={showHeaderValues ? "text" : "password"}
                  placeholder="Header value"
                  value={header.value}
                  onChange={(event) => updateHeader(index, { value: event.target.value })}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck="false"
                  aria-label={`${kind} additional header ${index + 1} value`}
                  className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1 w-full py-2 px-3 text-[16px] sm:text-xs font-mono text-text-main bg-surface border border-border-subtle rounded-[8px] focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => removeHeader(index)}
                  disabled={disabled}
                  className="col-start-2 row-span-2 row-start-1 sm:col-start-3 sm:row-span-1 p-2 rounded-[8px] text-text-muted hover:text-red-500 hover:bg-red-500/10 disabled:opacity-50 cursor-pointer"
                  title="Remove header"
                  aria-label={`Remove ${kind} additional header ${index + 1}`}
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={addHeader}
            disabled={disabled}
            className="w-full py-2.5 rounded-[8px] border border-dashed border-border text-xs text-text-muted hover:text-text-main hover:border-brand-500/50 disabled:opacity-50 cursor-pointer"
          >
            Add User-Agent or another required gateway header
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-sm font-medium text-text-main">
            {kind} Model <span className="text-red-500">*</span>
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCustomModel((current) => !current)}
              className="text-[11px] text-brand-500 hover:underline cursor-pointer"
            >
              {customModel ? "Pick from catalog" : "Enter custom model ID"}
            </button>
            <Button
              variant="outline"
              size="xs"
              icon="refresh"
              loading={catalogLoading}
              disabled={disabled || profileSelected || catalogLoading || (!isSelf && !value.endpoint)}
              onClick={onFetchModels}
            >
              Fetch models
            </Button>
          </div>
        </div>

        {customModel ? (
          <Input
            placeholder="Enter exact model ID"
            value={value.model}
            onChange={(event) => update({ model: event.target.value })}
            disabled={disabled || profileSelected}
            icon="memory"
          />
        ) : (
          <>
            <input
              list={listId}
              placeholder={catalog.length ? "Search or select fetched model" : "Fetch models to populate catalog"}
              value={value.model}
              onChange={(event) => update({ model: event.target.value })}
              disabled={disabled || profileSelected}
              className="w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 border border-transparent rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50"
            />
            <datalist id={listId}>
              {catalog.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
            </datalist>
          </>
        )}
        {catalogError ? (
          <p role="alert" className="text-xs text-red-500">{catalogError}</p>
        ) : (
          <p className="text-[11px] text-text-subtle">
            {catalog.length ? `${catalog.length} models fetched. Type to search.` : "Catalog remains empty until Fetch models succeeds; custom IDs always work."}
          </p>
        )}
      </div>
    </div>
  );
}

EndpointFields.propTypes = {
  kind: PropTypes.string.isRequired,
  value: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
  catalog: PropTypes.arrayOf(PropTypes.object).isRequired,
  catalogLoading: PropTypes.bool.isRequired,
  catalogError: PropTypes.string,
  onFetchModels: PropTypes.func.isRequired,
  disabled: PropTypes.bool.isRequired,
  profileSelected: PropTypes.bool.isRequired,
};

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
  targetCatalog,
  judgeCatalog,
  onFetchModels,
  probeCount,
  isRunning,
  isOffline,
  onStartRun,
  onCancelRun,
  className,
}) {
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileModalType, setProfileModalType] = useState("target");
  const [newProfileName, setNewProfileName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);

  const targetProfiles = profiles.filter((profile) => profile.type === "target");
  const judgeProfiles = profiles.filter((profile) => profile.type === "judge");

  const openSaveProfile = (type) => {
    setProfileModalType(type);
    setSaveError(null);
    const config = type === "target" ? target : judge;
    setNewProfileName(config.model ? `${config.model} (${type === "target" ? "Target" : "Judge"})` : `${type === "target" ? "Target" : "Judge"} Profile`);
    setProfileModalOpen(true);
  };

  const saveProfile = async () => {
    if (!newProfileName.trim()) return;
    setSavingProfile(true);
    setSaveError(null);
    try {
      await onSaveProfile({
        name: newProfileName.trim(),
        type: profileModalType,
        target: profileModalType === "target" ? target : undefined,
        judge: profileModalType === "judge" ? judge : undefined,
      });
      setProfileModalOpen(false);
      setNewProfileName("");
    } catch (error) {
      setSaveError(error.message || "Failed to save profile");
    } finally {
      setSavingProfile(false);
    }
  };

  const profileSelector = (type, selectedId, onSelect, items) => (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-end justify-between gap-3 p-3 rounded-[10px] bg-surface-2 border border-border-subtle">
      <div className="flex-1 min-w-0">
        <label className="text-xs font-semibold text-text-muted block mb-1">{type} profile (24h TTL)</label>
        <div className="flex items-center gap-2">
          <select
            value={selectedId || ""}
            onChange={(event) => onSelect(event.target.value || null)}
            disabled={isRunning}
            className="w-full py-1.5 px-3 text-xs bg-surface border border-border rounded-[8px] text-text-main"
          >
            <option value="">Custom / ad-hoc configuration</option>
            {items.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} {profile.model ? `[${profile.model}]` : ""}</option>)}
          </select>
          {selectedId && <Button variant="ghost" size="xs" icon="delete" disabled={isRunning} onClick={() => onDeleteProfile(selectedId)}>Delete</Button>}
        </div>
      </div>
      <Button
        variant="outline"
        size="xs"
        icon="bookmark_add"
        disabled={isRunning || !(type === "Target" ? target.model : judge.model)}
        onClick={() => openSaveProfile(type.toLowerCase())}
      >
        Save {type} Profile
      </Button>
    </div>
  );

  return (
    <Card
      title="Probe Configuration"
      subtitle="Configure target and optional judge for behavioral verification"
      icon="settings_input_component"
      className={className}
      action={<Badge variant={isRunning ? "warning" : "default"} dot={isRunning} size="sm">{isRunning ? "Run Active" : `Full Suite (${probeCount} probes)`}</Badge>}
    >
      <div className="space-y-6">
        {profileSelector("Target", selectedTargetProfileId, onSelectTargetProfile, targetProfiles)}
        <EndpointFields
          kind="Target"
          value={target}
          onChange={onTargetChange}
          catalog={targetCatalog.models}
          catalogLoading={targetCatalog.loading}
          catalogError={targetCatalog.error}
          onFetchModels={() => onFetchModels("target")}
          disabled={isRunning}
          profileSelected={Boolean(selectedTargetProfileId)}
        />

        <Input
          label="Claimed Model Identity"
          placeholder={target.model || "Defaults to target model"}
          value={target.claimedModel}
          onChange={(event) => onTargetChange({ ...target, claimedModel: event.target.value })}
          disabled={isRunning}
          icon="fingerprint"
          hint="Diagnostic baseline used to detect model spoofing and capability drift."
        />

        <div className="rounded-[12px] border border-border-subtle bg-bg p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-text-main">Judge configuration</h4>
              <p className="text-xs text-text-muted">Optional LLM judge for subjective grading. Otherwise target judges itself.</p>
            </div>
            <Button variant={useCustomJudge ? "secondary" : "outline"} size="xs" onClick={onToggleCustomJudge} disabled={isRunning}>
              {useCustomJudge ? "Use Target as Judge" : "Customize Judge"}
            </Button>
          </div>

          {useCustomJudge && (
            <div className="space-y-4 pt-2 border-t border-border-subtle">
              {profileSelector("Judge", selectedJudgeProfileId, onSelectJudgeProfile, judgeProfiles)}
              <EndpointFields
                kind="Judge"
                value={judge}
                onChange={onJudgeChange}
                catalog={judgeCatalog.models}
                catalogLoading={judgeCatalog.loading}
                catalogError={judgeCatalog.error}
                onFetchModels={() => onFetchModels("judge")}
                disabled={isRunning}
                profileSelected={Boolean(selectedJudgeProfileId)}
              />
            </div>
          )}
        </div>

        <div className="flex items-start gap-3 p-3.5 rounded-[10px] bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-300">
          <span className="material-symbols-outlined text-[18px] text-amber-500 shrink-0">toll</span>
          <div>
            <p className="font-semibold">Full Suite Resource Commitment Warning</p>
            <p className="text-text-muted">Runs about {probeCount} sequential LLM calls over several minutes. Verify quota first.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border-subtle">
          <span className="text-xs text-text-muted">Runs are saved automatically. Open any run to monitor progress and inspect results.</span>
          {isRunning ? (
            <Button variant="danger" size="md" icon="stop_circle" onClick={onCancelRun}>Cancel Probe Run</Button>
          ) : (
            <Button variant="primary" size="md" icon="play_arrow" disabled={isOffline || !target.model} onClick={() => setConfirmModalOpen(true)}>Start Probe Run</Button>
          )}
        </div>
      </div>

      <Modal
        isOpen={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
        title={`Save ${profileModalType === "target" ? "Target" : "Judge"} Profile`}
        size="sm"
        footer={<><Button variant="ghost" onClick={() => setProfileModalOpen(false)} disabled={savingProfile}>Cancel</Button><Button variant="primary" onClick={saveProfile} loading={savingProfile}>Save Profile (24h)</Button></>}
      >
        <div className="space-y-3">
          <p className="text-xs text-text-muted">Profiles store source, endpoint, model, and encrypted credentials for 24 hours.</p>
          <Input label="Profile Name" value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} error={saveError} required autoFocus />
        </div>
      </Modal>

      <Modal
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        title="Confirm Full Probe Suite Execution"
        size="md"
        footer={<><Button variant="ghost" onClick={() => setConfirmModalOpen(false)}>Cancel</Button><Button variant="primary" icon="rocket_launch" onClick={() => { setConfirmModalOpen(false); onStartRun(); }}>Confirm & Start Probes</Button></>}
      >
        <div className="space-y-3 text-sm text-text-muted">
          <p>You are about to launch an active behavioral audit.</p>
          <div className="p-3 rounded-[8px] bg-surface-2 font-mono text-xs text-text-main space-y-1">
            <div><span className="text-text-muted">Model:</span> {target.model}</div>
            <div><span className="text-text-muted">Source:</span> {target.source === "this_9router" ? "This 9Router" : target.endpoint}</div>
            {target.claimedModel && <div><span className="text-text-muted">Claimed:</span> {target.claimedModel}</div>}
          </div>
        </div>
      </Modal>
    </Card>
  );
}

ProbeConfigCard.propTypes = {
  target: PropTypes.object.isRequired,
  onTargetChange: PropTypes.func.isRequired,
  judge: PropTypes.object.isRequired,
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
  targetCatalog: PropTypes.object.isRequired,
  judgeCatalog: PropTypes.object.isRequired,
  onFetchModels: PropTypes.func.isRequired,
  probeCount: PropTypes.number.isRequired,
  isRunning: PropTypes.bool.isRequired,
  isOffline: PropTypes.bool.isRequired,
  onStartRun: PropTypes.func.isRequired,
  onCancelRun: PropTypes.func.isRequired,
  className: PropTypes.string,
};
