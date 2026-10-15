import { useState } from "react";
import { ChevronDown, Copy, ExternalLink, FileText, GitPullRequest } from "lucide-react";
import type { PrWorkflow, Session, WorkflowSubject } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { AnchoredPopover, anchorRectOf, type AnchorRect } from "./AnchoredPopover.js";
import { DriverIcon } from "./DriverIcon.js";
import {
  continueSessionFor,
  enabledWorkflowsFor,
  externalLinkOf,
  isFinished,
  originLabel,
  rowAction,
  runPrRef,
  sessionLinkOf,
  suggestedWorkflowFor,
  type RowSubject,
  type SuggestionSubject
} from "./githubRowModel.js";
import { openExternalLink } from "./externalLink.js";
import { useNotifs } from "./Notifications.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { workflowIcon } from "./workflowIcons.js";

type SessionMode = "continue" | "new";

function modalSubject(subject: RowSubject, target: PrWorkflow["target"]): WorkflowSubject | null {
  if (target === "pr") {
    const ref = subject.kind === "pr" ? subject.pr.ref : subject.kind === "run" ? runPrRef(subject.run) : null;
    return ref ? { kind: "pr", ref } : null;
  }
  if (target === "issue") return subject.kind === "issue" ? { kind: "issue", ref: subject.issue.ref } : null;
  return subject.kind === "run" ? { kind: "run", ref: subject.run.ref } : null;
}

function suggestionSubject(subject: RowSubject, viewer: string | null): SuggestionSubject {
  return subject.kind === "issue" ? { ...subject, viewer } : subject;
}

function subjectNumberLabel(subject: RowSubject): string {
  if (subject.kind === "pr") return `#${subject.pr.ref.number}`;
  if (subject.kind === "issue") return `#${subject.issue.ref.number}`;
  return `run #${subject.run.runNumber}`;
}

function WorkflowItems({
  workflows,
  suggestedId,
  onPick
}: {
  workflows: PrWorkflow[];
  suggestedId: string | null;
  onPick: (workflow: PrWorkflow) => void;
}) {
  return (
    <>
      {workflows.map((workflow) => {
        const Icon = workflowIcon(workflow.icon);
        return (
          <button key={workflow.id} type="button" className="pr-inbox-popover-item" onClick={() => onPick(workflow)}>
            <Icon size={13} aria-hidden="true" />
            <span>{workflow.label}</span>
            {workflow.id === suggestedId && <span className="pr-inbox-popover-suggested">Suggested</span>}
          </button>
        );
      })}
    </>
  );
}

