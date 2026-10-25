import type {
  GitStatus,
  PrDetail,
  PrWorkflow,
  Project,
  SessionMeta,
  SessionRow,
  SidebarDefaults,
  SidebarLayout,
  SidebarOrderPrefs,
  SidebarReorderRequest,
  SidebarTopicData
} from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { SIDEBAR_TOPIC } from "@cw-code/shared/topics";
import type { ChangeSource } from "../app/ShutdownPublisher.js";
import { babysitState } from "../prEngine/babysit.js";
import { firstUnseenPr, needsYouEntries, sessionAttention } from "../prEngine/needsYou.js";
import { displayChip, linksTitle, mostUrgentLink, sessionLinks, type PrSummaryLookup } from "../prEngine/sessionPrLinks.js";
import { latestUnseenPrUpdateAt } from "../prEngine/soundFacts.js";
import type { SessionRuntime } from "../threads/ThreadService.js";
import type { TopicHub, TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import { projectsByRecentActivity } from "./projectRecency.js";
import { reorderSidebar, sidebarSections } from "./sidebarOrder.js";
import { compareWorkingSet, isWorkingSetStatus } from "./workingSet.js";
import { worktreeCandidates } from "./worktreeCandidates.js";

export interface SidebarServiceDeps {
  sessions(): SessionMeta[];
  projects(): Project[];
  runtime(sessionId: string): Pick<SessionRuntime, "busy" | "approvals" | "questions">;
  gitStatus(sessionId: string): GitStatus | null;
  summaryLookup(): PrSummaryLookup;
  detail(key: string): PrDetail | undefined;
  workflows(): PrWorkflow[];
  sidebarOrder(): SidebarOrderPrefs | null;
  setSidebarOrder(order: SidebarOrderPrefs): void;
  publishAttention(count: number): void;
  watchWorkingSet(sessionIds: string[]): void;
}

export type SidebarStatusAction = "resolve" | "restore";

export const MAX_WATCHED_WORKING_SET = 30;

interface Snapshot {
  json: string;
  value: unknown;
}

interface Computed {
  data: SidebarTopicData;
  layout: SidebarLayout;
  attentionCount: number;
  watchedIds: string[];
}

const LOG_PREFIX = "[sidebar]";

const EMPTY_LAYOUT: SidebarLayout = { needsYou: [], workingSet: [], main: [], resolved: [], quickCounts: { pr: 0 } };
const EMPTY_DEFAULTS: SidebarDefaults = { restoreSessionId: null, restoreProjectId: null, projectsByRecency: [] };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isClosed(session: SessionMeta): boolean {
  return session.status === "resolved" || session.status === "archived";
}

function groupByProject(sessions: SessionMeta[]): Record<string, SessionMeta[]> {
  const byProject: Record<string, SessionMeta[]> = {};
  for (const session of sessions) (byProject[session.projectId] ??= []).push(session);
  return byProject;
}

function watchedWorkingSet(sessions: SessionMeta[]): string[] {
  return sessions
    .filter((session) => isWorkingSetStatus(session.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_WATCHED_WORKING_SET)
    .map((session) => session.id)
    .sort();
}

function restoreDefaults(sessions: SessionMeta[], projects: Project[]): Pick<SidebarDefaults, "restoreSessionId" | "restoreProjectId"> {
  const candidates = sessions.filter((session) => session.status !== "archived").sort((a, b) => b.updatedAt - a.updatedAt);
  const picked = candidates.find((session) => !session.autoResolved);
  if (picked) return { restoreSessionId: picked.id, restoreProjectId: picked.projectId };
  return { restoreSessionId: null, restoreProjectId: candidates[0]?.projectId ?? projects[0]?.id ?? null };
}

export class SidebarService implements TopicProvider {
  readonly exactTopics = [SIDEBAR_TOPIC];
  private readonly store: TopicStore<SidebarTopicData>;
  private readonly snapshots = new Map<string, Snapshot>();
  private layout: SidebarLayout = EMPTY_LAYOUT;
  private attention = 0;
  private publishedAttention: number | null = null;
  private workingSetIds: string[] = [];
  private watchedKey: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly hub: TopicHub,
    private readonly deps: SidebarServiceDeps
  ) {
    let computed: Computed | null = null;
    try {
      computed = this.compute();
    } catch (error) {
      console.warn(`${LOG_PREFIX} initial compute failed: ${describeError(error)}`);
    }
    const initial = computed?.data ?? ({ layout: EMPTY_LAYOUT, defaults: EMPTY_DEFAULTS } as SidebarTopicData);
    this.store = hub.createStore<SidebarTopicData>(SIDEBAR_TOPIC, initial);
    if (computed) this.applyComputed(computed);
  }

  owns(topic: string): boolean {
    return topic === SIDEBAR_TOPIC;
  }

  acquire(): TopicStore<SidebarTopicData> {
    return this.store;
  }

  release(): void {}

  onSubscribe(): void {
    this.syncWatched();
  }

  onUnsubscribe(): void {
    this.syncWatched();
  }

  resync(): void {
    this.syncWatched();
  }

  watch(...sources: ChangeSource[]): () => void {
    const stops = sources.map((source) => source(() => this.invalidate()));
    return () => {
      for (const stop of stops) stop();
    };
  }

  invalidate(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.recompute();
    }, 0);
    this.timer.unref?.();
  }

  attentionCount(): number {
    return this.attention;
  }

  async reorder(request: SidebarReorderRequest, apply: (action: SidebarStatusAction) => Promise<unknown>): Promise<void> {
    this.recompute();
    const away = new Set([...this.layout.needsYou.map((entry) => entry.sessionId), ...this.layout.workingSet]);
    const result = reorderSidebar(this.deps.sidebarOrder(), { main: this.layout.main, resolved: this.layout.resolved }, away, request);
    if (!result) return;
    const action = this.statusAction(request.sessionId, result.statusChange);
    if (action) await apply(action);
    this.deps.setSidebarOrder(result.order);
  }

  private statusAction(sessionId: string, change: "idle" | "resolved" | null): SidebarStatusAction | null {
    if (change === "resolved") return "resolve";
    if (change !== "idle") return null;
    const session = this.deps.sessions().find((item) => item.id === sessionId);
    return session?.status === "resolved" ? "restore" : null;
  }

  private recompute(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      const computed = this.compute();
      this.store.sync(computed.data);
      this.applyComputed(computed);
    } catch (error) {
      console.warn(`${LOG_PREFIX} recompute failed: ${describeError(error)}`);
    }
  }

  private applyComputed(computed: Computed): void {
    this.layout = computed.layout;
    this.attention = computed.attentionCount;
    if (this.publishedAttention !== computed.attentionCount) {
      this.publishedAttention = computed.attentionCount;
      this.deps.publishAttention(computed.attentionCount);
    }
    this.workingSetIds = computed.watchedIds;
    this.syncWatched();
  }

  private syncWatched(): void {
    const watched = this.hub.subscribers(SIDEBAR_TOPIC) > 0 ? this.workingSetIds : [];
    const watchedKey = watched.join("|");
    if (this.watchedKey === watchedKey) return;
    this.watchedKey = watchedKey;
    this.deps.watchWorkingSet(watched);
  }

  private compute(): Computed {
    const allSessions = this.deps.sessions();
    const projects = this.deps.projects();
    const sessions = allSessions.filter((session) => session.status !== "archived");
    const lookup = this.deps.summaryLookup();
    const workflows = this.deps.workflows();
    const rows = new Map(allSessions.map((session) => [session.id, this.row(session, lookup, workflows)]));
    const needsYou = needsYouEntries(
      sessions,
      (session) => rows.get(session.id)?.attention ?? null,
      (session) => rows.get(session.id)?.babysit?.phase.kind ?? null
    );
    const needsYouIds = new Set(needsYou.map((entry) => entry.session.id));
    const workingSet = sessions.filter((session) => isWorkingSetStatus(session.status) && !needsYouIds.has(session.id)).sort(compareWorkingSet);
    const away = new Set([...needsYouIds, ...workingSet.map((session) => session.id)]);
    const sections = sidebarSections(sessions, this.deps.sidebarOrder(), away);
    const layout: SidebarLayout = {
      needsYou: needsYou.map((entry) => ({ sessionId: entry.session.id, slot: entry.slot })),
      workingSet: workingSet.map((session) => session.id),
      main: sections.main.map((session) => session.id),
      resolved: sections.resolved.map((session) => session.id),
      quickCounts: { pr: workingSet.filter((session) => !isClosed(session) && sessionLinks(session).length > 0).length }
    };
    const byProject = groupByProject(allSessions);
    const defaults: SidebarDefaults = {
      ...restoreDefaults(allSessions, projects),
      projectsByRecency: projectsByRecentActivity(projects, byProject).map((project) => project.id)
    };
    const entries: Record<string, unknown> = { layout, defaults };
    for (const project of projects) {
      entries[`project/${project.id}`] = project;
      entries[`worktrees/${project.id}`] = worktreeCandidates(byProject[project.id] ?? []);
    }
    for (const [sessionId, row] of rows) entries[`row/${sessionId}`] = row;
    const data = this.stabilize(entries);
    return {
      data: data as SidebarTopicData,
      layout: data.layout as SidebarLayout,
      attentionCount: needsYou.filter((entry) => entry.slot !== "running").length,
      watchedIds: watchedWorkingSet(sessions)
    };
  }

  private row(session: SessionMeta, lookup: PrSummaryLookup, workflows: PrWorkflow[]): SessionRow {
    const runtime = this.deps.runtime(session.id);
    const git = this.deps.gitStatus(session.id);
    const links = sessionLinks(session);
    const detailByKey: Record<string, PrDetail> = {};
    for (const link of links) {
      const key = prKey(link.ref);
      const detail = this.deps.detail(key);
      if (detail) detailByKey[key] = detail;
    }
    const babysit =
      links.length > 0
        ? babysitState(session, lookup, workflows, {
            busy: runtime.busy,
            paused: session.autoFollowUp?.paused,
            autoTurns: session.autoFollowUp?.turns ?? 0
          })
        : null;
    const gitPr = git?.pullRequest ?? null;
    const urgent = mostUrgentLink(links, lookup, gitPr);
    const chip = urgent ? displayChip(urgent, lookup, gitPr) : null;
    return {
      session,
      busy: runtime.busy,
      branch: git?.branch ?? session.branch ?? null,
      attention: sessionAttention({
        session,
        approvals: runtime.approvals,
        questions: runtime.questions,
        unseenPr: firstUnseenPr(session, lookup, detailByKey)
      }),
      babysit,
      prBadge: chip ? { chip, title: links.length > 1 ? linksTitle(links, lookup, gitPr) : chip.title, linkCount: links.length } : null,
      pendingQuestionIds: runtime.questions.map((request) => request.requestId),
      latestUnseenPrUpdateAt: isClosed(session) ? null : latestUnseenPrUpdateAt(session, lookup, detailByKey),
      prMuted: babysit !== null
    };
  }

  private stabilize(entries: Record<string, unknown>): Record<string, unknown> {
    const stable: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entries)) {
      const json = JSON.stringify(value);
      const cached = this.snapshots.get(key);
      if (cached?.json === json) {
        stable[key] = cached.value;
        continue;
      }
      const copy: unknown = JSON.parse(json);
      this.snapshots.set(key, { json, value: copy });
      stable[key] = copy;
    }
    for (const key of this.snapshots.keys()) if (!Object.hasOwn(entries, key)) this.snapshots.delete(key);
    return stable;
  }
}
