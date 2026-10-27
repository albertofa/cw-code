import type { TopicCache, TopicState } from "@cw-code/client";
import { initTopics } from "../src/server/topics.js";

export interface FakeTopics {
  set(topic: string, data: Record<string, unknown>): void;
  merge(topic: string, data: Record<string, unknown>): void;
  data(topic: string): Record<string, unknown> | undefined;
  acquired(): string[];
}

export function installFakeTopics(initial: Record<string, Record<string, unknown>> = {}): FakeTopics {
  const states = new Map<string, TopicState>();
  const listeners = new Map<string, Set<() => void>>();
  const holds = new Map<string, number>();
  const emit = (topic: string): void => {
    for (const cb of [...(listeners.get(topic) ?? [])]) cb();
  };
  const set = (topic: string, data: Record<string, unknown>): void => {
    states.set(topic, { status: "ready", rev: (states.get(topic)?.rev ?? 0) + 1, error: null, data });
    emit(topic);
  };
  for (const [topic, data] of Object.entries(initial)) set(topic, data);
  const cache = {
    epoch: 0,
    acquire: (topic: string) => {
      holds.set(topic, (holds.get(topic) ?? 0) + 1);
      return () => {
        const count = (holds.get(topic) ?? 1) - 1;
        if (count <= 0) holds.delete(topic);
        else holds.set(topic, count);
      };
    },
    listen: (topic: string, cb: () => void) => {
      const forTopic = listeners.get(topic) ?? new Set<() => void>();
      forTopic.add(cb);
      listeners.set(topic, forTopic);
      return () => forTopic.delete(cb);
    },
    onEpoch: () => () => undefined,
    state: (topic: string) => states.get(topic)
  };
  initTopics(cache as unknown as TopicCache);
  return {
    set,
    merge: (topic, data) => set(topic, { ...(states.get(topic)?.data ?? {}), ...data }),
    data: (topic) => states.get(topic)?.data,
    acquired: () => [...holds.keys()]
  };
}
