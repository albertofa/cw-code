import { topicId } from "@cw-code/shared/topics";
import type { Services } from "../app/services.js";
import { createThreadTopicProvider, THREAD_TOPIC_PREFIX } from "../threads/threadTopic.js";
import type { TopicHub, TopicProvider } from "./TopicHub.js";

const PTY_PREFIX = "pty/";

function ptyProvider(hub: TopicHub, services: Services): TopicProvider {
  return {
    owns: (topic) => topic.startsWith(PTY_PREFIX),
    acquire: (topic) => hub.createStore<Record<string, unknown>>(topic, {}),
    release: () => undefined,
    onUnsubscribe: (clientId, topic) => {
      const ptyId = topicId(topic, PTY_PREFIX);
      if (ptyId) services.ptys.detach(ptyId, clientId);
    }
  };
}

export function createWatchProviders(hub: TopicHub, services: Services): TopicProvider[] {
  const openTurnChanges = (topic: string): void => {
    const sessionId = topicId(topic, THREAD_TOPIC_PREFIX);
    if (sessionId) services.turnChanges.opened(sessionId);
  };

  return [
    services.gitTopic,
    services.filesTopic,
    ptyProvider(hub, services),
    createThreadTopicProvider(services.threads, {
      onSubscribe: (_clientId, topic) => {
        services.prStore.reevaluate();
        openTurnChanges(topic);
      },
      onUnsubscribe: (_clientId, topic) => {
        services.prStore.reevaluate();
        const sessionId = topicId(topic, THREAD_TOPIC_PREFIX);
        if (sessionId) services.turnChanges.closed(sessionId);
      },
      resync: (topic) => {
        services.prStore.reevaluate();
        openTurnChanges(topic);
      }
    })
  ];
}
