import { topicId } from "@cw-code/shared/topics";
import type { TopicProvider } from "../topics/TopicHub.js";
import type { ThreadService } from "./ThreadService.js";

export const THREAD_TOPIC_PREFIX = "session/";

export type ThreadTopicHooks = Partial<Pick<TopicProvider, "onSubscribe" | "onUnsubscribe" | "resync">>;

export function threadItemKey(itemId: string): `item/${string}` {
  return `item/${itemId}`;
}

function sessionIdOf(topic: string): string {
  const sessionId = topicId(topic, THREAD_TOPIC_PREFIX);
  if (!sessionId) throw new Error(`invalid thread topic '${topic}'`);
  return sessionId;
}

export function createThreadTopicProvider(threads: ThreadService, hooks: ThreadTopicHooks = {}): TopicProvider {
  return {
    owns: (topic) => topic.startsWith(THREAD_TOPIC_PREFIX),
    acquire: (topic) => threads.acquire(sessionIdOf(topic)),
    release: (topic) => {
      const sessionId = topicId(topic, THREAD_TOPIC_PREFIX);
      if (sessionId) threads.release(sessionId);
    },
    ...hooks
  };
}
