"use client";

import { useEffect, useState } from "react";
import { Card, ConfirmModal, Tooltip } from "@/shared/components";
import useSettingsStore from "@/store/settingsStore";

// Accepts only what the settings API can legitimately return; anything else
// (missing key, unknown string, non-string) stays unknown rather than
// defaulting to a confident "off". Pure, so it lives at module scope.
function toClassifierMode(v) {
  return v === "auto" ? "auto" : v === "off" ? "off" : null;
}

/**
 * Client Settings — gateway-wide settings that affect how client CLI traffic is
 * served. These do NOT depend on any local CLI install, so they live here rather
 * than on a per-tool card under CLI Tools.
 *
 * ── Display invariant (read before editing) ──────────────────────────────────
 * This toggle controls a default-ALLOW security bypass, so the dangerous failure
 * is the UI displaying OFF while the server is actually AUTO.
 *
 * That invariant now rests on `useSettingsStore` rather than on this component's
 * own request handling. The store owns the rule and enforces it for every
 * consumer: a confirmed value is committed only from a completed read — never
 * from a PATCH response body — and a failed read leaves the value unknown rather
 * than stale. The gate below only has to not undermine it, which is why:
 *
 *   * the displayed mode is DERIVED from the store on every render, so there is
 *     no local copy that a click could set ahead of the server;
 *   * the read is forced, because a value served from the store's TTL cache
 *     could disagree with the server and this control must not assert it;
 *   * the toggle is disabled unless the mode is known AND no read/write is in
 *     flight, so no write can start before the first read lands, overlap another
 *     write, or run against a mode that failed to load.
 *
 * The amber "unknown" state is a real state: it means "the server's mode has not
 * been established", so the UI asserts nothing.
 */
