import type { GitStatusUpdate } from "@cw-code/contracts";
import { PRS_TOPIC, topicId } from "@cw-code/shared/topics";
import type { ServerApp } from "./ServerApp.js";

const GIT_PREFIX = "git/";

export interface TopicWiring {
  resync(): void;
}

export function wireTopics(app: ServerApp): TopicWiring {
  const pushTrackedPrs = (clientId: string): void => {
    const services = app.currentServices();
    if (services) app.sendTo(clientId, "prs.tracked", services.prTracker.summaries());
  };

  const syncWatchedGit = (): void => {
    const sessionIds = app.topics.activeTopics(GIT_PREFIX).flatMap((topic) => topicId(topic, GIT_PREFIX) ?? []);
    app.currentServices()?.sourceControl.setWatched(sessionIds);
  };

  const pushGitStatus = (clientId: string, topic: string): void => {
    const sessionId = topicId(topic, GIT_PREFIX);
    if (!sessionId) return;
    const status = app.currentServices()?.sourceControl.status(sessionId);
    if (!status) return;
    const update: GitStatusUpdate = { sessionId, status };
    app.sendTo(clientId, "git.statusChanged", update);
  };

  app.topics.on(PRS_TOPIC, { onSubscribe: pushTrackedPrs });
  app.topics.on(GIT_PREFIX, { onFirst: syncWatchedGit, onLast: syncWatchedGit, onSubscribe: pushGitStatus });

  return {
    resync(): void {
      for (const clientId of app.topics.subscribers(PRS_TOPIC)) pushTrackedPrs(clientId);
      syncWatchedGit();
    }
  };
}
