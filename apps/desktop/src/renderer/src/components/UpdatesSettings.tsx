import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AppSettings, UpdateChannel } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { restartToUpdate, runUpdateAction } from "../stores/updateFlow.js";
import { ipcErrorMessage } from "./ipcError.js";
import { Md } from "./Markdown.js";
import { useNotifs } from "./Notifications.js";
import { releaseNotesMarkdown } from "./releaseNotes.js";
import { channelOfVersion } from "./updateChannel.js";
import { CHANNEL_LABELS, formatCheckedAt, installTarget, updateStatusText } from "./updateModel.js";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./SettingsLayout.js";

export function UpdatesSettings({
  draft,
  fallbackVersion,
  onApplied
}: {
  draft: AppSettings;
  fallbackVersion: string;
  onApplied: (patch: Partial<AppSettings>) => void;
}) {
  const state = useAppStore((s) => s.updates);
  const restartPending = useAppStore((s) => s.updateRestartPending);
  const [checking, setChecking] = useState(false);
  const [savingPreference, setSavingPreference] = useState(false);
  const notes = useMemo(() => releaseNotesMarkdown(state?.releaseNotes ?? null), [state?.releaseNotes]);

  const runningVersion = state?.runningVersion ?? fallbackVersion;
  const channel: UpdateChannel = draft.updateChannel ?? state?.channel ?? channelOfVersion(runningVersion);
  const disabled = !state || state.phase === "disabled";
  const busy = state?.phase === "checking" || state?.phase === "downloading" || state?.phase === "installing" || restartPending;
  const waitsForStable = channel === "stable" && channelOfVersion(runningVersion) === "alpha";
  const notesVersion = state?.availableVersion ?? state?.downloadedVersion ?? null;
  const readyToInstall = installTarget(state) !== null;

  const check = async () => {
    setChecking(true);
    try {
      await runUpdateAction(() => useAppStore.getState().checkForUpdates(), "Could not check for updates");
    } finally {
      setChecking(false);
    }
  };

  const changeChannel = async (next: UpdateChannel) => {
    const previous = draft.updateChannel;
    setSavingPreference(true);
    onApplied({ updateChannel: next });
    try {
      const result = await useAppStore.getState().setUpdateChannel(next);
      if (!result.ok) onApplied({ updateChannel: previous });
      if (!result.ok && result.code !== "disabled") {
        useNotifs.getState().push({ kind: "error", title: "Could not change the update channel", message: result.message });
      }
    } catch (err) {
      onApplied({ updateChannel: previous });
      useNotifs.getState().push({ kind: "error", title: "Could not change the update channel", message: ipcErrorMessage(err) });
    } finally {
      setSavingPreference(false);
    }
  };

  const changeBackground = async (enabled: boolean) => {
    setSavingPreference(true);
    onApplied({ updateBackgroundDownload: enabled });
    try {
      await useAppStore.getState().setUpdateBackgroundDownload(enabled);
    } catch (err) {
      onApplied({ updateBackgroundDownload: !enabled });
      useNotifs.getState().push({ kind: "error", title: "Could not save the download setting", message: ipcErrorMessage(err) });
    } finally {
      setSavingPreference(false);
    }
  };

  return (
    <>
      <SettingsGroup title="Version">
        <SettingsRow label="Installed version" hint={updateStatusText(state)}>
          <span className="sp-mono">{runningVersion}</span>
        </SettingsRow>
        <SettingsRow
          label="Last checked"
          hint={disabled ? (state?.disabledReason ?? "Updates are not available in this copy") : formatCheckedAt(state?.checkedAt ?? null, Date.now())}
        >
          <span className="sp-actions">
            <button
              type="button"
              className="btn sp-btn-sm"
              onClick={() => void check()}
              disabled={disabled || busy || checking}
              title={disabled ? (state?.disabledReason ?? undefined) : busy ? "Wait for the current update step to finish" : undefined}
            >
              <RefreshCw size={12} aria-hidden="true" />
              {state?.phase === "checking" || checking ? "Checking…" : "Check for updates"}
            </button>
            {state?.phase === "available" && (
              <button
                type="button"
                className="btn sp-btn-sm"
                onClick={() => void runUpdateAction(() => useAppStore.getState().downloadUpdate(), "Could not download the update")}
              >
                Download
              </button>
            )}
            {readyToInstall && (
              <button type="button" className="btn btn-primary sp-btn-sm" onClick={() => void restartToUpdate()} disabled={restartPending}>
                Update and restart
              </button>
            )}
          </span>
        </SettingsRow>
        {state?.phase === "downloading" && (
          <div
            className="usage-track"
            role="progressbar"
            aria-label="Update download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.progress?.percent ?? 0)}
          >
            <i style={{ width: `${Math.round(state.progress?.percent ?? 0)}%` }} />
          </div>
        )}
        {state?.error && (
          <div className="settings-error" role="alert">
            {state.error.message}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Preferences">
        <SettingsRow
          label="Update channel"
          htmlFor="sp-update-channel"
          hint={
            waitsForStable
              ? `Stable never downgrades: this ${runningVersion} build keeps running until a stable release newer than it is published.`
              : channel === "alpha"
                ? "Alpha gets early builds, and stable releases as soon as they ship."
                : "Stable gets tested releases only."
          }
        >
          <select
            id="sp-update-channel"
            className="field sp-select"
            value={channel}
            disabled={disabled || savingPreference || state?.phase === "installing" || restartPending}
            onChange={(e) => void changeChannel(e.target.value === "alpha" ? "alpha" : "stable")}
          >
            {(Object.keys(CHANNEL_LABELS) as UpdateChannel[]).map((option) => (
              <option key={option} value={option}>
                {CHANNEL_LABELS[option]}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow label="Download updates in the background" hint="Installing always waits for you to choose Update and restart. Off asks before downloading.">
          <SettingsSwitch
            checked={draft.updateBackgroundDownload}
            disabled={savingPreference}
            onChange={(next) => void changeBackground(next)}
            label="Download updates in the background"
          />
        </SettingsRow>
      </SettingsGroup>

      {notes && (
        <SettingsGroup title={notesVersion ? `What's new in ${notesVersion}` : "Release notes"}>
          <div className="sp-notes">
            <Md text={notes} linkPolicy="https-only" />
          </div>
        </SettingsGroup>
      )}
    </>
  );
}
