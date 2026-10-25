import { useMemo, useState, type ReactNode } from "react";
import { Bell, ExternalLink, RefreshCw, Send, TriangleAlert, X } from "lucide-react";
import type { PrDockEntry, PrSummary, PrWorkflow, ThreadTopicData } from "@cw-code/contracts";
import { combinedPrompt } from "@cw-code/shared/prDock";
import { sessionTopic } from "@cw-code/shared/topics";
import { usePrStore } from "../stores/prStore.js";
import { peekTopic } from "../server/topics.js";
import { prKey } from "./prInbox.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { PrUpdateIcon } from "./PrUpdateIcon.js";
import { followUpMode } from "./prWorkflows.js";
import { linkFor, prRefLabel } from "./sessionPrLinks.js";
import { harnessLabel } from "./toolTabs.js";
import { workflowIcon } from "./workflowIcons.js";
import { useAppSettings, useAppSettingsError } from "./useAppSettings.js";
import { requestPrDetail, usePrDetailEntries, usePrSummaries, useSessionBabysit } from "./usePrs.js";
import { useSessionRow } from "./useSessions.js";
import { useThreadEntry } from "./useThread.js";
import { BabysitHead } from "./BabysitHead.js";
import { errorMessage } from "./errorMessage.js";
import { ipcErrorMessage } from "./ipcError.js";
import { useRestoreBeforeSend } from "./sessionLifecycle.js";

const NO_ENTRIES: PrDockEntry[] = [];

interface DockRow {
  entry: PrDockEntry;
  pr: PrSummary | null;
  workflow: PrWorkflow | null;
  loading: boolean;
}

function isSendable(row: DockRow): boolean {
  return !row.entry.logsNeeded && row.entry.prompt !== null;
}

function omittedReason(row: DockRow): string {
  return row.entry.logsNeeded ? "needs failed CI logs, use Review and send" : "no follow-up prompt, pick one with Other workflow";
}

function sendSignature(rows: DockRow[]): string {
  return rows.map((row) => `${row.entry.key}@${row.entry.updates.map((update) => update.at).join(",")}`).join(" ");
}

function autoHintText(hint: PrDockEntry["autoHint"], workflow: PrWorkflow): ReactNode {
  const label = <b>{workflow.label}</b>;
  switch (hint) {
    case "paused":
      return <>{label} is paused, so this update waits for you</>;
    case "not-actionable":
      return <>{label} doesn't act on this kind of update</>;
    case "after-turn":
      return <>{label} sends this after the current turn</>;
    case "sending":
      return <>{label} is sending this</>;
    case null:
      return null;
  }
}

function WorkflowTag({ workflow }: { workflow: PrWorkflow }) {
  const Icon = workflowIcon(workflow.icon);
  return (
    <span className="pr-dock-workflow" title={workflow.description}>
      <Icon size={12} aria-hidden="true" />
      {workflow.label}
    </span>
  );
}

function ViewButton({ entry }: { entry: PrDockEntry }) {
  const openPr = usePrStore((s) => s.openPr);
  return (
    <button className="pr-detail-btn ghost sm" onClick={() => (entry.isReview ? openPr(entry.ref, "files") : openPr(entry.ref))}>
      <ExternalLink size={12} aria-hidden="true" />
      {entry.isReview ? "Diff since review" : "View"}
    </button>
  );
}

async function adoptWorkflow(sessionId: string, key: string, workflow: PrWorkflow): Promise<void> {
  const link = peekTopic<ThreadTopicData>(sessionTopic(sessionId))?.data.prItems.find((item) => item.key === key)?.link;
  if (link && link.workflowId !== workflow.id) await window.cw.linkSessionPr(sessionId, { ...link, workflowId: workflow.id });
}