export default function ClientSettingsClient() {
  const settings = useSettingsStore((s) => s.settings);
  const loading = useSettingsStore((s) => s.loading);
  const fetchSettings = useSettingsStore((s) => s.fetchSettings);
  const patchSettings = useSettingsStore((s) => s.patchSettings);

  // Derived, never stored: the only value that can be displayed is one the store
  // committed from a server read.
  const confirmed = toClassifierMode(settings?.claudeClassifierCompat);
  const modeKnown = confirmed !== null;

  const [failed, setFailed] = useState(false);
  // Local, because the store's `loading` covers reads as well as writes: it is
  // right for disabling the toggle but wrong for labelling what is happening.
  const [writing, setWriting] = useState(false);
  const [message, setMessage] = useState(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Forced on mount: a cached mode could be stale, and this is the control whose
  // staleness means understating an active bypass.
  useEffect(() => {
    let cancelled = false;
    fetchSettings({ force: true }).then((data) => {
      if (cancelled) return;
      // No usable mode means the server's state is genuinely unknown; say so
      // instead of leaving a bare disabled toggle with no explanation.
      if (toClassifierMode(data?.claudeClassifierCompat) === null) {
        setFailed(true);
        setMessage({
          type: "error",
          text: "Failed to read classifier compat: the server reported no usable mode.",
        });
      } else {
        setFailed(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchSettings]);

  const writeClassifierCompat = async (next) => {
    if (loading) return; // in-flight guard: ignore re-entrant clicks
    setMessage(null);
    setWriting(true);
    try {
      // The store PATCHes then reads back, so `confirmedSettings` is what the
      // server reports — not what was requested. A gate that shows the requested
      // mode on an unverified write is exactly how OFF gets displayed while the
      // server is AUTO.
      const confirmedSettings = await patchSettings({ claudeClassifierCompat: next });
      const mode = toClassifierMode(confirmedSettings?.claudeClassifierCompat);

      if (mode === null) {
        setFailed(true);
        setMessage({
          type: "error",
          text: "The server's mode could not be confirmed — retry, or reopen this page.",
        });
        return;
      }

      setFailed(false);
      if (mode === next) {
        setMessage({ type: "success", text: `Classifier compat set to ${mode === "auto" ? "AUTO" : "OFF"}` });
      } else {
        // Confirmed, but not what was asked for. This covers both a rejected
        // write (the server refused the value) and a write that silently did not
        // take. Either way the display shows the server's real value and the
        // discrepancy is reported rather than papered over as success.
        setMessage({
          type: "error",
          text: `The server did not apply ${next.toUpperCase()} — it still reports ${mode.toUpperCase()}.`,
        });
      }
    } catch (error) {
      setFailed(true);
      setMessage({
        type: "error",
        text: `Failed to set classifier compat (${error.message}). The server's mode could not be confirmed — reopen this page or retry.`,
      });
    } finally {
      // Cleared last: until this point the toggle stays disabled, so no click can
      // start a write while the outcome is still being established.
      setWriting(false);
    }
  };

  const handleClassifierCompatChange = (next) => {
    if (next === "auto") {
      setShowConfirmModal(true);
      return;
    }
    writeClassifierCompat(next);
  };

  // Disabled against a server-confirmed mode and never during a read or write.
  // This is what keeps the display honest: nothing can be written before the
  // first read, during another write, or once the mode has become unknown.
  const toggleDisabled = loading || !modeKnown;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">Claude Code auto mode</span>
                <Tooltip text="When AUTO, matched Claude Code auto-mode security-classifier requests receive a synthetic '<block>no</block>' reply without any upstream call — every classified action becomes ALLOW, and the upstream classifier never runs.">
                  <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                </Tooltip>
              </div>
              <p className="text-sm text-text-muted mt-1">
                Let Claude Code&apos;s auto mode run against this gateway. When AUTO, its
                safety-classifier requests are answered ALLOW locally instead of being
                routed upstream.
              </p>
            </div>
            <div
              className="flex w-fit rounded border border-border overflow-hidden shrink-0"
              role="group"
              aria-label="Claude classifier compat mode"
            >
              {["off", "auto"].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={confirmed === mode}
                  aria-label={`Classifier compat ${mode.toUpperCase()}`}
                  title={`Classifier compat ${mode.toUpperCase()}`}
                  onClick={() => handleClassifierCompatChange(mode)}
                  disabled={toggleDisabled}
                  className={`px-3 py-1.5 text-xs font-mono transition-colors ${
                    toggleDisabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"
                  } ${
                    confirmed === mode
                      ? "bg-primary text-white"
                      : "bg-transparent text-text-muted hover:bg-surface-2"
                  }`}
                >
                  {mode.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {writing && (
            <span
              className="w-fit rounded bg-primary/10 px-2 py-1 text-xs font-semibold text-primary"
              role="status"
            >
              Applying… waiting for the server to confirm
            </span>
          )}

          {/* `failed` rather than plain `!modeKnown`: on the first paint no read
              has run yet, and claiming the mode could not be established before
              the request is even sent would be false on every page load. */}
          {!modeKnown && !loading && failed && (
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="w-fit rounded bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-600"
                role="status"
              >
                Server mode not established — the toggle is disabled until it is.
              </span>
              {/* Recovery for BOTH unknown paths: a failed/timed-out read, and a
                  write whose outcome could not be confirmed. Without this the
                  unknown state would be a dead end requiring a page reload. */}
              <button
                type="button"
                onClick={() => fetchSettings({ force: true })}
                className="w-fit rounded border border-border px-2 py-1 text-xs font-semibold text-text-main hover:bg-surface-2 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {confirmed === "auto" && (
            <span
              className="w-fit rounded bg-red-500/10 px-2 py-1 text-xs font-semibold text-red-600"
              role="status"
            >
              AUTO — auto-mode actions are allowed through without upstream classification
            </span>
          )}

          {message && (
            <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
              <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
              <span>{message.text}</span>
            </div>
          )}
        </div>
      </Card>

      <ConfirmModal
        isOpen={showConfirmModal}
        onClose={() => setShowConfirmModal(false)}
        onConfirm={() => { setShowConfirmModal(false); writeClassifierCompat("auto"); }}
        title="Enable classifier compat (AUTO)?"
        message="Matched Claude Code auto-mode security-classifier requests will receive a synthetic '<block>no</block>' verdict without any upstream call — every classified action becomes ALLOW, and the upstream classifier never runs. Only enable this if you accept that security effect."
        confirmText="Enable AUTO"
        cancelText="Cancel"
        variant="primary"
        loading={writing}
      />
    </div>
  );
}
