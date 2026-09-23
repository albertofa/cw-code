import { useMemo, useState } from "react";
import { Bell, ExternalLink, RefreshCw, Send, TriangleAlert, X } from "lucide-react";
import type { PrUpdate } from "@cw-code/contracts";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { PrUpdateIcon } from "./PrUpdateIcon.js";
import { defaultFollowUpWorkflowId, followUpPrompt, followUpWorkflow, needsFailedLogs } from "./prSessionModel.js";
import { updatesSince } from "./prUpdates.js";
import { harnessLabel } from "./toolTabs.js";
import { useLinkedPr, usePrSettings } from "./useLinkedPr.js";
import { errorMessage } from "./errorMessage.js";

const EMPTY_UPDATES: PrUpdate[] = [];

export function PrUpdateDock({ sessionId }: { sessionId: string }) {
  const { session, link, summary, detail, loading, error, unseen } = useLinkedPr(sessionId);
  const busy = useAppStore((s) => s.busyTurns[sessionId] !== undefined);
  const sendPromptTo = useAppStore((s) => s.sendPromptTo);
  const applySession = useAppStore((s) => s.applySession);
  const openRunModal = usePrStore((s) => s.openRunModal);
  const openPr = usePrStore((s) => s.openPr);
  const loadDetail = usePrStore((s) => s.loadDetail);
  const { settings, error: settingsError } = usePrSettings();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [working, setWorking] = useState<"send" | "dismiss" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const updates = useMemo(() => (detail && link ? updatesSince(detail, link) : EMPTY_UPDATES), [detail, link]);
  const pr = summary ?? detail ?? null;
  const workflow = useMemo(
    () => (link && settings ? followUpWorkflow(link, pr, settings.prWorkflows) : null),
    [link, pr, settings]
  );
  const harness = session ? harnessLabel(session.driver) : "";
  const prompt = useMemo(
    () => (detail && link && workflow && settings ? followUpPrompt(detail, link, workflow, updates, settings, harness) : null),
    [detail, link, workflow, settings, updates, harness]
  );

  if (!session || !link) return null;

  if (updates.length === 0) {
    if (!error || !unseen) return null;
    return (
      <section className="pr-dock pr-dock-failed" aria-label="Pull request update">
        <div className="pr-dock-head">
          <TriangleAlert size={14} className="pr-dock-head-icon bad" aria-hidden="true" />
          <span className="pr-dock-title">PR #{link.ref.number} changed, but its details could not be loaded</span>
          <button className="pr-detail-btn ghost sm" onClick={() => void loadDetail(link.ref)} disabled={loading}>
            Retry
          </button>
        </div>
        <div className="pr-dock-error" role="alert">{error}</div>
      </section>
    );
  }

  const workflowId = workflow?.id ?? defaultFollowUpWorkflowId(link, pr);
  const isReview = workflowId === "review";
  const logsNeeded = workflow !== null && needsFailedLogs(workflow.updatePrompt);
  const since = isReview ? "your review" : "your last turn";

  const send = async () => {
    if (!prompt || busy || working) return;
    setWorking("send");
    setActionError(null);
    try {
      await sendPromptTo(sessionId, prompt);
    } catch (err) {
      setActionError(`Could not send the update: ${errorMessage(err)}`);
    } finally {
      setWorking(null);
    }
  };

  const openInModal = () => {
    openRunModal({ workflowId, ref: link.ref, continueSessionId: sessionId });
  };

  const dismiss = async () => {
    if (!detail || working) return;
    setWorking("dismiss");
    setActionError(null);
    try {
      applySession(await window.cw.markSessionPrSeen(sessionId, detail.headRefOid));
    } catch (err) {
      setActionError(`Could not dismiss the update: ${errorMessage(err)}`);
    } finally {
      setWorking(null);
    }
  };

  const primaryLabel = logsNeeded ? "Review and send…" : isReview ? "Re-review changes" : `Send update to ${harness}`;
  const PrimaryIcon = isReview ? RefreshCw : Send;
  const primaryDisabled = logsNeeded ? busy : busy || prompt === null || working !== null;
  const now = Date.now();
  const previewText = logsNeeded
    ? "This follow-up prompt includes failed CI logs. They are fetched when you open it with Review and send."
    : (prompt ?? (settingsError ? "Workflows could not be loaded." : "Resolving prompt…"));

  return (
    <section className="pr-dock" aria-label="Pull request update">
      <div className="pr-dock-head">
        <Bell size={14} className="pr-dock-head-icon" aria-hidden="true" />
        <span className="pr-dock-title">
          PR #{link.ref.number} changed since {since}
        </span>
        <span className="pr-dock-badge">{updates.length}</span>
        <span className="pr-dock-spacer" />
        <button className="pr-detail-btn ghost sm" onClick={() => (isReview ? openPr(link.ref, "files") : openPr(link.ref))}>
          <ExternalLink size={12} aria-hidden="true" />
          {isReview ? "Diff since review" : "View PR"}
        </button>
        <button
          className="icon-btn pr-dock-dismiss"
          onClick={() => void dismiss()}
          disabled={working !== null}
          title="Dismiss until the next change"
          aria-label="Dismiss PR update"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <ul className="pr-dock-list">
        {updates.map((update, index) => (
          <li key={`${update.kind}-${update.at}-${index}`} className="pr-dock-item">
            <PrUpdateIcon kind={update.kind} />
            <span className="pr-dock-item-text">{update.summary}</span>
            <span className="pr-dock-item-age">{formatRelativeAge(update.at, now)} ago</span>
          </li>
        ))}
      </ul>
      {previewOpen && (
        <pre className="pr-dock-preview">{previewText}</pre>
      )}
      {settingsError && (
        <div className="pr-dock-error" role="alert">
          Could not load workflows: {settingsError}
        </div>
      )}
      {settings && !workflow && (
        <div className="pr-dock-error" role="alert">
          No follow-up workflow found; pick one with Other workflow.
        </div>
      )}
      {actionError && (
        <div className="pr-dock-error" role="alert">
          {actionError}
        </div>
      )}
      <div className="pr-dock-foot">
        <span className="pr-dock-hint">
          {workflow ? (
            <>
              uses the <b>{workflow.label}</b> workflow's follow-up prompt
            </>
          ) : (
            "follow-up prompt unavailable"
          )}
        </span>
        <button className="pr-detail-btn ghost sm" onClick={() => setPreviewOpen(!previewOpen)} aria-expanded={previewOpen}>
          {previewOpen ? "Hide preview" : "Preview"}
        </button>
        <span className="pr-dock-spacer" />
        <button className="pr-detail-btn sm" onClick={openInModal}>
          Other workflow
        </button>
        <button
          className="pr-detail-btn primary sm"
          onClick={logsNeeded ? openInModal : () => void send()}
          disabled={primaryDisabled}
          title={busy ? "Wait for the current turn to finish" : undefined}
        >
          <PrimaryIcon size={12} aria-hidden="true" />
          {primaryLabel}
        </button>
      </div>
    </section>
  );
}