export function PrUpdateDock({ sessionId }: { sessionId: string }) {
  const row = useSessionRow(sessionId);
  const session = row?.session;
  const busy = row?.busy ?? false;
  const entries = useThreadEntry(sessionId, "prDock") ?? NO_ENTRIES;
  const babysit = useSessionBabysit(sessionId);
  const summaries = usePrSummaries();
  const details = usePrDetailEntries();
  const { ensureOpen, dialog: restoreDialog } = useRestoreBeforeSend();
  const openRunModal = usePrStore((s) => s.openRunModal);
  const settings = useAppSettings();
  const settingsError = useAppSettingsError();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [working, setWorking] = useState<"send" | "dismiss" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sentSignature, setSentSignature] = useState<string | null>(null);

  const harness = session ? harnessLabel(session.driver) : "";
  const rows = useMemo(
    () =>
      entries.map((entry): DockRow => {
        const detail = details.get(entry.key);
        return {
          entry,
          pr: summaries.get(entry.key) ?? detail?.detail ?? null,
          workflow: entry.workflowLabel === null ? null : (settings?.prWorkflows.find((item) => item.id === entry.workflowId) ?? null),
          loading: detail?.loading ?? false
        };
      }),
    [entries, summaries, details, settings]
  );
  const changed = useMemo(() => rows.filter((item) => item.entry.updates.length > 0), [rows]);
  const failed = useMemo(
    () => rows.filter((item) => item.entry.updates.length === 0 && item.entry.error !== null && item.entry.unseen),
    [rows]
  );
  const single = changed.length === 1 ? changed[0] : null;
  const sendable = useMemo(() => changed.filter(isSendable), [changed]);
  const omitted = useMemo(() => changed.filter((item) => !isSendable(item)), [changed]);
  const prompt = useMemo(() => (single ? single.entry.prompt : combinedPrompt(sendable.map((item) => item.entry))), [single, sendable]);
  const covered = useMemo(() => (single ? [single] : sendable), [single, sendable]);
  const alreadySent = sentSignature !== null && sentSignature === sendSignature(covered);

  if (!session || (!babysit && changed.length === 0 && failed.length === 0)) return null;

  const babysat = (item: DockRow) => babysit !== null && item.entry.key === prKey(babysit.link.ref);
  const dockClass = babysit ? `pr-dock babysit-dock ${babysit.phase.kind}` : "pr-dock";
  const babysitHead = babysit && <BabysitHead sessionId={sessionId} state={babysit} />;

  const dismiss = async (targets: DockRow[]) => {
    if (working) return;
    setWorking("dismiss");
    setActionError(null);
    try {
      await window.cw.dismissPrUpdates(
        sessionId,
        targets.map((item) => item.entry.key)
      );
    } catch (err) {
      setActionError(`Could not dismiss the update: ${errorMessage(err)}`);
    } finally {
      setWorking(null);
    }
  };

  const failedRows = failed.map((item) => (
    <div key={item.entry.key} className="pr-dock-error" role="alert">
      <b>{prRefLabel(item.entry.ref)}</b> changed, but its details could not be loaded: {item.entry.error}{" "}
      <button className="pr-detail-btn ghost sm" onClick={() => void requestPrDetail(item.entry.ref)} disabled={item.loading}>
        Retry
      </button>
      <button
        className="icon-btn pr-dock-dismiss"
        onClick={() => void dismiss([item])}
        disabled={working !== null}
        title="Dismiss until the next change"
        aria-label={`Dismiss update for ${prRefLabel(item.entry.ref)}`}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  ));

  if (changed.length === 0) {
    return (
      <section className={babysit ? dockClass : "pr-dock pr-dock-failed"} aria-label="Pull request update">
        {babysitHead}
        {failed.length > 0 && (
          <>
            <div className="pr-dock-head">
              <TriangleAlert size={14} className="pr-dock-head-icon bad" aria-hidden="true" />
              <span className="pr-dock-title">
                {failed.length === 1
                  ? `PR #${failed[0].entry.ref.number} changed, but its details could not be loaded`
                  : `${failed.length} pull requests changed, but their details could not be loaded`}
              </span>
            </div>
            {failedRows}
          </>
        )}
      </section>
    );
  }

  const openInModal = (item: DockRow) => {
    openRunModal({ workflowId: item.entry.workflowId, subject: { kind: "pr", ref: item.entry.ref }, continueSessionId: sessionId });
  };

  const singleBabysat = single !== null && babysat(single);
  const singleLink = single ? linkFor(session, single.entry.ref) : undefined;
  const mode = single && singleLink ? followUpMode(session, singleLink, single.pr, single.workflow, settings?.prWorkflows ?? [], babysit) : null;
  const continuous = mode?.kind === "start" ? mode.workflow : null;
  const auto = mode?.kind === "auto" ? mode : null;

  const send = async () => {
    if (!prompt || busy || working || alreadySent) return;
    setWorking("send");
    setActionError(null);
    try {
      if (!(await ensureOpen(sessionId))) {
        setWorking(null);
        return;
      }
      await window.cw.sendPrUpdates(
        sessionId,
        covered.map((item) => item.entry.key)
      );
    } catch (err) {
      setActionError(`Could not send the update: ${ipcErrorMessage(err)}`);
      setWorking(null);
      return;
    }
    setSentSignature(sendSignature(covered));
    if (continuous && single) {
      try {
        await adoptWorkflow(sessionId, single.entry.key, continuous);
      } catch (err) {
        setActionError(`The update was sent, but ${continuous.label} could not be started: ${ipcErrorMessage(err)}`);
      }
    }
    setWorking(null);
  };

  const allReview = changed.every((item) => item.entry.isReview);
  const since = allReview ? "your review" : "your last turn";
  const title = singleBabysat
    ? `Changed since ${since}`
    : single
      ? `PR #${single.entry.ref.number} changed since ${since}`
      : `${changed.length} pull requests changed since ${since}`;
  const totalUpdates = changed.reduce((sum, item) => sum + item.entry.updates.length, 0);
  const singleLogs = single !== null && single.entry.logsNeeded;
  const primaryLabel = singleLogs
    ? "Review and send…"
    : allReview
      ? "Re-review changes"
      : continuous
        ? `Start ${continuous.label}`
        : auto
          ? "Send now"
          : single
            ? `Send update to ${harness}`
            : `Send ${sendable.length} ${sendable.length === 1 ? "update" : "updates"} to ${harness}`;
  const PrimaryIcon = allReview ? RefreshCw : continuous ? workflowIcon(continuous.icon) : Send;
  const primaryTitle = busy
    ? "Wait for the current turn to finish"
    : alreadySent
      ? "This update was already sent"
      : continuous && single
        ? `Send this update now, then let ${continuous.label} follow up on ${prRefLabel(single.entry.ref)} by itself until it is merged or closed`
        : auto
          ? `Send this update without waiting for ${auto.workflow.label}`
          : undefined;
  const primaryDisabled = singleLogs ? busy : busy || prompt === null || working !== null || alreadySent;
  const now = Date.now();
  const previewText = singleLogs
    ? "This follow-up prompt includes failed CI logs. They are fetched when you open it with Review and send."
    : (prompt ??
      (settingsError
        ? "Workflows could not be loaded."
        : settings && sendable.length === 0
          ? "None of the changed pull requests has a prompt that can be sent together. Send each one from its section."
          : "Resolving prompt…"));
  const footWorkflow = mode && (mode.kind === "start" || mode.kind === "once") ? mode.workflow : null;
  const hint = single && mode ? (
    mode.kind === "auto" ? (
      autoHintText(single.entry.autoHint, mode.workflow)
    ) : mode.kind === "start" ? (
      "sends this now, then keeps following up by itself until the PR is merged or closed"
    ) : mode.kind === "once" ? (
      "sends its follow-up prompt once"
    ) : (
      "follow-up prompt unavailable"
    )
  ) : (
    `combines the follow-up prompts of ${sendable.length} pull ${sendable.length === 1 ? "request" : "requests"}`
  );

  return (
    <section className={dockClass} aria-label="Pull request update">
      {babysitHead}
      <div className="pr-dock-head">
        <Bell size={14} className="pr-dock-head-icon" aria-hidden="true" />
        <span className="pr-dock-title">{title}</span>
        <span className="pr-dock-badge">{totalUpdates}</span>
        <span className="pr-dock-spacer" />
        {single && !singleBabysat && <ViewButton entry={single.entry} />}
        <button
          className="icon-btn pr-dock-dismiss"
          onClick={() => void dismiss(changed)}
          disabled={working !== null}
          title={single ? "Dismiss until the next change" : "Dismiss all until the next change"}
          aria-label={single ? `Dismiss update for ${prRefLabel(single.entry.ref)}` : "Dismiss all pull request updates"}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {changed.map((item) => {
        const ref = item.entry.ref;
        return (
          <div key={item.entry.key} className="pr-dock-group">
            <div className="pr-dock-group-head">
              <span className="pr-dock-group-title" title={item.pr?.title}>
                <b>{prRefLabel(ref)}</b>
                {item.pr ? ` ${item.pr.title}` : ""}
              </span>
              {!single && (
                <>
                  <span className="pr-dock-badge">{item.entry.updates.length}</span>
                  <span className="pr-dock-spacer" />
                  {item.workflow && !babysat(item) && <WorkflowTag workflow={item.workflow} />}
                  <ViewButton entry={item.entry} />
                  {(item.entry.logsNeeded || !babysat(item)) && (
                    <button className="pr-detail-btn ghost sm" onClick={() => openInModal(item)}>
                      {item.entry.logsNeeded ? "Review and send…" : "Other workflow"}
                    </button>
                  )}
                  <button
                    className="icon-btn pr-dock-dismiss"
                    onClick={() => void dismiss([item])}
                    disabled={working !== null}
                    title="Dismiss until the next change"
                    aria-label={`Dismiss update for ${prRefLabel(ref)}`}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
            <ul className="pr-dock-list">
              {item.entry.updates.map((update, index) => (
                <li key={`${update.kind}-${update.at}-${index}`} className="pr-dock-item">
                  <PrUpdateIcon kind={update.kind} />
                  <span className="pr-dock-item-text">{update.summary}</span>
                  <span className="pr-dock-item-age">{formatRelativeAge(update.at, now)} ago</span>
                </li>
              ))}
            </ul>
            {settings && item.entry.workflowLabel === null && (
              <div className="pr-dock-error" role="alert">
                No follow-up workflow found for #{ref.number}; pick one with Other workflow.
              </div>
            )}
          </div>
        );
      })}
      {failedRows}
      {previewOpen && <pre className="pr-dock-preview">{previewText}</pre>}
      {settingsError && (
        <div className="pr-dock-error" role="alert">
          Could not load workflows: {settingsError}
        </div>
      )}
      {!single && omitted.length > 0 && (
        <div className="pr-dock-error" role="status">
          Not included: {omitted.map((item) => `#${item.entry.ref.number} (${omittedReason(item)})`).join(", ")}. Send{" "}
          {omitted.length === 1 ? "it" : "them"} afterwards.
        </div>
      )}
      {actionError && (
        <div className="pr-dock-error" role="alert">
          {actionError}
        </div>
      )}
      <div className="pr-dock-foot">
        {footWorkflow && <WorkflowTag workflow={footWorkflow} />}
        <span className="pr-dock-hint" title={typeof hint === "string" ? hint : undefined}>
          {hint}
        </span>
        <button className="pr-detail-btn ghost sm" onClick={() => setPreviewOpen(!previewOpen)} aria-expanded={previewOpen}>
          {previewOpen ? "Hide preview" : "Preview"}
        </button>
        <span className="pr-dock-spacer" />
        {single && !singleBabysat && (
          <button className="pr-detail-btn sm" onClick={() => openInModal(single)}>
            Other workflow
          </button>
        )}
        <button
          className="pr-detail-btn primary sm"
          onClick={single && singleLogs ? () => openInModal(single) : () => void send()}
          disabled={primaryDisabled}
          title={primaryTitle}
        >
          <PrimaryIcon size={12} aria-hidden="true" />
          {primaryLabel}
        </button>
      </div>
      {restoreDialog}
    </section>
  );
}
