import { useMemo, useState } from "react";
import { Bell, ExternalLink, RefreshCw, Send, TriangleAlert, X } from "lucide-react";
import type { AppSettings, PrSummary, PrUpdate, PrWorkflow } from "@cw-code/contracts";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { PrUpdateIcon } from "./PrUpdateIcon.js";
import { defaultFollowUpWorkflowId, followUpPrompt, followUpWorkflow, needsFailedLogs } from "./prSessionModel.js";
import { seenThrough, updatesSince } from "./prUpdates.js";
import { prRefLabel } from "./sessionPrLinks.js";
import { harnessLabel } from "./toolTabs.js";
import { useLinkedPrs, usePrSettings, type LinkedPr } from "./useLinkedPr.js";
import { errorMessage } from "./errorMessage.js";

const EMPTY_UPDATES: PrUpdate[] = [];

interface DockEntry {
  item: LinkedPr;
  pr: PrSummary | null;
  updates: PrUpdate[];
  workflow: PrWorkflow | null;
  workflowId: string;
  isReview: boolean;
  logsNeeded: boolean;
  prompt: string | null;
}

function dockEntry(item: LinkedPr, settings: AppSettings | null, harness: string): DockEntry {
  const { link, detail } = item;
  const pr = item.summary ?? detail ?? null;
  const updates = detail ? updatesSince(detail, link) : EMPTY_UPDATES;
  const workflow = settings ? followUpWorkflow(link, pr, settings.prWorkflows) : null;
  const workflowId = workflow?.id ?? defaultFollowUpWorkflowId(link, pr);
  const prompt = detail && workflow && settings ? followUpPrompt(detail, link, workflow, updates, settings, harness) : null;
  return {
    item,
    pr,
    updates,
    workflow,
    workflowId,
    isReview: workflowId === "review",
    logsNeeded: workflow !== null && needsFailedLogs(workflow.updatePrompt),
    prompt
  };
}

function combinedPrompt(entries: DockEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries.map((entry) => `## ${prRefLabel(entry.item.link.ref)}\n\n${entry.prompt ?? ""}`).join("\n\n");
}

function omittedReason(entry: DockEntry): string {
  return entry.logsNeeded ? "needs failed CI logs, use Review and send" : "no follow-up prompt, pick one with Other workflow";
}

function seenHead(entry: DockEntry): string | null {
  return entry.item.detail?.headRefOid ?? entry.item.summary?.headRefOid ?? null;
}

function ViewButton({ entry }: { entry: DockEntry }) {
  const openPr = usePrStore((s) => s.openPr);
  const ref = entry.item.link.ref;
  return (
    <button className="pr-detail-btn ghost sm" onClick={() => (entry.isReview ? openPr(ref, "files") : openPr(ref))}>
      <ExternalLink size={12} aria-hidden="true" />
      {entry.isReview ? "Diff since review" : "View"}
    </button>
  );
}

