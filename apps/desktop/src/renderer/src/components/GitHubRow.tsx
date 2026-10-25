import { memo, useMemo, type ReactNode } from "react";
import { ChevronRight, GitBranch, MessageSquare, Timer } from "lucide-react";
import type { GitHubRow as GitHubRowData } from "@cw-code/contracts";
import type { PrWorkflow, RepoRef, Session } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { GitHubAvatar } from "./GitHubAvatar.js";
import { HoverCard, PeopleCard, StatusCard, type HoverSubject } from "./GitHubHoverCard.js";
import { GitHubRowAction } from "./GitHubRowAction.js";
import { DiffBar, VerdictGlyph } from "./GitHubVerdictIcon.js";
import { openExternalLink } from "./externalLink.js";
import {
  avatarUrlOf,
  deltaLabel,
  externalLinkOf,
  formatDuration,
  issueVerdict,
  jobPip,
  peopleStack,
  prGates,
  prVerdict,
  runDurationMs,
  runVerdict,
  stateGlyph,
  type RowSubject
} from "./githubRowModel.js";
import { subjectRepoOf } from "./githubViewModel.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { useNow } from "./usageFormat.js";
import { useAppSettings, useAppSettingsError } from "./useAppSettings.js";

const LIVE_TICK_MS = 1000;
const NO_WORKFLOWS: PrWorkflow[] = [];

export interface GitHubRowProps {
  row: GitHubRowData;
  viewer: string | null;
  isCloned: (repo: RepoRef) => boolean;
  onAddQualifier: (key: string, value: string) => void;
}

function linkedSessions(sessionsByProject: Record<string, Session[]>, ids: string[]): Session[] {
  if (ids.length === 0) return [];
  const byId = new Map<string, Session>();
  for (const sessions of Object.values(sessionsByProject)) for (const session of sessions) byId.set(session.id, session);
  return ids.flatMap((id) => byId.get(id) ?? []);
}

function Sep() {
  return <span className="pr-inbox-meta-sep">·</span>;
}

function QualifierButton({
  className,
  qualifier,
  value,
  onAdd,
  children
}: {
  className: string;
  qualifier: string;
  value: string;
  onAdd: (key: string, value: string) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      title={`Add ${qualifier}:${value} to the query`}
      onClick={(e) => {
        e.stopPropagation();
        onAdd(qualifier, value);
      }}
    >
      {children}
    </button>
  );
}

function Branch({ name }: { name: string }) {
  return (
    <span className="hub-branch">
      <GitBranch size={11} aria-hidden="true" />
      {name}
    </span>
  );
}

function MetaLine({ subject, delta, cloned, now, onAdd }: { subject: RowSubject; delta: string | null; cloned: boolean; now: number; onAdd: (key: string, value: string) => void }) {
  const repoOf = (ref: { owner: string; repo: string }) => `${ref.owner}/${ref.repo}`;
  let repo: string;
  let rest: ReactNode;
  if (subject.kind === "pr") {
    const { pr } = subject;
    const verb = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "updated";
    repo = repoOf(pr.ref);
    rest = (
      <>
        <span className="pr-inbox-num">#{pr.ref.number}</span>
        <Sep />
        <Branch name={pr.headRefName} />
        <Sep />
        <span className="pr-inbox-age">
          {verb} {formatRelativeAge(pr.updatedAt, now)} ago
        </span>
      </>
    );
  } else if (subject.kind === "issue") {
    const { issue } = subject;
    repo = repoOf(issue.ref);
    rest = (
      <>
        <span className="pr-inbox-num">#{issue.ref.number}</span>
        {issue.milestone && (
          <>
            <Sep />
            <span>{issue.milestone}</span>
          </>
        )}
        <Sep />
        <span className="pr-inbox-age">updated {formatRelativeAge(issue.updatedAt, now)} ago</span>
      </>
    );
  } else {
    const { run } = subject;
    repo = repoOf(run.ref);
    const event = run.event === "pull_request" && run.prNumber !== null ? `PR #${run.prNumber}` : run.event;
    rest = (
      <>
        <span>
          {run.workflowName} #{run.runNumber}
        </span>
        {run.branch && (
          <>
            <Sep />
            <Branch name={run.branch} />
          </>
        )}
        <Sep />
        <span>{event}</span>
        <Sep />
        <span className="pr-inbox-age">started {formatRelativeAge(run.createdAt, now)} ago</span>
      </>
    );
  }
  const slash = repo.indexOf("/") + 1;
  return (
    <div className="pr-inbox-meta-line">
      <QualifierButton className="pr-inbox-repo" qualifier="repo" value={repo} onAdd={onAdd}>
        <span className="pr-inbox-repo-owner">{repo.slice(0, slash)}</span>
        <span className="pr-inbox-repo-name">{repo.slice(slash)}</span>
      </QualifierButton>
      <Sep />
      {rest}
      {delta && (
        <>
          <Sep />
          <span className="pr-inbox-delta">{delta}</span>
        </>
      )}
      {subject.kind === "pr" && !cloned && <span className="pr-inbox-not-cloned">not cloned</span>}
    </div>
  );
}

