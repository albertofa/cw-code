import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Cloud,
  Eye,
  Folder,
  GitBranch,
  GitFork,
  GitPullRequest,
  MessagesSquare,
  PanelLeft,
  Search,
  Tag,
  X,
  type LucideIcon
} from "lucide-react";
import { orderedEntries } from "@cw-code/client";
import type { GitHubRow, GitHubViewTopicData, GitStatus, HistoryLog, HistoryRef, HistoryScope, HistoryWorktree, PrSummary, SessionRow } from "@cw-code/contracts";
import { normalizeQuery } from "@cw-code/shared/githubQueryDsl";
import { prKey } from "@cw-code/shared/prRef";
import { githubViewTopic } from "@cw-code/shared/topics";
import { acquireTopic, useTopic } from "../../server/topics.js";
import { useSessions } from "../useSessions.js";
import { usePrSummaries } from "../usePrs.js";
import { useSessionLinkedPrs } from "../PrSessionPanel.js";
import { PrChipBadge } from "../PrChipBadge.js";
import { errorMessage } from "../errorMessage.js";
import { openExternalLink } from "../externalLink.js";
import type { GitGlassSelection } from "./GitGlassDetails.js";
import {
  buildSidebarModel,
  filterSidebarModel,
  prForBranch,
  prTone,
  remoteGroups,
  sectionCounts,
  sessionDotStatus,
  sessionStatusText,
  type SidebarModel,
  type SidebarPr,
  type SidebarSectionId
} from "./sidebarModel.js";
import { usePersistedChoice } from "./usePersistedState.js";

const SECTION_STATES = ["open", "closed"] as const;
const NO_PRS: PrSummary[] = [];
const ROW_PREFIX = "row/";
const ICON = 13;

export interface SidebarData {
  model: SidebarModel;
  rows: SessionRow[];
  thisRow: SessionRow | undefined;
  prsTopic: string | null;
  prsTopicFailed: boolean;
  prsError: string | null;
  prsLoading: boolean;
  prsHasMore: boolean;
  prsLoadingMore: boolean;
}

export interface SectionFocus {
  id: SidebarSectionId;
  nonce: number;
}

export function useGitGlassSidebarData({
  scope,
  sessionId,
  log,
  homePath,
  active
}: {
  scope: HistoryScope;
  sessionId: string | null;
  log: HistoryLog | null;
  homePath: string | null;
  active: boolean;
}): SidebarData {
  const rows = useSessions();
  const thisRow = useMemo(() => (sessionId ? rows.find((row) => row.session.id === sessionId) : undefined), [rows, sessionId]);
  const projectId = "projectId" in scope ? scope.projectId : (thisRow?.session.projectId ?? null);
  const summaries = usePrSummaries();
  const github = log?.github ?? null;
  const prsTopic = active && github ? githubViewTopic("pr", normalizeQuery(`repo:${github.owner}/${github.repo} is:open`)) : null;
  const viewState = useTopic<Partial<GitHubViewTopicData>>(prsTopic);
  const viewData = viewState?.data;
  const openPrs = useMemo(
    () =>
      viewData
        ? orderedEntries<GitHubRow>(viewData as Record<string, unknown>, ROW_PREFIX).flatMap((row) => (row.subject.kind === "pr" ? [row.subject.pr] : []))
        : NO_PRS,
    [viewData]
  );
  const view = viewData?.view;
  const prsTopicFailed = prsTopic !== null && viewState?.status === "error";
  const prsError = prsTopic === null ? null : prsTopicFailed ? (viewState?.error ?? "GitHub is unavailable") : (view?.error ?? null);
  const prsLoading =
    prsTopic !== null && prsError === null && openPrs.length === 0 && (viewState === undefined || viewState.status === "subscribing" || (view?.loading ?? true));
  const openCount = prsTopic !== null && view ? view.openCount : null;
  const model = useMemo(
    () => buildSidebarModel({ log, rows, projectId, sessionId, homePath, openPrs, openCount, summaries }),
    [log, rows, projectId, sessionId, homePath, openPrs, openCount, summaries]
  );
  return {
    model,
    rows,
    thisRow,
    prsTopic,
    prsTopicFailed,
    prsError,
    prsLoading,
    prsHasMore: prsTopic !== null && (view?.hasMore ?? false),
    prsLoadingMore: view?.loadingMore ?? false
  };
}