export function PrUpdateDock({ sessionId }: { sessionId: string }) {
  const { session, items } = useLinkedPrs(sessionId);
  const busy = useAppStore((s) => s.busyTurns[sessionId] !== undefined);
  const sendPromptTo = useAppStore((s) => s.sendPromptTo);
  const applySession = useAppStore((s) => s.applySession);
  const openRunModal = usePrStore((s) => s.openRunModal);
  const loadDetail = usePrStore((s) => s.loadDetail);
  const { settings, error: settingsError } = usePrSettings();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [working, setWorking] = useState<"send" | "dismiss" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sentPrompt, setSentPrompt] = useState<string | null>(null);

  const harness = session ? harnessLabel(session.driver) : "";
  const entries = useMemo(() => items.map((item) => dockEntry(item, settings, harness)), [items, settings, harness]);
  const changed = useMemo(() => entries.filter((entry) => entry.updates.length > 0), [entries]);
  const failed = useMemo(
    () => entries.filter((entry) => entry.updates.length === 0 && entry.item.error !== undefined && entry.item.unseen),
    [entries]
  );
  const single = changed.length === 1 ? changed[0] : null;
  const sendable = useMemo(() => changed.filter((entry) => !entry.logsNeeded && entry.prompt !== null), [changed]);
  const omitted = useMemo(
    () => (settings ? changed.filter((entry) => entry.logsNeeded || entry.prompt === null) : []),
    [changed, settings]
  );
  const prompt = useMemo(() => (single ? single.prompt : combinedPrompt(sendable)), [single, sendable]);

  if (!session || (changed.length === 0 && failed.length === 0)) return null;

  const markSeen = async (targets: DockEntry[]) => {
    for (const entry of targets) {
      applySession(await window.cw.markSessionPrSeen(sessionId, entry.item.link.ref, seenHead(entry), seenThrough(entry.item.detail ?? entry.item.summary, entry.updates)));
    }
  };

  const dismiss = async (targets: DockEntry[]) => {
    if (working) return;
    setWorking("dismiss");
    setActionError(null);
    try {
      await markSeen(targets);
    } catch (err) {
      setActionError(`Could not dismiss the update: ${errorMessage(err)}`);
    } finally {
      setWorking(null);
    }
  };

  const failedRows = failed.map((entry) => (
    <div key={entry.item.key} className="pr-dock-error" role="alert">
      <b>{prRefLabel(entry.item.link.ref)}</b> changed, but its details could not be loaded: {entry.item.error}{" "}
      <button className="pr-detail-btn ghost sm" onClick={() => void loadDetail(entry.item.link.ref)} disabled={entry.item.loading}>
        Retry
      </button>
      <button
        className="icon-btn pr-dock-dismiss"
        onClick={() => void dismiss([entry])}
        disabled={working !== null}
        title="Dismiss until the next change"
        aria-label={`Dismiss update for ${prRefLabel(entry.item.link.ref)}`}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  ));

  if (changed.length === 0) {
    return (
      <section className="pr-dock pr-dock-failed" aria-label="Pull request update">
        <div className="pr-dock-head">
          <TriangleAlert size={14} className="pr-dock-head-icon bad" aria-hidden="true" />
          <span className="pr-dock-title">
            {failed.length === 1
              ? `PR #${failed[0].item.link.ref.number} changed, but its details could not be loaded`
              : `${failed.length} pull requests changed, but their details could not be loaded`}
          </span>
        </div>
        {failedRows}
      </section>
    );
  }

  const openInModal = (entry: DockEntry) => {
    openRunModal({ workflowId: entry.workflowId, ref: entry.item.link.ref, continueSessionId: sessionId });
  };

  const send = async () => {
    if (!prompt || busy || working || prompt === sentPrompt) return;
    setWorking("send");
    setActionError(null);
    const covered = single ? [single] : sendable;
    try {
      await sendPromptTo(sessionId, prompt, undefined, { prRefs: covered.map((entry) => entry.item.link.ref) });
    } catch (err) {
      setActionError(`Could not send the update: ${errorMessage(err)}`);
      setWorking(null);
      return;
    }
    setSentPrompt(prompt);
    try {
      await markSeen(covered);
    } catch (err) {
      setActionError(`The update was sent, but could not be cleared: ${errorMessage(err)}. Use × to clear it.`);
    } finally {
      setWorking(null);
    }
  };

  const allReview = changed.every((entry) => entry.isReview);
  const since = allReview ? "your review" : "your last turn";
  const title = single
    ? `PR #${single.item.link.ref.number} changed since ${since}`
    : `${changed.length} pull requests changed since ${since}`;
  const totalUpdates = changed.reduce((sum, entry) => sum + entry.updates.length, 0);
  const singleLogs = single !== null && single.logsNeeded;
  const primaryLabel = singleLogs
    ? "Review and send…"
    : allReview
      ? "Re-review changes"
      : single
        ? `Send update to ${harness}`
        : `Send ${sendable.length} ${sendable.length === 1 ? "update" : "updates"} to ${harness}`;
  const PrimaryIcon = allReview ? RefreshCw : Send;
  const alreadySent = prompt !== null && prompt === sentPrompt;
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
  const hint = single ? (
    single.workflow ? (
      <>
        uses the <b>{single.workflow.label}</b> workflow's follow-up prompt
      </>
    ) : (
      "follow-up prompt unavailable"
    )
  ) : (
    `combines the follow-up prompts of ${sendable.length} pull ${sendable.length === 1 ? "request" : "requests"}`
  );

  return (
    <section className="pr-dock" aria-label="Pull request update">
      <div className="pr-dock-head">
        <Bell size={14} className="pr-dock-head-icon" aria-hidden="true" />
        <span className="pr-dock-title">{title}</span>
        <span className="pr-dock-badge">{totalUpdates}</span>
        <span className="pr-dock-spacer" />
        {single && <ViewButton entry={single} />}
        <button
          className="icon-btn pr-dock-dismiss"
          onClick={() => void dismiss(changed)}
          disabled={working !== null}
          title={single ? "Dismiss until the next change" : "Dismiss all until the next change"}
          aria-label={single ? `Dismiss update for ${prRefLabel(single.item.link.ref)}` : "Dismiss all pull request updates"}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {changed.map((entry) => {
        const ref = entry.item.link.ref;
        return (
          <div key={entry.item.key} className="pr-dock-group">
            <div className="pr-dock-group-head">
              <span className="pr-dock-group-title" title={entry.pr?.title}>
                <b>{prRefLabel(ref)}</b>
                {entry.pr ? ` ${entry.pr.title}` : ""}
              </span>
              {!single && (
                <>
                  <span className="pr-dock-badge">{entry.updates.length}</span>
                  <span className="pr-dock-spacer" />
                  <ViewButton entry={entry} />
                  <button className="pr-detail-btn ghost sm" onClick={() => openInModal(entry)}>
                    {entry.logsNeeded ? "Review and send…" : "Other workflow"}
                  </button>
                  <button
                    className="icon-btn pr-dock-dismiss"
                    onClick={() => void dismiss([entry])}
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
              {entry.updates.map((update, index) => (
                <li key={`${update.kind}-${update.at}-${index}`} className="pr-dock-item">
                  <PrUpdateIcon kind={update.kind} />
                  <span className="pr-dock-item-text">{update.summary}</span>
                  <span className="pr-dock-item-age">{formatRelativeAge(update.at, now)} ago</span>
                </li>
              ))}
            </ul>
            {settings && !entry.workflow && (
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
          Not included: {omitted.map((entry) => `#${entry.item.link.ref.number} (${omittedReason(entry)})`).join(", ")}. Send{" "}
          {omitted.length === 1 ? "it" : "them"} afterwards.
        </div>
      )}
      {actionError && (
        <div className="pr-dock-error" role="alert">
          {actionError}
        </div>
      )}
      <div className="pr-dock-foot">
        <span className="pr-dock-hint">{hint}</span>
        <button className="pr-detail-btn ghost sm" onClick={() => setPreviewOpen(!previewOpen)} aria-expanded={previewOpen}>
          {previewOpen ? "Hide preview" : "Preview"}
        </button>
        <span className="pr-dock-spacer" />
        {single && (
          <button className="pr-detail-btn sm" onClick={() => openInModal(single)}>
            Other workflow
          </button>
        )}
        <button
          className="pr-detail-btn primary sm"
          onClick={single && singleLogs ? () => openInModal(single) : () => void send()}
          disabled={primaryDisabled}
          title={busy ? "Wait for the current turn to finish" : alreadySent ? "This update was already sent" : undefined}
        >
          <PrimaryIcon size={12} aria-hidden="true" />
          {primaryLabel}
        </button>
      </div>
    </section>
  );
}
