import type { Services } from "../app/services.js";
import type { TopicHub } from "./TopicHub.js";
import { createWatchProviders } from "./watchProviders.js";

export function registerTopicProviders(hub: TopicHub, services: Services): void {
  hub.register(services.appTopic);
  hub.register(services.usageTopic);
  hub.register(services.sidebar);
  for (const provider of createWatchProviders(hub, services)) hub.register(provider);
  hub.register(services.prStore.attach(hub));
  hub.register(services.githubViews.metaProvider);
  hub.register(services.githubViews.viewProvider);
}