function Section({
  id,
  title,
  count,
  defaultOpen,
  forceOpen,
  focus,
  children
}: {
  id: SidebarSectionId;
  title: string;
  count: number | null;
  defaultOpen: boolean;
  forceOpen: boolean;
  focus: SectionFocus | null;
  children: ReactNode;
}) {
  const [state, setState] = usePersistedChoice(`cw-code:git-glass-section-${id}`, SECTION_STATES, defaultOpen ? "open" : "closed");
  const ref = useRef<HTMLElement>(null);
  const bodyId = useId();
  const open = forceOpen || state === "open";
  const focusNonce = focus?.id === id ? focus.nonce : 0;

  useEffect(() => {
    if (focusNonce === 0) return;
    setState("open");
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "start" }));
  }, [focusNonce]);

  return (
    <section ref={ref} className={`gg-sb-sec${open ? "" : " collapsed"}`} aria-label={title}>
      <button
        type="button"
        className="gg-sb-sec-h"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-disabled={forceOpen ? "true" : undefined}
        title={forceOpen ? "Clear the filter to collapse sections" : undefined}
        onClick={() => {
          if (!forceOpen) setState(open ? "closed" : "open");
        }}
      >
        <ChevronDown size={12} className="gg-sb-chev" aria-hidden="true" />
        <span>{title}</span>
        {count !== null && <span className="gg-sb-count">{count}</span>}
      </button>
      <div id={bodyId} className="gg-sb-sec-b" hidden={!open}>
        {open && children}
      </div>
    </section>
  );
}

function Item({
  selected,
  icon,
  label,
  sub,
  mono,
  end,
  action,
  title,
  onClick,
  onDoubleClick
}: {
  selected: boolean;
  icon: ReactNode;
  label: ReactNode;
  sub?: ReactNode;
  mono?: boolean;
  end?: ReactNode;
  action?: ReactNode;
  title?: string;
  onClick: () => void;
  onDoubleClick?: () => void;
}) {
  return (
    <div className={`gg-sb-item${selected ? " sel" : ""}${sub ? " two" : ""}${action ? " has-act" : ""}`}>
      <button type="button" className="gg-sb-main" onClick={onClick} onDoubleClick={onDoubleClick} title={title} aria-current={selected ? "true" : undefined}>
        <span className="gg-sb-icon">{icon}</span>
        <span className="gg-sb-text">
          <span className={`gg-sb-name${mono ? " mono" : ""}`}>{label}</span>
          {sub && <span className="gg-sb-sub">{sub}</span>}
        </span>
        {end && <span className="gg-sb-end">{end}</span>}
      </button>
      {action && <span className="gg-sb-act">{action}</span>}
    </div>
  );
}

function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  if (ahead === 0 && behind === 0) return null;
  return (
    <span className="gg-ab">
      {ahead > 0 && (
        <span aria-label={`${ahead} ahead`}>
          <ArrowUp size={11} aria-hidden="true" />
          {ahead}
        </span>
      )}
      {behind > 0 && (
        <span aria-label={`${behind} behind`}>
          <ArrowDown size={11} aria-hidden="true" />
          {behind}
        </span>
      )}
    </span>
  );
}

