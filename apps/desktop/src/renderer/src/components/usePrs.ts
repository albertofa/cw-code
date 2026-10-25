import type { TopicState } from "@cw-code/client";
import type {
  BabysitState,
  GitHubContext,
  PrDetail,
  PrDetailEntry,
  PrInboxState,
  PrRef,
  PrSummary,
  SubjectRelations
} from "@cw-code/contracts";
import { useRef } from "react";
import { prKey } from "@cw-code/shared/prRef";
import { PRS_TOPIC, sessionTopic } from "@cw-code/shared/topics";
import { peekTopic, useTopicEntry, useTopicSelect } from "../server/topics.js";
import { errorMessage } from "./errorMessage.js";
import { useNotifs } from "./Notifications.js";
import { prRefLabel } from "./sessionPrLinks.js";

export type PrSummaryLookup = ReadonlyMap<string, PrSummary>;

const SUMMARY_PREFIX = "summary/";
const DETAIL_PREFIX = "detail/";
const RELATIONS_PREFIX = "rel/";

const NO_SUMMARIES: PrSummaryLookup = new Map();
const NO_ENTRIES: ReadonlyMap<string, PrDetailEntry> = new Map();
const NO_DETAILS: Readonly<Record<string, PrDetail>> = {};
const NO_ITEMS: PrSummary[] = [];

export const EMPTY_GITHUB_CONTEXT: GitHubContext = { viewer: null, org: null, projectRepos: [] };

type TopicData = Record<string, unknown> | undefined;

function sameMap<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of b) if (a.get(key) !== value) return false;
  return true;
}

function prefixedEntries<T>(data: TopicData, prefix: string): Map<string, T> {
  const entries = new Map<string, T>();
  if (!data) return entries;
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith(prefix)) entries.set(key.slice(prefix.length), value as T);
  }
  return entries;
}

type Derive<T> = (data: TopicData, previous: T | undefined) => T;

function useDerived<T>(derive: Derive<T>): T {
  const cache = useRef<{ data: TopicData; value: T } | null>(null);
  return useTopicSelect<T>(PRS_TOPIC, (state: TopicState | undefined) => {
    const data = state?.data;
    const cached = cache.current;
    if (cached && cached.data === data) return cached.value;
    const value = derive(data, cached?.value);
    cache.current = { data, value };
    return value;
  });
}

function stableMap<T>(data: TopicData, prefix: string, previous: ReadonlyMap<string, T> | undefined, empty: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  const next = prefixedEntries<T>(data, prefix);
  if (next.size === 0) return empty;
  return previous && sameMap(previous, next) ? previous : next;
}

export function usePrSummary(key: string | null): PrSummary | undefined {
  return useTopicEntry<PrSummary>(key ? PRS_TOPIC : null, `${SUMMARY_PREFIX}${key ?? ""}`);
}

export function usePrDetail(key: string | null): PrDetailEntry | undefined {
  return useTopicEntry<PrDetailEntry>(key ? PRS_TOPIC : null, `${DETAIL_PREFIX}${key ?? ""}`);
}

function summaryRevision(summary: PrSummary): string {
  const { checks } = summary;
  return [
    summary.updatedAt,
    summary.state,
    summary.isDraft,
    summary.title,
    summary.headRefName,
    summary.headRefOid,
    summary.baseRefName,
    summary.additions,
    summary.deletions,
    summary.changedFiles,
    summary.ci,
    `${checks.total}/${checks.passed}/${checks.failed}/${checks.pending}`,
    summary.unresolvedThreads,
    summary.commentsCount,
    summary.review,
    summary.mergeStateStatus
  ].join(":");
}

function detailRevision(detail: PrDetail): string {
  const checkRuns = detail.checkRuns.map((check) => `${check.name}:${check.status}:${check.completedAt ?? ""}`).join(",");
  const threads = detail.threads.map((thread) => `${thread.id}:${thread.isResolved}:${thread.comments.length}`).join(",");
  const lastEvent = detail.timeline[detail.timeline.length - 1]?.at ?? "";
  return [summaryRevision(detail), detail.body.length, checkRuns, threads, detail.timeline.length, lastEvent, detail.commits.length].join("|");
}

function prDataRevision(summary: PrSummary | undefined, detail: PrDetail | null | undefined): string | null {
  if (!summary && !detail) return null;
  return `${summary ? summaryRevision(summary) : ""}#${detail ? detailRevision(detail) : ""}`;
}

