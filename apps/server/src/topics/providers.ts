import type { Services } from "../app/services.js";
import type { TopicHub } from "./TopicHub.js";
import { createWatchControls, type TopicProviderDeps } from "./watchProviders.js";

export interface TopicProviderControls {
  syncWatchedRuns(): void;
  applyFiles(sessionId: string): void;
}

export function registerTopicProviders(hub: TopicHub, services: Services, deps: TopicProviderDeps): TopicProviderControls {
  const watch = createWatchControls(hub, services, deps);
  for (const provider of watch.providers) hub.register(provider);
  return { syncWatchedRuns: watch.syncWatchedRuns, applyFiles: watch.applyFiles };
}