function PrIcon({ pr }: { pr: SidebarPr }) {
  return <GitPullRequest size={ICON} className={`gg-sb-pr tone-${prTone(pr)}`} aria-hidden="true" />;
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function ThisSession({
  sessionId,
  row,
  status,
  branch,
  selection,
  focus,
  onSelect
}: {
  sessionId: string;
  row: SessionRow | undefined;
  status: GitStatus | null;
  branch: string | null;
  selection: GitGlassSelection | null;
  focus: SectionFocus | null;
  onSelect: (selection: GitGlassSelection) => void;
}) {
  const linked = useSessionLinkedPrs(sessionId);
  const selectedPr = selection?.kind === "pr" ? prKey(selection.ref) : null;
  const baseRef = status?.available ? status.baseRef : null;
  const worktreePath = row?.session.worktreePath ?? null;
  return (
    <Section id="session" title="This session" count={null} defaultOpen forceOpen={false} focus={focus}>
      <div className="gg-sb-this">
        <Item
          selected={selection?.kind === "changes" && selection.mode === "branch"}
          icon={<GitBranch size={ICON} aria-hidden="true" />}
          label={branch ?? "No branch"}
          mono
          end={status?.available && baseRef ? <AheadBehind ahead={status.baseAhead} behind={status.baseBehind} /> : null}
          title={baseRef ? `Compare ${branch ?? "this branch"} with ${baseRef}` : "Compare this branch with its base"}
          onClick={() => onSelect({ kind: "changes", mode: "branch" })}
        />
        {linked.map((item) => (
          <Item
            key={item.key}
            selected={selectedPr === item.key}
            icon={<GitPullRequest size={ICON} className={`gg-sb-pr tone-${item.chip.tone}`} aria-hidden="true" />}
            label={`#${item.ref.number} ${item.title ?? ""}`.trim()}
            end={<PrChipBadge chip={item.chip} />}
            title={item.title ?? `Pull request #${item.ref.number}`}
            onClick={() => onSelect({ kind: "pr", ref: item.ref })}
          />
        ))}
        {row && (
          <div className="gg-sb-status">
            <span className={`gg-sb-dot status-${sessionDotStatus(row)}`} aria-hidden="true" />
            <span className="gg-sb-text">
              <span className="gg-sb-name">{sessionStatusText(row)}</span>
              <span className="gg-sb-sub">{worktreePath ? joinParts([worktreePath.split(/[\\/]/).filter(Boolean).pop(), "worktree"]) : "main checkout"}</span>
            </span>
          </div>
        )}
      </div>
    </Section>
  );
}

function BranchItem({
  branch,
  pr,
  elsewhere,
  selected,
  busy,
  onSelect,
  onCheckout
}: {
  branch: HistoryRef;
  pr: SidebarPr | null;
  elsewhere: HistoryWorktree | undefined;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onCheckout: () => void;
}) {
  const remote = branch.kind === "remote";
  const icon = branch.isCurrent ? (
    <Check size={ICON} className="gg-sb-current" aria-hidden="true" />
  ) : remote ? (
    <Cloud size={ICON} aria-hidden="true" />
  ) : (
    <GitBranch size={ICON} aria-hidden="true" />
  );
  const command = remote ? `git switch --track ${branch.name}` : `git switch ${branch.name}`;
  const title = branch.isCurrent
    ? `${branch.name} — checked out here`
    : elsewhere
      ? `${branch.name} — checked out in the worktree ${elsewhere.name}; double-click opens its history`
      : busy
        ? `${branch.name} — wait for the running action to finish before checking out`
        : `${branch.name} — double-click to check out (${command})`;
  return (
    <Item
      selected={selected}
      icon={icon}
      label={<span className={branch.isCurrent ? "gg-sb-strong" : undefined}>{branch.name}</span>}
      mono
      title={title}
      end={
        <>
          {branch.upstreamGone ? <span className="gg-sb-warn">gone</span> : <AheadBehind ahead={branch.ahead} behind={branch.behind} />}
          {pr && (
            <span className="gg-sb-prmark" title={pr.title ?? `Pull request #${pr.ref.number}`}>
              <PrIcon pr={pr} />#{pr.ref.number}
            </span>
          )}
          {elsewhere && <GitFork size={12} role="img" aria-label={`Checked out in ${elsewhere.name}`} />}
        </>
      }
      onClick={onSelect}
      onDoubleClick={branch.isCurrent || (busy && !elsewhere) ? undefined : onCheckout}
    />
  );
}

export function GitGlassSidebarStrip({
  data,
  sessionScope,
  overlay,
  onToggle,
  onSection
}: {
  data: SidebarData;
  sessionScope: boolean;
  overlay: boolean;
  onToggle: () => void;
  onSection: (id: SidebarSectionId) => void;
}) {
  const counts = useMemo(() => sectionCounts(data.model), [data.model]);
  const entries: Array<{ id: SidebarSectionId; label: string; icon: LucideIcon; count: number | null }> = [
    ...(sessionScope ? [{ id: "session" as const, label: "This session", icon: GitBranch, count: null }] : []),
    { id: "sessions", label: "Sessions", icon: MessagesSquare, count: counts.sessions },
    { id: "prs", label: "Pull requests", icon: GitPullRequest, count: counts.prs },
    { id: "branches", label: "Branches", icon: GitBranch, count: counts.branches },
    { id: "worktrees", label: "Worktrees", icon: GitFork, count: counts.worktrees },
    { id: "tags", label: "Tags", icon: Tag, count: counts.tags },
    { id: "stashes", label: "Stashes", icon: Archive, count: counts.stashes }
  ];
  return (
    <aside className="gg-strip" aria-label="Repository sections">
      <button
        type="button"
        className={`gg-icon-btn${overlay ? " on" : ""}`}
        onClick={onToggle}
        title={overlay ? "Hide the sidebar" : "Show the sidebar"}
        aria-label="Toggle the sidebar"
        aria-pressed={overlay}
      >
        <PanelLeft size={15} aria-hidden="true" />
      </button>
      <span className="gg-strip-sep" aria-hidden="true" />
      {entries.map(({ id, label, icon: Icon, count }) => (
        <button
          key={id}
          type="button"
          className="gg-icon-btn gg-strip-btn"
          onClick={() => onSection(id)}
          title={count === null ? label : `${label} · ${count}`}
          aria-label={count === null ? label : `${label}, ${count}`}
        >
          <Icon size={15} aria-hidden="true" />
          {count !== null && count > 0 && <span className="gg-strip-badge">{count > 99 ? "99+" : count}</span>}
        </button>
      ))}
    </aside>
  );
}

function RemoteBranchGroup({ remote, count, forceOpen, children }: { remote: string; count: number; forceOpen: boolean; children: ReactNode }) {
  const [state, setState] = usePersistedChoice(`cw-code:git-glass-remote-${remote}`, SECTION_STATES, "closed");
  const bodyId = useId();
  const open = forceOpen || state === "open";
  return (
    <>
      <button
        type="button"
        className="gg-sb-group"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-disabled={forceOpen ? "true" : undefined}
        onClick={() => {
          if (!forceOpen) setState(open ? "closed" : "open");
        }}
      >
        <ChevronDown size={11} className="gg-sb-chev" aria-hidden="true" />
        Only on {remote} · {count}
      </button>
      <div id={bodyId} hidden={!open}>
        {open && children}
      </div>
    </>
  );
}

export function GitGlassSidebar({
  data,
  sessionId,
  log,
  logFailure,
  status,
  sessionBranch,
  activePath,
  selection,
  worktreeBranches,
  busy,
  focus,
  onSelect,
  onCheckout,
  onOpenSession
}: {
  data: SidebarData;
  sessionId: string | null;
  log: HistoryLog | null;
  logFailure: string | null;
  status: GitStatus | null;
  sessionBranch: string | null;
  activePath: string | null;
  selection: GitGlassSelection | null;
  worktreeBranches: ReadonlyMap<string, HistoryWorktree>;
  busy: boolean;
  focus: SectionFocus | null;
  onSelect: (selection: GitGlassSelection) => void;
  onCheckout: (branch: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [linkingKey, setLinkingKey] = useState<string | null>(null);
  const [sidebarError, setSidebarError] = useState("");
  const filtering = filter.trim() !== "";
  const model = useMemo(() => filterSidebarModel(data.model, filter), [data.model, filter]);
  const counts = useMemo(() => sectionCounts(model), [model]);
  const allPrs = data.model.prs;
  const selectedSha = selection?.kind === "commit" ? selection.sha : null;
  const selectedPr = selection?.kind === "pr" ? prKey(selection.ref) : null;
  const remotes = useMemo(() => remoteGroups(model.remoteBranches), [model.remoteBranches]);
  const hiddenPrs = data.model.hiddenOpenPrs;
  const github = log?.github ?? null;
  const unavailable = logFailure ? "Unavailable while the history cannot be loaded." : null;

  const link = (pr: SidebarPr): void => {
    if (!sessionId || !pr.headRefOid || linkingKey !== null) return;
    setLinkingKey(pr.key);
    setSidebarError("");
    window.cw
      .linkSessionPr(sessionId, { ref: pr.ref, origin: "linked", lastSeenSha: pr.headRefOid, lastSeenAt: Date.now() })
      .then(
        () => setSidebarError(""),
        (reason: unknown) => setSidebarError(`Could not link #${pr.ref.number}: ${errorMessage(reason)}`)
      )
      .finally(() => setLinkingKey(null));
  };

  const retryPrs = (): void => {
    const topic = data.prsTopic;
    if (!topic) return;
    setSidebarError("");
    if (data.prsTopicFailed) {
      acquireTopic(topic)();
      return;
    }
    window.cw.refreshGitHubView(topic, true).catch((reason: unknown) => setSidebarError(`Could not reload pull requests: ${errorMessage(reason)}`));
  };

  const loadMorePrs = (): void => {
    const topic = data.prsTopic;
    if (!topic || data.prsLoadingMore) return;
    setSidebarError("");
    window.cw.loadMoreGitHubView(topic).catch((reason: unknown) => setSidebarError(`Could not load more pull requests: ${errorMessage(reason)}`));
  };

  const branchItem = (branch: HistoryRef) => (
    <BranchItem
      key={branch.fullName}
      branch={branch}
      pr={prForBranch(allPrs, branch)}
      elsewhere={branch.kind === "local" ? worktreeBranches.get(branch.name) : undefined}
      selected={selectedSha === branch.target}
      busy={busy}
      onSelect={() => onSelect({ kind: "commit", sha: branch.target })}
      onCheckout={() => onCheckout(branch.name)}
    />
  );

  return (
    <>
      <div className="gg-sb-filter">
        <label className="gg-sb-filter-box">
          <Search size={12} aria-hidden="true" />
          <input
            className="gg-sb-filter-input"
            value={filter}
            placeholder="Filter the sidebar"
            aria-label="Filter the sidebar"
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter) {
                event.preventDefault();
                event.stopPropagation();
                setFilter("");
              }
            }}
          />
          {filter && (
            <button type="button" className="gg-icon-btn sm" onClick={() => setFilter("")} title="Clear the filter" aria-label="Clear the filter">
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </label>
      </div>
      {sidebarError && (
        <div className="pr-view-error gg-sb-error" role="alert">
          <span>{sidebarError}</span>
          <button type="button" className="pr-view-retry" onClick={() => setSidebarError("")}>
            Dismiss
          </button>
        </div>
      )}
      <div className="gg-sb-scroll">
        {sessionId && (
          <ThisSession
            sessionId={sessionId}
            row={data.thisRow}
            status={status}
            branch={(status?.available ? status.branch : null) || sessionBranch}
            selection={selection}
            focus={focus}
            onSelect={onSelect}
          />
        )}

        <Section id="sessions" title="Sessions" count={counts.sessions} defaultOpen forceOpen={filtering} focus={focus}>
          {model.sessions.length === 0 && <div className="gg-sb-note">{filtering ? "No session matches." : "No open sessions in this project."}</div>}
          {model.sessions.map((row) => {
            const id = row.session.id;
            const firstPr = row.session.prs?.[0]?.ref ?? null;
            const isThis = id === sessionId;
            return (
              <Item
                key={id}
                selected={selection?.kind === "session" && selection.sessionId === id}
                icon={<span className={`gg-sb-dot status-${sessionDotStatus(row)}`} aria-hidden="true" />}
                label={
                  <>
                    {row.session.title}
                    {isThis && <span className="gg-tag me gg-sb-inline-tag">this</span>}
                  </>
                }
                sub={joinParts([
                  row.branch ?? row.session.branch,
                  row.session.worktreePath ? null : "folder session",
                  row.session.status === "idle" && !row.busy ? null : sessionStatusText(row)
                ])}
                end={firstPr ? `#${firstPr.number}` : null}
                title={row.session.title}
                action={
                  isThis ? undefined : (
                    <button type="button" className="gg-mini" onClick={() => onOpenSession(id)} title={`Open “${row.session.title}”`}>
                      Open
                    </button>
                  )
                }
                onClick={() => onSelect({ kind: "session", sessionId: id })}
              />
            );
          })}
        </Section>

        <Section id="prs" title="Pull requests" count={counts.prs} defaultOpen forceOpen={filtering} focus={focus}>
          {data.prsError && (
            <div className="pr-view-error gg-sb-inline-error" role="alert">
              <span>Open pull requests unavailable: {data.prsError}</span>
              <button type="button" className="pr-view-retry" onClick={retryPrs}>
                Retry
              </button>
            </div>
          )}
          {log && !log.github && <div className="gg-sb-note">No GitHub remote — only pull requests linked to sessions are listed.</div>}
          {data.prsLoading && <div className="gg-sb-note">Loading open pull requests…</div>}
          {model.prs.length === 0 && !data.prsLoading && !data.prsError && (log?.github || filtering) && (
            <div className="gg-sb-note">{filtering ? "No pull request matches." : "No open pull requests."}</div>
          )}
          {model.prs.map((pr) => {
            const canLink = sessionId !== null && pr.sessionId === null && pr.headRefOid !== null;
            return (
              <Item
                key={pr.key}
                selected={selectedPr === pr.key}
                icon={<PrIcon pr={pr} />}
                label={pr.title ?? `Pull request #${pr.ref.number}`}
                title={pr.title ?? `Pull request #${pr.ref.number}`}
                end={
                  <>
                    {pr.linkedHere ? (
                      <span className="gg-tag me">this session</span>
                    ) : pr.sessionTitle ? (
                      <span className="gg-tag" title={`Linked to “${pr.sessionTitle}”`}>
                        session
                      </span>
                    ) : null}
                    <span>#{pr.ref.number}</span>
                  </>
                }
                action={
                  canLink ? (
                    <button
                      type="button"
                      className="gg-mini"
                      aria-disabled={linkingKey !== null ? "true" : undefined}
                      onClick={() => link(pr)}
                      title={`Link #${pr.ref.number} to this session`}
                    >
                      {linkingKey === pr.key ? "Linking…" : "Link"}
                    </button>
                  ) : undefined
                }
                onClick={() => onSelect({ kind: "pr", ref: pr.ref })}
              />
            );
          })}
          {hiddenPrs > 0 && !filtering && (
            <div className="gg-sb-more">
              <span>
                {hiddenPrs} more open on GitHub
              </span>
              {data.prsHasMore && (
                <button type="button" className="gg-mini" aria-disabled={data.prsLoadingMore ? "true" : undefined} onClick={loadMorePrs}>
                  {data.prsLoadingMore ? "Loading…" : "Load more"}
                </button>
              )}
              {github && (
                <button
                  type="button"
                  className="gg-mini"
                  onClick={() => openExternalLink(`https://github.com/${github.owner}/${github.repo}/pulls`)}
                  title={`Open the pull requests of ${github.owner}/${github.repo} on GitHub`}
                >
                  GitHub
                </button>
              )}
            </div>
          )}
          {data.model.hiddenOpenPrs > 0 && filtering && (
            <div className="gg-sb-note">The filter covers loaded pull requests only; {data.model.hiddenOpenPrs} more are on GitHub.</div>
          )}
        </Section>

        <Section id="branches" title="Branches" count={counts.branches} defaultOpen forceOpen={filtering} focus={focus}>
          {model.branches.length === 0 && model.remoteBranches.length === 0 && (
            <div className="gg-sb-note">{filtering ? "No branch matches." : log ? "No branches yet." : (unavailable ?? "Loading branches…")}</div>
          )}
          {model.branches.map(branchItem)}
          {remotes.map((group) => (
            <RemoteBranchGroup key={group.remote} remote={group.remote} count={group.refs.length} forceOpen={filtering}>
              {group.refs.map(branchItem)}
            </RemoteBranchGroup>
          ))}
        </Section>

        <Section id="worktrees" title="Worktrees" count={counts.worktrees} defaultOpen forceOpen={filtering} focus={focus}>
          {model.worktrees.length === 0 && <div className="gg-sb-note">{filtering ? "No worktree matches." : log ? "No worktrees." : (unavailable ?? "Loading worktrees…")}</div>}
          {model.worktrees.map(({ worktree, owner, isHome }) => {
            const viewing = worktree.path === activePath;
            return (
              <Item
                key={worktree.path}
                selected={selection?.kind === "worktree" && selection.path === worktree.path}
                icon={worktree.isMain ? <Folder size={ICON} aria-hidden="true" /> : <GitFork size={ICON} aria-hidden="true" />}
                label={
                  <>
                    {worktree.name}
                    {isHome && sessionId && <span className="gg-tag me gg-sb-inline-tag">this</span>}
                  </>
                }
                sub={joinParts([worktree.branch ?? "detached", worktree.isMain ? "main checkout" : null, owner?.session.title])}
                end={viewing ? <Eye size={12} role="img" aria-label="Viewing its history" /> : null}
                title={worktree.path}
                onClick={() => onSelect({ kind: "worktree", path: worktree.path })}
              />
            );
          })}
        </Section>

        <Section id="tags" title="Tags" count={counts.tags} defaultOpen={false} forceOpen={filtering} focus={focus}>
          {model.tags.length === 0 && <div className="gg-sb-note">{filtering ? "No tag matches." : log ? "No tags." : (unavailable ?? "Loading tags…")}</div>}
          {model.tags.map((tag) => (
            <Item
              key={tag.fullName}
              selected={selectedSha === tag.target}
              icon={<Tag size={ICON} aria-hidden="true" />}
              label={tag.name}
              mono
              title={`Tag ${tag.name}`}
              onClick={() => onSelect({ kind: "commit", sha: tag.target })}
            />
          ))}
        </Section>

        <Section id="stashes" title="Stashes" count={counts.stashes} defaultOpen={false} forceOpen={filtering} focus={focus}>
          {model.stashes.length === 0 && <div className="gg-sb-note">{filtering ? "No stash matches." : log ? "No stashes." : (unavailable ?? "Loading stashes…")}</div>}
          {model.stashes.map(({ ref, subject }) => (
            <Item
              key={ref.fullName}
              selected={selectedSha === ref.target}
              icon={<Archive size={ICON} aria-hidden="true" />}
              label={subject || ref.name}
              sub={subject ? ref.name : undefined}
              title={subject ? `${ref.name}: ${subject}` : ref.name}
              onClick={() => onSelect({ kind: "commit", sha: ref.target })}
            />
          ))}
        </Section>
      </div>
    </>
  );
}
