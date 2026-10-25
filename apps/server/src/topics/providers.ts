import { PRS_TOPIC } from "@cw-code/shared/topics";
import type { Services } from "../app/services.js";
import type { TopicHub, TopicProvider } from "./TopicHub.js";
import { createWatchControls, type TopicProviderDeps } from "./watchProviders.js";

export interface TopicProviderControls {
  syncWatchedRuns(): void;
  applyFiles(sessionId: string): void;
}

function createPrsProvider(hub: TopicHub, services: Services, { sendTo }: TopicProviderDeps): TopicProvider {
  const pushTrackedPrs = (clientId: string): void => {
    sendTo(clientId, "prs.tracked", services.prTracker.summaries());
  };
  return {
    ...services.prStore.attach(hub),
    onSubscribe: pushTrackedPrs,
    resync: () => {
      for (const clientId of hub.subscriberIds(PRS_TOPIC)) pushTrackedPrs(clientId);
    }
  };
}

export function registerTopicProviders(hub: TopicHub, services: Services, deps: TopicProviderDeps): TopicProviderControls {
  const watch = createWatchControls(hub, services, deps);
  hub.register(services.appTopic);
  hub.register(services.usageTopic);
  hub.register(services.sidebar);
  for (const provider of watch.providers) hub.register(provider);
  hub.register(createPrsProvider(hub, services, deps));
  hub.register(services.githubViews.metaProvider);
  hub.register(services.githubViews.viewProvider);
  return { syncWatchedRuns: watch.syncWatchedRuns, applyFiles: watch.applyFiles };
}
