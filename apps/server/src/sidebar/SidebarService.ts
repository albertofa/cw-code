import type {
  BabysitState,
  GitStatus,
  PrDetail,
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
  babysit(sessionId: string): BabysitState | null;
  sidebarOrder(): SidebarOrderPrefs | null;
  setSidebarOrder(order: SidebarOrderPrefs): void;
  publishAttention(count: number): void;
  watchWorkingSet(sessionIds: string[]): void;
}

export type SidebarStatusAction = "resolve" | "restore";

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
  private layout: SidebarLayout;
  private attention = 0;
  private publishedAttention: number | null = null;
  private watchedKey: string | null = null;
  private scheduled = false;

  constructor(
    hub: TopicHub,
    private readonly deps: SidebarServiceDeps
  ) {
    const computed = this.compute();
    this.layout = computed.layout;
    this.store = hub.createStore<SidebarTopicData>(SIDEBAR_TOPIC, computed.data);
    this.applySideEffects(computed);
  }

  owns(topic: string): boolean {
    return topic === SIDEBAR_TOPIC;
  }

  acquire(): TopicStore<SidebarTopicData> {
    return this.store;
  }

  release(): void {}

  watch(...sources: ChangeSource[]): () => void {
    const stops = sources.map((source) => source(() => this.invalidate()));
    return () => {
      for (const stop of stops) stop();
    };
  }

  invalidate(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      if (this.scheduled) this.recompute();
    });
  }

  attentionCount(): number {
    return this.attention;
  }

  reorder(request: SidebarReorderRequest): SidebarStatusAction | null {
    this.recompute();
    const away = new Set([...this.layout.needsYou.map((entry) => entry.sessionId), ...this.layout.workingSet]);
    const result = reorderSidebar(this.deps.sidebarOrder(), { main: this.layout.main, resolved: this.layout.resolved }, away, request);
    if (!result) return null;
    this.deps.setSidebarOrder(result.order);
    if (result.statusChange === "resolved") return "resolve";
    if (result.statusChange !== "idle") return null;
    const session = this.deps.sessions().find((item) => item.id === request.sessionId);
    return session?.status === "resolved" ? "restore" : null;
  }

  private recompute(): void {
    this.scheduled = false;
    try {
      const computed = this.compute();
      this.layout = computed.layout;
      this.store.sync(computed.data);
      this.applySideEffects(computed);
    } catch (error) {
      console.warn(`${LOG_PREFIX} recompute failed: ${describeError(error)}`);
    }
  }

  private applySideEffects(computed: Computed): void {
    this.attention = computed.attentionCount;
    if (this.publishedAttention !== computed.attentionCount) {
      this.publishedAttention = computed.attentionCount;
      this.deps.publishAttention(computed.attentionCount);
    }
    const watchedKey = computed.watchedIds.join("|");
    if (this.watchedKey !== watchedKey) {
      this.watchedKey = watchedKey;
      this.deps.watchWorkingSet(computed.watchedIds);
    }
  }

  private compute(): Computed {
    const allSessions = this.deps.sessions();
    const projects = this.deps.projects();
    const sessions = allSessions.filter((session) => session.status !== "archived");
    const lookup = this.deps.summaryLookup();
    const rows = new Map(sessions.map((session) => [session.id, this.row(session, lookup)]));
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
      watchedIds: sessions.filter((session) => isWorkingSetStatus(session.status)).map((session) => session.id).sort()
    };
  }

  private row(session: SessionMeta, lookup: PrSummaryLookup): SessionRow {
    const runtime = this.deps.runtime(session.id);
    const git = this.deps.gitStatus(session.id);
    const links = sessionLinks(session);
    const detailByKey: Record<string, PrDetail> = {};
    for (const link of links) {
      const key = prKey(link.ref);
      const detail = this.deps.detail(key);
      if (detail) detailByKey[key] = detail;
    }
    const babysit = links.length > 0 ? this.deps.babysit(session.id) : null;
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