function ActionMenu({
  subject,
  viewer,
  sessions,
  workflows,
  workflowsError,
  onReloadWorkflows,
  unseen,
  now,
  anchor,
  onClose
}: {
  subject: RowSubject;
  viewer: string | null;
  sessions: Session[];
  workflows: PrWorkflow[];
  workflowsError: string | null;
  onReloadWorkflows: () => void;
  unseen: ReadonlySet<string>;
  now: number;
  anchor: AnchorRect;
  onClose: () => void;
}) {
  const selectSession = useAppStore((s) => s.selectSession);
  const openSessionView = usePrStore((s) => s.openSessionView);
  const openRunModal = usePrStore((s) => s.openRunModal);
  const openPr = usePrStore((s) => s.openPr);
  const [mode, setMode] = useState<SessionMode>("continue");

  const url = externalLinkOf(subject);
  const prRef = subject.kind === "run" ? runPrRef(subject.run) : null;
  const suggested = suggestedWorkflowFor(suggestionSubject(subject, viewer), workflows);
  const finishedPr = subject.kind === "pr" && isFinished(subject);
  const ownWorkflows = finishedPr ? [] : enabledWorkflowsFor(subject.kind, workflows);
  const prWorkflows = prRef ? enabledWorkflowsFor("pr", workflows) : [];

  const goToSession = (sessionId: string) => {
    onClose();
    openSessionView();
    selectSession(sessionId);
  };

  const runWorkflow = (workflow: PrWorkflow) => {
    const target = modalSubject(subject, workflow.target);
    if (!target) return;
    const session = mode === "continue" ? continueSessionFor(subject, workflow.target, sessions) : null;
    onClose();
    openRunModal({ workflowId: workflow.id, subject: target, continueSessionId: session?.id });
  };

  const openLink = (target: string) => {
    onClose();
    openExternalLink(target);
  };

  const copyBranch = (branch: string) => {
    onClose();
    void navigator.clipboard.writeText(branch).catch(() => {
      useNotifs.getState().push({ kind: "error", title: "Could not copy branch name", message: branch });
    });
  };

  return (
    <AnchoredPopover anchor={anchor} align="right" label="Sessions and workflows" onClose={onClose}>
      {sessions.length > 0 && (
        <>
          <div className="pr-inbox-popover-head">Sessions on {subjectNumberLabel(subject)}</div>
          {sessions.map((session) => (
            <button key={session.id} type="button" className="pr-inbox-popover-row" onClick={() => goToSession(session.id)}>
              <DriverIcon driver={session.driver} size={14} />
              <span className="pr-inbox-popover-row-text">
                <span className="pr-inbox-popover-row-title">{session.title}</span>
                <span className="pr-inbox-popover-row-sub">
                  {originLabel(sessionLinkOf(subject, session), subject.kind, workflows)} ·{" "}
                  {session.status === "working" ? "working now" : `active ${formatRelativeAge(session.updatedAt, now)} ago`}
                </span>
              </span>
              {unseen.has(session.id) ? (
                <span className="pr-inbox-popover-badge">new</span>
              ) : session.status === "working" ? (
                <span className="pulse" />
              ) : (
                <span />
              )}
            </button>
          ))}
          <div className="pr-inbox-popover-sep" />
        </>
      )}
      {subject.kind === "run" && (
        <>
          <div className="pr-inbox-popover-head">Run</div>
          <button type="button" className="pr-inbox-popover-item" onClick={() => openLink(subject.run.url)}>
            <FileText size={13} aria-hidden="true" />
            <span>View logs</span>
          </button>
          {prRef && (
            <button
              type="button"
              className="pr-inbox-popover-item"
              onClick={() => {
                onClose();
                openPr(prRef);
              }}
            >
              <GitPullRequest size={13} aria-hidden="true" />
              <span>Open PR #{prRef.number}</span>
            </button>
          )}
          <div className="pr-inbox-popover-sep" />
        </>
      )}
      {!finishedPr && (
        <>
          <div className="pr-inbox-popover-head">
            Run workflow
            {sessions.length > 0 && (
              <span className="hub-menu-head-right">
                <span className="hub-seg">
                  <button type="button" className={mode === "continue" ? "on" : ""} aria-pressed={mode === "continue"} onClick={() => setMode("continue")}>
                    Continue session
                  </button>
                  <button type="button" className={mode === "new" ? "on" : ""} aria-pressed={mode === "new"} onClick={() => setMode("new")}>
                    New session
                  </button>
                </span>
              </span>
            )}
          </div>
          {workflowsError && (
            <div className="pr-inbox-popover-empty" role="alert">
              Could not load workflows: {workflowsError}{" "}
              <button type="button" className="pr-view-retry" onClick={onReloadWorkflows}>
                Retry
              </button>
            </div>
          )}
          {!workflowsError && ownWorkflows.length === 0 && prWorkflows.length === 0 && (
            <div className="pr-inbox-popover-empty">No enabled workflows.</div>
          )}
          <WorkflowItems workflows={ownWorkflows} suggestedId={suggested?.id ?? null} onPick={runWorkflow} />
          {prRef && prWorkflows.length > 0 && (
            <>
              <div className="pr-inbox-popover-head">On PR #{prRef.number}</div>
              <WorkflowItems workflows={prWorkflows} suggestedId={null} onPick={runWorkflow} />
            </>
          )}
        </>
      )}
      <div className="pr-inbox-popover-sep" />
      <button type="button" className="pr-inbox-popover-item" onClick={() => openLink(url)}>
        <ExternalLink size={13} aria-hidden="true" />
        <span>Open on GitHub</span>
      </button>
      {subject.kind === "pr" && (
        <button type="button" className="pr-inbox-popover-item" onClick={() => copyBranch(subject.pr.headRefName)}>
          <Copy size={13} aria-hidden="true" />
          <span>Copy branch name</span>
        </button>
      )}
    </AnchoredPopover>
  );
}