function PeopleCell({ subject, viewer }: { subject: RowSubject; viewer: string | null }) {
  const hover: HoverSubject =
    subject.kind === "pr" ? { kind: "pr", item: subject.pr } : subject.kind === "issue" ? { kind: "issue", item: subject.issue } : { kind: "run", item: subject.run };
  const card = <PeopleCard subject={hover} viewer={viewer} />;

  if (subject.kind === "run") {
    const { run } = subject;
    return (
      <HoverCard className="hub-people" card={card}>
        {run.actor ? <GitHubAvatar login={run.actor} avatarUrl={run.actorAvatarUrl} viewer={run.actor.toLowerCase() === viewer?.toLowerCase()} /> : <span className="hub-people-none">—</span>}
        {run.event === "schedule" && <span className="hub-people-none">scheduled</span>}
      </HoverCard>
    );
  }

  const item = subject.kind === "pr" ? subject.pr : subject.issue;
  const stack = peopleStack(item, viewer);
  const noReviewers = subject.kind === "pr" && subject.pr.state === "OPEN" && !subject.pr.isDraft;
  return (
    <HoverCard className="hub-people" card={card}>
      <GitHubAvatar login={stack.author} avatarUrl={avatarUrlOf(item, stack.author)} />
      {stack.others.length > 0 ? (
        <>
          <span className="hub-people-arrow">
            <ChevronRight size={11} aria-hidden="true" />
          </span>
          <span className="hub-stack">
            {stack.others.map((person) => (
              <GitHubAvatar
                key={person.login}
                login={person.login}
                avatarUrl={avatarUrlOf(item, person.login)}
                small
                badge={person.badge}
                assignee={person.assignee}
                viewer={person.viewer}
              />
            ))}
            {stack.overflow > 0 && <span className="hub-av sm more">+{stack.overflow}</span>}
          </span>
        </>
      ) : (
        noReviewers && <span className="hub-people-none">no reviewers</span>
      )}
    </HoverCard>
  );
}

