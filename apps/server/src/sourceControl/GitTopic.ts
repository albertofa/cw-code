import type { BranchMismatch, GitStatus, GitTopicData, SessionMeta } from "@cw-code/contracts";
import { topicId } from "@cw-code/shared/topics";
import type { TopicHub, TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import { activeBranchMismatch, folderHeadValue, shouldResetKeptHead } from "./branchMismatch.js";

export const GIT_TOPIC_PREFIX = "git/";

export interface GitTopicDeps {
  status(sessionId: string): GitStatus | null;
  failure(sessionId: string): string | null;
  session(sessionId: string): SessionMeta | undefined;
  setWatched(sessionIds: string[]): void;
}

function sessionIdOf(topic: string): string {
  const sessionId = topicId(topic, GIT_TOPIC_PREFIX);
  if (!sessionId) throw new Error(`invalid git topic '${topic}'`);
  return sessionId;
}

export class GitTopic implements TopicProvider {
  private readonly stores = new Map<string, TopicStore<GitTopicData>>();
  private readonly keptHeads = new Map<string, string>();

  constructor(
    private readonly hub: TopicHub,
    private readonly deps: GitTopicDeps
  ) {}

  owns(topic: string): boolean {
    return topic.startsWith(GIT_TOPIC_PREFIX);
  }

  acquire(topic: string): TopicStore<GitTopicData> {
    const sessionId = sessionIdOf(topic);
    const store = this.hub.createStore<GitTopicData>(topic, this.data(sessionId));
    this.stores.set(sessionId, store);
    this.syncWatched();
    return store;
  }

  release(topic: string): void {
    const sessionId = topicId(topic, GIT_TOPIC_PREFIX);
    if (sessionId) this.stores.delete(sessionId);
    this.syncWatched();
  }

  resync(): void {
    this.syncWatched();
  }

  statusChanged(sessionId: string): void {
    const kept = this.keptHeads.get(sessionId);
    if (shouldResetKeptHead(kept, this.deps.status(sessionId))) this.keptHeads.delete(sessionId);
    this.publish(sessionId);
  }

  stateChanged(sessionId: string): void {
    this.publish(sessionId);
  }

  keptFolderHead(sessionId: string): string | null {
    return this.keptHeads.get(sessionId) ?? null;
  }

  keepFolderHead(sessionId: string): string | null {
    const status = this.deps.status(sessionId);
    if (!status?.available) return null;
    const head = folderHeadValue(status);
    this.keptHeads.set(sessionId, head);
    this.publish(sessionId);
    return head;
  }

  mismatch(sessionId: string): BranchMismatch | null {
    return activeBranchMismatch(this.deps.session(sessionId), this.deps.status(sessionId), this.keptHeads.get(sessionId));
  }

  private data(sessionId: string): GitTopicData {
    return {
      status: this.deps.status(sessionId),
      error: this.deps.failure(sessionId),
      mismatch: this.mismatch(sessionId),
      keptFolderHead: this.keptFolderHead(sessionId)
    };
  }

  private publish(sessionId: string): void {
    const store = this.stores.get(sessionId);
    if (store) store.sync(this.data(sessionId));
  }

  private syncWatched(): void {
    this.deps.setWatched(this.hub.activeTopics(GIT_TOPIC_PREFIX).flatMap((topic) => topicId(topic, GIT_TOPIC_PREFIX) ?? []));
  }
}
