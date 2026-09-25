import { useState } from "react";
import type { MetadataBackup, MetadataIssue, MetadataStore } from "@cw-code/contracts";
import { useConfirm } from "./ConfirmDialog.js";
import { ipcErrorMessage } from "./ipcError.js";
import { WindowControls } from "./WindowControls.js";

const STORE_LABELS: Record<MetadataStore, string> = {
  sessions: "Projects and sessions",
  settings: "Settings"
};

const START_FRESH_LABELS: Record<MetadataStore, string> = {
  sessions: "Start with no projects",
  settings: "Start with default settings"
};

const START_FRESH_EFFECTS: Record<MetadataStore, string> = {
  sessions: "cw-code starts with an empty project and session list. CLI sessions, repositories and worktrees stay on disk; projects can be added again and CLI sessions imported.",
  settings: "cw-code starts with default settings."
};

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function explainIssue(issue: MetadataIssue): string {
  switch (issue.kind) {
    case "corrupt":
      return "The file is not valid JSON, so cw-code cannot read it.";
    case "invalid-shape":
      return "The file is valid JSON but does not have the structure cw-code expects.";
    case "future-schema":
      return `A newer version of cw-code wrote this file (schema ${issue.foundVersion ?? "?"}; this version supports up to ${issue.supportedVersion}). Update cw-code or restore an older backup.`;
    case "missing":
      return "The file is missing, but backups of it exist next to it. cw-code did not start empty so the backups are not ignored by mistake.";
    case "io":
      return "cw-code could not read, back up or write this file.";
  }
}

function formatTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "unknown time";
}

function BackupRow({ backup, busy, onRestore }: { backup: MetadataBackup; busy: boolean; onRestore: () => void }) {
  return (
    <li className="recovery-backup">
      <div className="recovery-backup-info">
        <span className="recovery-backup-label">{backup.label}</span>
        <span className="recovery-backup-time">{formatTime(backup.modifiedAt)}</span>
        {!backup.valid && <span className="recovery-backup-invalid">Not restorable: {backup.reason ?? "invalid backup"}</span>}
      </div>
      {backup.valid && (
        <button type="button" className="btn" disabled={busy} onClick={onRestore}>
          Restore
        </button>
      )}
    </li>
  );
}

export function RecoveryScreen({ issues, dataDir }: { issues: MetadataIssue[]; dataDir: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (issue: MetadataIssue, backup: MetadataBackup) => {
    const ok = await confirm({
      title: `Restore ${fileName(issue.file)}?`,
      message: `cw-code will replace ${fileName(issue.file)} with the "${backup.label}" backup from ${formatTime(backup.modifiedAt)}. The current file is kept next to it as ${fileName(issue.file)}.broken-<timestamp> and is not deleted. cw-code restarts afterwards.`,
      confirmLabel: "Restore and restart"
    });
    if (ok) await run(() => window.cw.recovery.restore(issue.file, backup.path));
  };

  const startFresh = async (issue: MetadataIssue) => {
    const kept = issue.kind === "missing"
      ? "There is no current file to keep; existing backups stay in place."
      : `The current file is kept next to it as ${fileName(issue.file)}.broken-<timestamp> and is not deleted.`;
    const ok = await confirm({
      title: `${START_FRESH_LABELS[issue.store]}?`,
      message: `${START_FRESH_EFFECTS[issue.store]} ${kept} cw-code restarts afterwards.`,
      confirmLabel: START_FRESH_LABELS[issue.store],
      danger: true
    });
    if (ok) await run(() => window.cw.recovery.startFresh(issue.file));
  };

  return (
    <div className="recovery-screen">
      <div className="recovery-drag" />
      <WindowControls />
      <main className="recovery-body" role="alert">
        <h1 className="recovery-title">cw-code could not load its local data</h1>
        <p className="recovery-lead">
          Nothing was overwritten: the files below were left exactly as they were found. CLI sessions, repositories and
          worktrees are not affected. Restore a backup, fix the file and retry, or start that file fresh.
        </p>
        {issues.map((issue) => (
          <section key={issue.file} className="recovery-issue">
            <div className="recovery-issue-title">{STORE_LABELS[issue.store]}</div>
            <code className="recovery-path">{issue.file}</code>
            <p className="recovery-explain">{explainIssue(issue)}</p>
            <div className="notif-msg">{issue.message}</div>
            {issue.backups.length === 0 ? (
              <p className="recovery-explain">No backups were found for this file.</p>
            ) : (
              <ul className="recovery-backups">
                {issue.backups.map((backup) => (
                  <BackupRow key={backup.path} backup={backup} busy={busy} onRestore={() => void restore(issue, backup)} />
                ))}
              </ul>
            )}
            {issue.kind === "io" ? (
              <>
                <p className="recovery-explain">
                  The file itself may be fine: another program (for example antivirus, a sync tool or a second cw-code
                  window) may be holding it. Close that program and retry.
                </p>
                <div className="recovery-actions">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => window.cw.recovery.retry())}>
                    Retry
                  </button>
                </div>
              </>
            ) : (
              <div className="recovery-actions">
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void startFresh(issue)}>
                  {START_FRESH_LABELS[issue.store]}
                </button>
              </div>
            )}
          </section>
        ))}
        <div className="recovery-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void run(() => window.cw.recovery.openDataDir())}>
            Open data folder
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => window.cw.recovery.retry())}>
            Retry
          </button>
        </div>
        <p className="recovery-explain">Data folder: {dataDir}</p>
        {error && <div className="recovery-error">{error}</div>}
      </main>
      {dialog}
    </div>
  );
}