export function usePrDataRevision(key: string | null): string | null {
  const cache = useRef<{ summary: PrSummary | undefined; detail: PrDetail | null | undefined; revision: string | null } | null>(null);
  return useTopicSelect<string | null>(key ? PRS_TOPIC : null, (state) => {
    const data = state?.data as TopicData;
    const summary = data?.[`${SUMMARY_PREFIX}${key ?? ""}`] as PrSummary | undefined;
    const detail = (data?.[`${DETAIL_PREFIX}${key ?? ""}`] as PrDetailEntry | undefined)?.detail;
    const cached = cache.current;
    if (cached && cached.summary === summary && cached.detail === detail) return cached.revision;
    const revision = prDataRevision(summary, detail);
    cache.current = { summary, detail, revision };
    return revision;
  });
}

export function usePrRelations(key: string | null): SubjectRelations | undefined {
  return useTopicEntry<SubjectRelations>(key ? PRS_TOPIC : null, `${RELATIONS_PREFIX}${key ?? ""}`);
}

export function usePrInbox(): PrInboxState | undefined {
  return useTopicEntry<PrInboxState>(PRS_TOPIC, "inbox");
}

export function useGitHubContext(): GitHubContext | undefined {
  return useTopicEntry<GitHubContext>(PRS_TOPIC, "context");
}

const deriveSummaries: Derive<PrSummaryLookup> = (data, previous) => stableMap(data, SUMMARY_PREFIX, previous, NO_SUMMARIES);

const deriveDetailEntries: Derive<ReadonlyMap<string, PrDetailEntry>> = (data, previous) => stableMap(data, DETAIL_PREFIX, previous, NO_ENTRIES);

export function usePrSummaries(): PrSummaryLookup {
  return useDerived(deriveSummaries);
}

export function usePrDetailEntries(): ReadonlyMap<string, PrDetailEntry> {
  return useDerived(deriveDetailEntries);
}

function sameRecord<T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>): boolean {
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
}

const deriveDetails: Derive<Readonly<Record<string, PrDetail>>> = (data, previous) => {
  const next: Record<string, PrDetail> = {};
  for (const [key, entry] of prefixedEntries<PrDetailEntry>(data, DETAIL_PREFIX)) {
    if (entry.detail) next[key] = entry.detail;
  }
  if (Object.keys(next).length === 0) return NO_DETAILS;
  return previous && sameRecord(previous, next) ? previous : next;
};

export function usePrDetails(): Readonly<Record<string, PrDetail>> {
  return useDerived(deriveDetails);
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

const deriveInboxItems: Derive<PrSummary[]> = (data, previous) => {
  const inbox = data?.inbox as PrInboxState | undefined;
  if (!inbox || inbox.keys.length === 0) return NO_ITEMS;
  const next = inbox.keys.flatMap((key) => {
    const summary = data?.[`${SUMMARY_PREFIX}${key}`] as PrSummary | undefined;
    return summary ? [summary] : [];
  });
  return previous && sameItems(previous, next) ? previous : next;
};

export function usePrInboxItems(): PrSummary[] {
  return useDerived(deriveInboxItems);
}

export function usePrsTopicError(): string | null {
  return useTopicSelect<string | null>(PRS_TOPIC, (state: TopicState | undefined) => (state?.status === "error" ? (state.error ?? "unknown error") : null));
}

export function useHoldPrs(): void {
  useTopicSelect(PRS_TOPIC, () => null);
}

export function useSessionBabysit(sessionId: string | null | undefined): BabysitState | null {
  return useTopicEntry<BabysitState | null>(sessionId ? sessionTopic(sessionId) : null, "babysit") ?? null;
}

export async function requestPrDetail(ref: PrRef): Promise<void> {
  try {
    await window.cw.getPrDetail(ref);
  } catch (err) {
    const message = errorMessage(err);
    console.warn(`[pr] detail load failed for ${prRefLabel(ref)}: ${message}`);
    const key = prKey(ref);
    if (!peekTopic(PRS_TOPIC)?.data?.[`${DETAIL_PREFIX}${key}`]) {
      useNotifs.getState().push({ id: `pr-detail:${key}`, kind: "error", title: `Could not load ${prRefLabel(ref)}`, message });
    }
  }
}
