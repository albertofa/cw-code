import { useEffect, useRef, useSyncExternalStore } from "react";

export function useTopics(topics: readonly string[]): void {
  const disposers = useRef(new Map<string, () => void>());
  const key = [...new Set(topics)].sort().join("\n");

  useEffect(() => {
    if (!window.cw) return;
    const wanted = new Set(key === "" ? [] : key.split("\n"));
    const active = disposers.current;
    for (const [topic, dispose] of [...active]) {
      if (wanted.has(topic)) continue;
      dispose();
      active.delete(topic);
    }
    for (const topic of wanted) {
      if (active.has(topic)) continue;
      active.set(topic, window.cw.subscribeTopics([topic]));
    }
  }, [key]);

  useEffect(
    () => () => {
      for (const dispose of disposers.current.values()) dispose();
      disposers.current.clear();
    },
    []
  );
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => !document.hidden);
}
