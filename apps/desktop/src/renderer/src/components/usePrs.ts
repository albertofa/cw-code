import type { TopicState } from "@cw-code/client";
import type {
  BabysitState,
  GitHubContext,
  PrDetail,
  PrDetailEntry,
  PrInboxState,
  PrRef,
  PrSummary,
  ProjectGitHubRepo,
  RepoRef,
  SubjectRelations
} from "@cw-code/contracts";
import { PRS_TOPIC, sessionTopic } from "@cw-code/shared/topics";
import { useTopicEntry, useTopicSelect } from "../server/topics.js";
import { errorMessage } from "./errorMessage.js";
import { prRefLabel, type PrSummaryLookup } from "./sessionPrLinks.js";

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

interface Derived<T> {
  derive(data: TopicData, previous: T | undefined): T;
  cached: { data: TopicData; value: T } | null;
}

function derived<T>(derive: (data: TopicData, previous: T | undefined) => T): Derived<T> {
  return { derive, cached: null };
}

function readDerived<T>(source: Derived<T>, data: TopicData): T {
  const cached = source.cached;
  if (cached && cached.data === data) return cached.value;
  const value = source.derive(data, cached?.value);
  source.cached = { data, value };
  return value;
}

function useDerived<T>(source: Derived<T>): T {
  return useTopicSelect<T>(PRS_TOPIC, (state: TopicState | undefined) => readDerived(source, state?.data));
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

export function usePrRelations(key: string | null): SubjectRelations | undefined {
  return useTopicEntry<SubjectRelations>(key ? PRS_TOPIC : null, `${RELATIONS_PREFIX}${key ?? ""}`);
}

export function usePrInbox(): PrInboxState | undefined {
  return useTopicEntry<PrInboxState>(PRS_TOPIC, "inbox");
}

export function useGitHubContext(): GitHubContext | undefined {
  return useTopicEntry<GitHubContext>(PRS_TOPIC, "context");
}

const summaries = derived<PrSummaryLookup>((data, previous) => stableMap(data, SUMMARY_PREFIX, previous, NO_SUMMARIES));

const detailEntries = derived<ReadonlyMap<string, PrDetailEntry>>((data, previous) => stableMap(data, DETAIL_PREFIX, previous, NO_ENTRIES));

export function usePrSummaries(): PrSummaryLookup {
  return useDerived(summaries);
}

export function usePrDetailEntries(): ReadonlyMap<string, PrDetailEntry> {
  return useDerived(detailEntries);
}

function sameRecord<T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>): boolean {
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
}

const details = derived<Readonly<Record<string, PrDetail>>>((data, previous) => {
  const next: Record<string, PrDetail> = {};
  for (const [key, entry] of prefixedEntries<PrDetailEntry>(data, DETAIL_PREFIX)) {
    if (entry.detail) next[key] = entry.detail;
  }
  if (Object.keys(next).length === 0) return NO_DETAILS;
  return previous && sameRecord(previous, next) ? previous : next;
});

export function usePrDetails(): Readonly<Record<string, PrDetail>> {
  return useDerived(details);
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

const inboxItems = derived<PrSummary[]>((data, previous) => {
  const inbox = data?.inbox as PrInboxState | undefined;
  if (!inbox || inbox.keys.length === 0) return NO_ITEMS;
  const next = inbox.keys.flatMap((key) => {
    const summary = data?.[`${SUMMARY_PREFIX}${key}`] as PrSummary | undefined;
    return summary ? [summary] : [];
  });
  return previous && sameItems(previous, next) ? previous : next;
});

export function usePrInboxItems(): PrSummary[] {
  return useDerived(inboxItems);
}

export function useHoldPrs(): void {
  useTopicSelect(PRS_TOPIC, () => null);
}

export function useSessionBabysit(sessionId: string | null | undefined): BabysitState | null {
  return useTopicEntry<BabysitState | null>(sessionId ? sessionTopic(sessionId) : null, "babysit") ?? null;
}

export function projectIdFor(repos: ProjectGitHubRepo[], ref: RepoRef): string | null {
  const host = ref.host.toLowerCase();
  const owner = ref.owner.toLowerCase();
  const repo = ref.repo.toLowerCase();
  const match = repos.find((item) => item.host.toLowerCase() === host && item.owner.toLowerCase() === owner && item.repo.toLowerCase() === repo);
  return match?.projectId ?? null;
}

export async function requestPrDetail(ref: PrRef): Promise<void> {
  try {
    await window.cw.getPrDetail(ref);
  } catch (err) {
    console.warn(`[pr] detail load failed for ${prRefLabel(ref)}: ${errorMessage(err)}`);
  }
}