export function GitHubRowAction({
  subject,
  viewer,
  sessions,
  workflows,
  workflowsError,
  onReloadWorkflows,
  unseen,
  now
}: {
  subject: RowSubject;
  viewer: string | null;
  sessions: Session[];
  workflows: PrWorkflow[];
  workflowsError: string | null;
  onReloadWorkflows: () => void;
  unseen: ReadonlySet<string>;
  now: number;
}) {
  const selectSession = useAppStore((s) => s.selectSession);
  const openSessionView = usePrStore((s) => s.openSessionView);
  const openRunModal = usePrStore((s) => s.openRunModal);
  const [menuAnchor, setMenuAnchor] = useState<AnchorRect | null>(null);

  const action = rowAction({ subject, viewer, sessions, workflows, unseen });
  const closeMenu = () => setMenuAnchor(null);
  const url = externalLinkOf(subject);

  const caret = (
    <button
      type="button"
      className={`hub-action-caret${menuAnchor ? " open" : ""}`}
      title="Sessions and workflows"
      aria-label="Sessions and workflows"
      aria-haspopup="menu"
      aria-expanded={menuAnchor !== null}
      onClick={(e) => setMenuAnchor(menuAnchor ? null : anchorRectOf(e.currentTarget))}
    >
      <ChevronDown size={12} aria-hidden="true" />
    </button>
  );

  const menu = menuAnchor && (
    <ActionMenu
      subject={subject}
      viewer={viewer}
      sessions={sessions}
      workflows={workflows}
      workflowsError={workflowsError}
      onReloadWorkflows={onReloadWorkflows}
      unseen={unseen}
      now={now}
      anchor={menuAnchor}
      onClose={closeMenu}
    />
  );

  if (action.kind === "session") {
    const { session, mode, meta, label, workflowId } = action;
    const tip = mode === "continue" ? `Continue ${session.title} with the new commits` : `Open session · ${session.title}`;
    const age = formatRelativeAge(session.updatedAt, now);
    const onMain = () => {
      if (mode === "continue" && workflowId && subject.kind === "pr") {
        openRunModal({ workflowId, subject: { kind: "pr", ref: subject.pr.ref }, continueSessionId: session.id });
        return;
      }
      openSessionView();
      selectSession(session.id);
    };
    return (
      <div className={`hub-action has-session drv-${session.driver}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="hub-action-main" title={tip} onClick={onMain}>
          <DriverIcon driver={session.driver} size={13} />
          <span className="hub-action-label">{label}</span>
          <span className="hub-action-end">
            {meta === "working" && (
              <>
                <span className="pulse" />
                <span className="hub-action-meta working">working</span>
              </>
            )}
            {meta === "new" && (
              <>
                <span className="pr-unseen-dot" />
                <span className="hub-action-meta new">new</span>
              </>
            )}
            {meta === "unseen" && (
              <>
                <span className="pr-unseen-dot" title="Session has unseen updates" />
                <span className="hub-action-meta">{age}</span>
              </>
            )}
            {meta === "idle" && <span className="hub-action-meta">{age}</span>}
            {action.count > 1 && (
              <span className="hub-action-count" title={`${action.count} linked sessions`}>
                {action.count}
              </span>
            )}
          </span>
        </button>
        {caret}
        {menu}
      </div>
    );
  }

  if (action.kind === "workflow") {
    const { workflow, urgent } = action;
    const Icon = workflowIcon(workflow.icon);
    const target = modalSubject(subject, workflow.target);
    return (
      <div className={`hub-action${urgent ? " suggested" : ""}`} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="hub-action-main"
          title={`Start a session with the ${workflow.label} workflow`}
          onClick={() => target && openRunModal({ workflowId: workflow.id, subject: target })}
        >
          <Icon size={13} aria-hidden="true" />
          <span className="hub-action-label">{workflow.label}</span>
        </button>
        {caret}
        {menu}
      </div>
    );
  }

  if (action.kind === "logs") {
    return (
      <div className="hub-action" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="hub-action-main" title="Open the run on GitHub" onClick={() => openExternalLink(url)}>
          <FileText size={13} aria-hidden="true" />
          <span className="hub-action-label">Logs</span>
        </button>
        {caret}
        {menu}
      </div>
    );
  }

  return (
    <div className="hub-action" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="hub-action-main solo" title="Open on GitHub" onClick={() => openExternalLink(url)}>
        <ExternalLink size={13} aria-hidden="true" />
        <span className="hub-action-label">GitHub</span>
      </button>
    </div>
  );
}
