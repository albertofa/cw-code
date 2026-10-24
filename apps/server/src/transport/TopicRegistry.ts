export interface TopicHooks {
  onFirst?(topic: string): void;
  onSubscribe?(clientId: string, topic: string): void;
  onUnsubscribe?(clientId: string, topic: string): void;
  onLast?(topic: string): void;
}

const EMPTY: ReadonlySet<string> = new Set();

export class TopicRegistry {
  private readonly exactHooks = new Map<string, TopicHooks[]>();
  private readonly prefixHooks: Array<{ prefix: string; hooks: TopicHooks }> = [];
  private readonly topicsByClient = new Map<string, Set<string>>();
  private readonly clientsByTopic = new Map<string, Set<string>>();

  on(match: string, hooks: TopicHooks): void {
    if (match.endsWith("/")) {
      this.prefixHooks.push({ prefix: match, hooks });
      return;
    }
    const existing = this.exactHooks.get(match);
    if (existing) existing.push(hooks);
    else this.exactHooks.set(match, [hooks]);
  }

  subscribe(clientId: string, topics: readonly string[]): string[] {
    const added: string[] = [];
    for (const topic of topics) {
      if (this.addSubscription(clientId, topic)) added.push(topic);
    }
    return added;
  }

  unsubscribe(clientId: string, topics: readonly string[]): void {
    for (const topic of topics) this.removeSubscription(clientId, topic);
  }

  dropClient(clientId: string): void {
    const owned = this.topicsByClient.get(clientId);
    if (!owned) return;
    for (const topic of [...owned]) this.removeSubscription(clientId, topic);
  }

  dropTopic(topic: string): void {
    const clients = this.clientsByTopic.get(topic);
    if (!clients) return;
    for (const clientId of [...clients]) this.removeSubscription(clientId, topic);
  }

  isSubscribed(clientId: string, topic: string): boolean {
    return this.topicsByClient.get(clientId)?.has(topic) ?? false;
  }

  subscribers(topic: string): ReadonlySet<string> {
    return this.clientsByTopic.get(topic) ?? EMPTY;
  }

  activeTopics(prefix: string): string[] {
    const topics: string[] = [];
    for (const topic of this.clientsByTopic.keys()) {
      if (topic.startsWith(prefix)) topics.push(topic);
    }
    return topics;
  }

  countFor(clientId: string): number {
    return this.topicsByClient.get(clientId)?.size ?? 0;
  }

  private addSubscription(clientId: string, topic: string): boolean {
    let owned = this.topicsByClient.get(clientId);
    if (owned?.has(topic)) return false;
    if (!owned) {
      owned = new Set();
      this.topicsByClient.set(clientId, owned);
    }
    owned.add(topic);
    let clients = this.clientsByTopic.get(topic);
    const isFirst = !clients;
    if (!clients) {
      clients = new Set();
      this.clientsByTopic.set(topic, clients);
    }
    clients.add(clientId);
    if (isFirst) this.run(topic, (hooks) => hooks.onFirst?.(topic));
    this.run(topic, (hooks) => hooks.onSubscribe?.(clientId, topic));
    return true;
  }

  private removeSubscription(clientId: string, topic: string): void {
    const owned = this.topicsByClient.get(clientId);
    if (!owned?.delete(topic)) return;
    if (owned.size === 0) this.topicsByClient.delete(clientId);
    const clients = this.clientsByTopic.get(topic);
    clients?.delete(clientId);
    const isLast = clients?.size === 0;
    if (isLast) this.clientsByTopic.delete(topic);
    this.run(topic, (hooks) => hooks.onUnsubscribe?.(clientId, topic));
    if (isLast) this.run(topic, (hooks) => hooks.onLast?.(topic));
  }

  private run(topic: string, invoke: (hooks: TopicHooks) => void): void {
    for (const hooks of this.hooksFor(topic)) {
      try {
        invoke(hooks);
      } catch (error) {
        console.warn(`topic hook for '${topic}' failed: ${(error as Error).message}`);
      }
    }
  }

  private hooksFor(topic: string): TopicHooks[] {
    const exact = this.exactHooks.get(topic);
    if (exact) return exact;
    return this.prefixHooks.filter((entry) => topic.startsWith(entry.prefix)).map((entry) => entry.hooks);
  }
}
