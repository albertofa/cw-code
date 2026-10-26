import type { TopicPatch, TopicsSubscribeResult } from "@cw-code/contracts";
import type { CallContext } from "../transport/Router.js";
import { TopicStore } from "./TopicStore.js";

type AnyStore = TopicStore<Record<string, unknown>>;

export interface TopicProvider {
  owns(topic: string): boolean;
  exactTopics?: readonly string[];
  acquire(topic: string, hub: TopicHub): AnyStore;
  release(topic: string): void;
  onSubscribe?(clientId: string, topic: string): void;
  onUnsubscribe?(clientId: string, topic: string): void;
  resync?(topic: string): void;
}

const NO_SUBSCRIBERS: ReadonlySet<string> = new Set();

function unknownTopic(topic: string, cause?: unknown): Error {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return Object.assign(new Error(`unknown topic '${topic}'${detail}`), { code: "unknown-topic" });
}

export class TopicHub {
  private providers: TopicProvider[] = [];
  private readonly current = new Map<string, AnyStore>();
  private readonly warnedStale = new WeakSet<object>();
  private readonly acquiring = new Set<string>();
  private readonly lastRev = new Map<string, number>();
  private readonly topicsByClient = new Map<string, Set<string>>();
  private readonly clientsByTopic = new Map<string, Set<string>>();

  constructor(private readonly send: (clientIds: readonly string[], frame: string) => void) {}

  register(provider: TopicProvider): void {
    this.providers.push(provider);
  }

  clearProviders(): void {
    this.providers = [];
    this.current.clear();
  }

  reacquireAll(): void {
    for (const topic of [...this.clientsByTopic.keys()]) {
      const provider = this.providerFor(topic);
      try {
        if (!provider) throw unknownTopic(topic);
        this.acquireStore(provider, topic, false);
      } catch (error) {
        console.warn(`topic '${topic}' cannot be restored and its subscribers were dropped: ${(error as Error).message}`);
        this.dropTopic(topic, false);
        continue;
      }
      this.runHook(topic, () => provider?.resync?.(topic));
    }
  }

  resync(): void {
    for (const topic of [...this.clientsByTopic.keys()]) {
      const provider = this.providerFor(topic);
      this.runHook(topic, () => provider?.resync?.(topic));
    }
  }

  createStore<D extends Record<string, unknown>>(topic: string, initial: D): TopicStore<D> {
    const startRev = (this.lastRev.get(topic) ?? 0) + 1;
    const hasLiveSubscribers = this.subscriberIds(topic).size > 0 && !this.acquiring.has(topic);
    const store: TopicStore<D> = new TopicStore<D>(topic, hasLiveSubscribers ? ({} as D) : initial, startRev, (patch) => this.publish(store, patch));
    this.current.set(topic, store as unknown as AnyStore);
    if (hasLiveSubscribers) store.replace(initial);
    return store;
  }

  subscribe(ctx: CallContext, topics: string[]): TopicsSubscribeResult {
    const added = this.subscribeClient(ctx.clientId, topics);
    try {
      const result: TopicsSubscribeResult = {};
      for (const topic of topics) {
        const store = this.current.get(topic);
        if (!store) throw unknownTopic(topic);
        result[topic] = store.snapshot();
      }
      return result;
    } catch (error) {
      for (const topic of added.reverse()) this.removeSubscription(ctx.clientId, topic);
      throw error;
    }
  }

  subscribeClient(clientId: string, topics: readonly string[]): string[] {
    for (const topic of topics) {
      if (!this.providerFor(topic)) throw unknownTopic(topic);
    }
    const added: string[] = [];
    try {
      for (const topic of topics) {
        if (this.addSubscription(clientId, topic)) added.push(topic);
      }
    } catch (error) {
      for (const topic of added.reverse()) this.removeSubscription(clientId, topic);
      throw error;
    }
    return added;
  }

  unsubscribe(ctx: CallContext, topics: readonly string[]): void {
    this.unsubscribeClient(ctx.clientId, topics);
  }

  unsubscribeClient(clientId: string, topics: readonly string[]): void {
    for (const topic of topics) this.removeSubscription(clientId, topic);
  }

  clientClosed(ctx: CallContext): void {
    const owned = this.topicsByClient.get(ctx.clientId);
    if (!owned) return;
    for (const topic of [...owned]) this.removeSubscription(ctx.clientId, topic);
  }