function GateCell({ subject, viewer, now }: { subject: RowSubject; viewer: string | null; now: number }) {
  const hover: HoverSubject =
    subject.kind === "pr" ? { kind: "pr", item: subject.pr } : subject.kind === "issue" ? { kind: "issue", item: subject.issue } : { kind: "run", item: subject.run };
  const card = <StatusCard subject={hover} viewer={viewer} now={now} />;

  if (subject.kind === "pr") {
    const { pr } = subject;
    const verdict = prVerdict(pr, viewer);
    const gates = prGates(pr, viewer);
    return (
      <HoverCard className="hub-gate" card={card}>
        <div className={`hub-gate-verdict tone-${verdict.tone}`}>
          <VerdictGlyph verdict={verdict} toneClass={false} />
          <span>{verdict.text}</span>
        </div>
        <div className="hub-gate-line">
          {pr.state === "OPEN" && (
            <span className="hub-gates">
              <VerdictGlyph verdict={gates.checks} size={12} />
              <VerdictGlyph verdict={gates.review} size={12} />
              <VerdictGlyph verdict={gates.merge} size={12} />
            </span>
          )}
          <span className="hub-diff">
            <span className="pr-inbox-add">+{pr.additions}</span> <span className="pr-inbox-del">−{pr.deletions}</span>
          </span>
          <DiffBar additions={pr.additions} deletions={pr.deletions} />
          {pr.unresolvedThreads > 0 && (
            <span className="hub-unresolved" title={`${pr.unresolvedThreads} unresolved threads`}>
              <MessageSquare size={11} aria-hidden="true" />
              {pr.unresolvedThreads}
            </span>
          )}
        </div>
      </HoverCard>
    );
  }

  if (subject.kind === "issue") {
    const { issue } = subject;
    const verdict = issueVerdict(issue);
    return (
      <HoverCard className="hub-gate" card={card}>
        <div className={`hub-gate-verdict tone-${verdict.tone}`}>
          <VerdictGlyph verdict={verdict} toneClass={false} />
          <span>{verdict.text}</span>
        </div>
        <div className="hub-gate-line">
          <span className="hub-comments">
            <MessageSquare size={11} aria-hidden="true" />
            {issue.commentsCount}
          </span>
          <span>updated {formatRelativeAge(issue.updatedAt, now)} ago</span>
        </div>
      </HoverCard>
    );
  }

  const { run } = subject;
  const verdict = runVerdict(run);
  const duration = runDurationMs(run, now);
  return (
    <HoverCard className="hub-gate" card={card}>
      <div className={`hub-gate-verdict tone-${verdict.tone}`}>
        <VerdictGlyph verdict={verdict} toneClass={false} />
        <span>{verdict.text}</span>
      </div>
      <div className="hub-gate-line">
        <span className="hub-jobs" aria-hidden="true">
          {run.jobs.map((job, index) => (
            <i key={`${job.name}-${index}`} className={jobPip(job)} />
          ))}
        </span>
        <span className="hub-comments">
          <Timer size={11} aria-hidden="true" />
          {duration === null ? "—" : formatDuration(duration)}
        </span>
      </div>
    </HoverCard>
  );
}

export const GitHubRow = memo(function GitHubRow({ row, viewer, isCloned, onAddQualifier }: GitHubRowProps) {
  const { subject, relations } = row;
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const openPr = usePrStore((s) => s.openPr);
  const cloned = useMemo(() => isCloned(subjectRepoOf(subject)), [isCloned, subject]);
  const workflows = useAppSettings()?.prWorkflows ?? NO_WORKFLOWS;
  const workflowsError = useAppSettingsError();
  const live = subject.kind === "run" && subject.run.status === "in_progress";
  const now = useNow(live ? LIVE_TICK_MS : undefined);

  const sessions = useMemo(() => linkedSessions(sessionsByProject, relations.linkedSessionIds), [sessionsByProject, relations.linkedSessionIds]);
  const unseenIds = useMemo(() => new Set(relations.unseenSessionIds), [relations.unseenSessionIds]);
  const unseen = unseenIds.size > 0;
  const delta = deltaLabel(relations.delta, now);
  const state = stateGlyph(subject);
  const labels = subject.kind === "pr" ? subject.pr.labels : subject.kind === "issue" ? subject.issue.labels : [];
  const title = subject.kind === "pr" ? subject.pr.title : subject.kind === "issue" ? subject.issue.title : subject.run.title;

  const open = () => {
    if (subject.kind === "pr") openPr(subject.pr.ref);
    else openExternalLink(externalLinkOf(subject));
  };

  return (
    <div className={`hub-row${unseen ? "" : " seen"}`} onClick={open}>
      <span className="hub-state">
        <span className={`pr-inbox-state tone-${state.tone}`} title={state.text}>
          <VerdictGlyph verdict={state} size={14} toneClass={false} />
        </span>
        {unseen && <span className="pr-unseen-dot hub-state-dot" title="Updated since you last looked" />}
      </span>
      <div className="pr-inbox-title-col">
        <div className="pr-inbox-title-line">
          <button
            type="button"
            className="pr-inbox-title-link"
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
          >
            {title}
          </button>
          {labels.map((label) => (
            <QualifierButton key={label} className="pr-inbox-label" qualifier="label" value={label} onAdd={onAddQualifier}>
              {label}
            </QualifierButton>
          ))}
        </div>
        <MetaLine subject={subject} delta={delta} cloned={cloned} now={now} onAdd={onAddQualifier} />
      </div>
      <PeopleCell subject={subject} viewer={viewer} />
      <GateCell subject={subject} viewer={viewer} now={now} />
      <GitHubRowAction
        subject={subject}
        relations={relations}
        viewer={viewer}
        sessions={sessions}
        workflows={workflows}
        workflowsError={workflowsError}
        unseen={unseenIds}
        now={now}
      />
    </div>
  );
});
