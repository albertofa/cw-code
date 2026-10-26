import type { TopicsParams, TopicsSubscribeResult } from "@cw-code/contracts";
import { isValidTopic, MAX_TOPICS_PER_CALL, MAX_TOPICS_PER_CLIENT } from "@cw-code/shared/topics";
import type { ServerApp } from "../app/ServerApp.js";
import type { Router } from "../transport/Router.js";
import { handle, parseArgs } from "./shared.js";

const PTY_PREFIX = "pty/";

function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function parseTopics(params: unknown, method: string): string[] {
  const { topics } = parseArgs(params, method);
  if (!Array.isArray(topics)) throw rpcError("invalid-topic", `${method} requires { topics: string[] }`);
  if (topics.length > MAX_TOPICS_PER_CALL) throw rpcError("invalid-topic", `${method} accepts at most ${MAX_TOPICS_PER_CALL} topics per call`);
  for (const topic of topics) {
    if (!isValidTopic(topic)) throw rpcError("invalid-topic", `invalid topic: ${JSON.stringify(topic)}`);
    if (topic.startsWith(PTY_PREFIX)) throw rpcError("invalid-topic", "pty topics are managed by pty.open/pty.detach");
  }
  return topics as string[];
}

export function registerTopicHandlers(router: Router, app: Pick<ServerApp, "topics">): void {
  handle<TopicsParams>(router, "topics.subscribe", (params, ctx): TopicsSubscribeResult => {
    const topics = parseTopics(params, "topics.subscribe");
    const added = new Set(topics.filter((topic) => !app.topics.isSubscribed(ctx.clientId, topic)));
    if (app.topics.countFor(ctx.clientId) + added.size > MAX_TOPICS_PER_CLIENT) {
      throw rpcError("too-many-topics", `a client may subscribe to at most ${MAX_TOPICS_PER_CLIENT} topics`);
    }
    return app.topics.subscribe(ctx, topics);
  });
  handle<TopicsParams>(router, "topics.unsubscribe", (params, ctx) => {
    app.topics.unsubscribe(ctx, parseTopics(params, "topics.unsubscribe"));
  });
}