  dropTopic(topic: string, release = true): void {
    const clients = this.clientsByTopic.get(topic);
    if (!clients) return;
    for (const clientId of [...clients]) this.removeSubscription(clientId, topic, release);
  }

  isSubscribed(clientId: string, topic: string): boolean {
    return this.topicsByClient.get(clientId)?.has(topic) ?? false;
  }

  subscribers(topic: string): number {
    return this.clientsByTopic.get(topic)?.size ?? 0;
  }

  subscriberIds(topic: string): ReadonlySet<string> {
    return this.clientsByTopic.get(topic) ?? NO_SUBSCRIBERS;
  }

  activeTopics(prefix: string): string[] {
    return [...this.clientsByTopic.keys()].filter((topic) => topic.startsWith(prefix));
  }

  countFor(clientId: string): number {
    return this.topicsByClient.get(clientId)?.size ?? 0;
  }

  private providerFor(topic: string): TopicProvider | undefined {
    return this.providers.find((provider) => provider.exactTopics?.includes(topic)) ?? this.providers.find((provider) => provider.owns(topic));
  }

  private publish(store: object, patch: TopicPatch): void {
    const topic = patch.topic;
    const current = this.current.get(topic);
    const subscribers = this.clientsByTopic.get(topic);
    const isStale =
      (current !== undefined && current !== store) ||
      (current === undefined && subscribers !== undefined && subscribers.size > 0) ||
      patch.rev <= (this.lastRev.get(topic) ?? 0);
    if (isStale) {
      if (!this.warnedStale.has(store)) {
        this.warnedStale.add(store);
        console.warn(`dropping a patch for topic '${topic}' from a store that is no longer current`);
      }
      return;
    }
    this.lastRev.set(topic, patch.rev);
    if (!subscribers || subscribers.size === 0) return;
    this.send([...subscribers], JSON.stringify({ t: "patch", topic, rev: patch.rev, ops: patch.ops }));
  }

  private acquireStore(provider: TopicProvider, topic: string, firstSubscriber: boolean): void {
    if (firstSubscriber) this.acquiring.add(topic);
    try {
      this.current.set(topic, provider.acquire(topic, this));
    } finally {
      this.acquiring.delete(topic);
    }
  }

  private addSubscription(clientId: string, topic: string): boolean {
    if (this.isSubscribed(clientId, topic)) return false;
    const provider = this.providerFor(topic);
    if (!provider) throw unknownTopic(topic);
    const isFirst = !this.clientsByTopic.has(topic);
    this.link(clientId, topic);
    if (isFirst) {
      try {
        this.acquireStore(provider, topic, true);
      } catch (error) {
        this.unlink(clientId, topic);
        this.current.delete(topic);
        throw unknownTopic(topic, error);
      }
    }
    this.runHook(topic, () => provider.onSubscribe?.(clientId, topic));
    return true;
  }

  private removeSubscription(clientId: string, topic: string, release = true): void {
    if (!this.isSubscribed(clientId, topic)) return;
    const isLast = this.unlink(clientId, topic);
    const provider = this.providerFor(topic);
    this.runHook(topic, () => provider?.onUnsubscribe?.(clientId, topic));
    if (!isLast) return;
    this.current.delete(topic);
    if (release) this.runHook(topic, () => provider?.release(topic));
  }

  private link(clientId: string, topic: string): void {
    const owned = this.topicsByClient.get(clientId) ?? new Set<string>();
    owned.add(topic);
    this.topicsByClient.set(clientId, owned);
    const clients = this.clientsByTopic.get(topic) ?? new Set<string>();
    clients.add(clientId);
    this.clientsByTopic.set(topic, clients);
  }

  private unlink(clientId: string, topic: string): boolean {
    const owned = this.topicsByClient.get(clientId);
    owned?.delete(topic);
    if (owned?.size === 0) this.topicsByClient.delete(clientId);
    const clients = this.clientsByTopic.get(topic);
    clients?.delete(clientId);
    const isLast = clients?.size === 0;
    if (isLast) this.clientsByTopic.delete(topic);
    return isLast;
  }

  private runHook(topic: string, invoke: () => void): void {
    try {
      invoke();
    } catch (error) {
      console.warn(`topic hook for '${topic}' failed: ${(error as Error).message}`);
    }
  }
}
