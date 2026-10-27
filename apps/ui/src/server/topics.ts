import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { TopicCache, TopicState } from "@cw-code/client";

export interface TopicOptions {
  whenHidden?: "keep" | "release";
}

interface StaleState {
  topic: string;
  state: TopicState;
}

let cache: TopicCache | null = null;

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => !document.hidden);
}

export function initTopics(next: TopicCache): void {
  cache = next;
}

function topicCache(): TopicCache {
  if (!cache) throw new Error("topics are not initialized: the server connection is not ready");
  return cache;
}

function isStaleReusable(live: TopicState | undefined, stale: StaleState | null, topic: string): stale is StaleState {
  if (!stale || stale.topic !== topic) return false;
  return live === undefined || (live.status === "subscribing" && live.rev === 0 && stale.state.status === "ready");
}

function useTopicSource(topic: string | null, opts?: TopicOptions): {
  subscribe: (onChange: () => void) => () => void;
  read: () => TopicState | undefined;
} {
  const topics = topicCache();
  const visible = useDocumentVisible();
  const held = topic !== null && (visible || opts?.whenHidden === "keep");
  const stale = useRef<StaleState | null>(null);

  useEffect(() => {
    if (topic === null || !held) return;
    return topics.acquire(topic);
  }, [topics, topic, held]);

  const subscribe = useCallback((onChange: () => void) => (topic === null ? () => undefined : topics.listen(topic, onChange)), [topics, topic]);
  const read = useCallback((): TopicState | undefined => {
    if (topic === null) return undefined;
    const live = topics.state(topic);
    if (isStaleReusable(live, stale.current, topic)) return stale.current?.state;
    if (live) stale.current = { topic, state: live };
    return live;
  }, [topics, topic]);

  return { subscribe, read };
}

export function useTopic<D = Record<string, unknown>>(topic: string | null, opts?: TopicOptions): TopicState<D> | undefined {
  const { subscribe, read } = useTopicSource(topic, opts);
  return useSyncExternalStore(subscribe, read) as TopicState<D> | undefined;
}

export function useTopicSelect<T, D = Record<string, unknown>>(
  topic: string | null,
  select: (state: TopicState<D> | undefined) => T,
  opts?: TopicOptions
): T {
  const { subscribe, read } = useTopicSource(topic, opts);
  const selectRef = useRef(select);
  selectRef.current = select;
  const getSelected = useCallback(() => selectRef.current(read() as TopicState<D> | undefined), [read]);
  return useSyncExternalStore(subscribe, getSelected);
}

export function useTopicEntry<T>(topic: string | null, key: string, opts?: TopicOptions): T | undefined {
  return useTopicSelect<T | undefined>(topic, (state) => (state?.data as Record<string, unknown> | undefined)?.[key] as T | undefined, opts);
}

export function readTopic<D = Record<string, unknown>>(topic: string): TopicState<D> | undefined {
  return topicCache().state<D>(topic);
}

export function acquireTopic(topic: string): () => void {
  return topicCache().acquire(topic);
}

export function peekTopic<D = Record<string, unknown>>(topic: string): TopicState<D> | undefined {
  return cache?.state<D>(topic);
}

export function waitForTopicSettled<D = Record<string, unknown>>(topic: string, signal?: AbortSignal): Promise<TopicState<D> | undefined> {
  const topics = topicCache();
  return new Promise((resolve) => {
    let stopListening = (): void => undefined;
    const finish = (state: TopicState<D> | undefined): void => {
      stopListening();
      signal?.removeEventListener("abort", abort);
      resolve(state);
    };
    const abort = (): void => finish(topics.state<D>(topic));
    const check = (): void => {
      const state = topics.state<D>(topic);
      if (state && state.status === "subscribing") return;
      finish(state);
    };
    stopListening = topics.listen(topic, check);
    signal?.addEventListener("abort", abort, { once: true });
    check();
  });
}

export function bindTopic<D = Record<string, unknown>>(topic: string, onState: (state: TopicState<D>) => void): () => void {
  const topics = topicCache();
  const release = topics.acquire(topic);
  const emit = (): void => {
    const state = topics.state<D>(topic);
    if (state) onState(state);
  };
  const stopListening = topics.listen(topic, emit);
  emit();
  return () => {
    stopListening();
    release();
  };
}

export function onConnectionEpoch(cb: () => void): () => void {
  return topicCache().onEpoch(() => cb());
}

export function useConnectionEpoch(): number {
  const topics = topicCache();
  const subscribe = useCallback((onChange: () => void) => topics.onEpoch(() => onChange()), [topics]);
  return useSyncExternalStore(subscribe, () => topics.epoch);
}
