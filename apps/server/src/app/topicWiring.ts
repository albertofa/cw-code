import type { GitStatusUpdate } from "@cw-code/contracts";
import { filesTopic, GITHUB_RUNS_TOPIC, PRS_TOPIC, topicId } from "@cw-code/shared/topics";
import { MAX_WATCHED_RUNS } from "../github/RunWatcher.js";
import type { ServerApp } from "./ServerApp.js";

const GIT_PREFIX = "git/";
const FILES_PREFIX = "files/";

export interface TopicWiring {
  resync(): void;
  syncWatchedRuns(): void;
  applyFiles(sessionId: string): void;
}

export function wireTopics(app: ServerApp): TopicWiring {
  const filesGeneration = new Map<string, number>();

  const pushTrackedPrs = (clientId: string): void => {
    const services = app.currentServices();
    if (services) app.sendTo(clientId, "prs.tracked", services.prTracker.summaries());
  };

  const syncWatchedGit = (): void => {
    const sessionIds = app.topics.activeTopics(GIT_PREFIX).flatMap((topic) => topicId(topic, GIT_PREFIX) ?? []);
    app.currentServices()?.sourceControl.setWatched(sessionIds);
  };

  const syncWatchedRuns = (): void => {
    const runWatcher = app.currentServices()?.runWatcher;
    if (!runWatcher) return;
    const clientIds = [...app.topics.subscribers(GITHUB_RUNS_TOPIC)];
    runWatcher.watch(app.clientInputs.runRefsUnion(clientIds, MAX_WATCHED_RUNS));
  };

  const stopWatchingRuns = (): void => {
    const runWatcher = app.currentServices()?.runWatcher;
    if (!runWatcher) return;
    runWatcher.setActive(false);
    runWatcher.watch([]);
  };

  const applyFiles = (sessionId: string): void => {
    const services = app.currentServices();
    if (!services) return;
    const generation = (filesGeneration.get(sessionId) ?? 0) + 1;
    filesGeneration.set(sessionId, generation);
    const topic = filesTopic(sessionId);
    if (app.topics.subscribers(topic).size === 0) {
      filesGeneration.delete(sessionId);
      services.fileWatcher.unwatch(sessionId);
      return;
    }
    services.sessions
      .ensureWorktree(sessionId)
      .then((root) => {
        if (filesGeneration.get(sessionId) !== generation) return;
        const paths = app.clientInputs.pathsUnion(sessionId, [...app.topics.subscribers(topic)]);
        services.fileWatcher.setWatched(sessionId, root, paths);
      })
      .catch((err: unknown) => {
        console.warn(`[files] cannot watch ${sessionId}: ${(err as Error).message}`);
      });
  };

  const applyFilesTopic = (topic: string): void => {
    const sessionId = topicId(topic, FILES_PREFIX);
    if (sessionId) applyFiles(sessionId);
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
  app.topics.on(FILES_PREFIX, {
    onSubscribe: (_clientId, topic) => applyFilesTopic(topic),
    onUnsubscribe: (clientId, topic) => {
      const sessionId = topicId(topic, FILES_PREFIX);
      if (!sessionId) return;
      app.clientInputs.clearPaths(clientId, sessionId);
      applyFiles(sessionId);
    }
  });
  app.topics.on(GITHUB_RUNS_TOPIC, {
    onFirst: () => app.currentServices()?.runWatcher.setActive(true),
    onSubscribe: syncWatchedRuns,
    onUnsubscribe: (clientId) => {
      app.clientInputs.clearRunRefs(clientId);
      syncWatchedRuns();
    },
    onLast: stopWatchingRuns
  });

  return {
    syncWatchedRuns,
    applyFiles,
    resync(): void {
      for (const clientId of app.topics.subscribers(PRS_TOPIC)) pushTrackedPrs(clientId);
      syncWatchedGit();
      for (const topic of app.topics.activeTopics(FILES_PREFIX)) applyFilesTopic(topic);
      if (app.topics.subscribers(GITHUB_RUNS_TOPIC).size > 0) {
        app.currentServices()?.runWatcher.setActive(true);
        syncWatchedRuns();
      } else {
        stopWatchingRuns();
      }
    }
  };
}
