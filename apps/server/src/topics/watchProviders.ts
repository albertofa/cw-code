import type { GitStatusUpdate, ThreadEvent } from "@cw-code/contracts";
import { APP_TOPIC, filesTopic, GITHUB_RUNS_TOPIC, SIDEBAR_TOPIC, topicId, USAGE_TOPIC } from "@cw-code/shared/topics";
import type { ClientInputs } from "../app/clientInputs.js";
import type { Services } from "../app/services.js";
import { MAX_WATCHED_RUNS } from "../github/RunWatcher.js";
import type { TopicHub, TopicProvider } from "./TopicHub.js";

const GIT_PREFIX = "git/";
const FILES_PREFIX = "files/";
const PTY_PREFIX = "pty/";
const SESSION_PREFIX = "session/";

export interface TopicProviderDeps {
  clientInputs: ClientInputs;
  sendTo(clientId: string, channel: string, payload?: unknown): void;
}

export interface WatchControls {
  providers: TopicProvider[];
  syncWatchedRuns(): void;
  applyFiles(sessionId: string): void;
}

type ProviderHooks = Partial<Pick<TopicProvider, "onSubscribe" | "onUnsubscribe" | "resync">> & {
  onAcquire?(topic: string): void;
  onRelease?(topic: string): void;
};

function ownsExact(topic: string): TopicProvider["owns"] {
  return (candidate) => candidate === topic;
}

function ownsPrefix(prefix: string): TopicProvider["owns"] {
  return (candidate) => candidate.startsWith(prefix);
}

function emptyStoreProvider(hub: TopicHub, owns: TopicProvider["owns"], hooks: ProviderHooks = {}): TopicProvider {
  const { onAcquire, onRelease, ...providerHooks } = hooks;
  return {
    owns,
    acquire(topic) {
      onAcquire?.(topic);
      return hub.createStore<Record<string, unknown>>(topic, {});
    },
    release(topic) {
      onRelease?.(topic);
    },
    ...providerHooks
  };
}

export function createWatchControls(hub: TopicHub, services: Services, { clientInputs, sendTo }: TopicProviderDeps): WatchControls {
  let filesGeneration = 0;
  const latestFilesGeneration = new Map<string, number>();

  const syncWatchedGit = (): void => {
    const sessionIds = hub.activeTopics(GIT_PREFIX).flatMap((topic) => topicId(topic, GIT_PREFIX) ?? []);
    services.sourceControl.setWatched(sessionIds);
  };

  const syncWatchedRuns = (): void => {
    const clientIds = [...hub.subscriberIds(GITHUB_RUNS_TOPIC)];
    services.runWatcher.watch(clientInputs.runRefsUnion(clientIds, MAX_WATCHED_RUNS));
  };

  const stopWatchingRuns = (): void => {
    services.runWatcher.setActive(false);
    services.runWatcher.watch([]);
  };

  const applyFiles = (sessionId: string): void => {
    const generation = ++filesGeneration;
    const topic = filesTopic(sessionId);
    if (hub.subscribers(topic) === 0) {
      latestFilesGeneration.delete(sessionId);
      void services.fileWatcher.unwatch(sessionId);
      return;
    }
    latestFilesGeneration.set(sessionId, generation);
    services.sessions
      .ensureWorktree(sessionId)
      .then((root) => {
        if (latestFilesGeneration.get(sessionId) !== generation) return;
        const paths = clientInputs.pathsUnion(sessionId, [...hub.subscriberIds(topic)]);
        services.fileWatcher.setWatched(sessionId, root, paths);
      })
      .catch((err: unknown) => {
        console.warn(`[files] cannot watch ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      });
  };

  const applyFilesTopic = (topic: string): void => {
    const sessionId = topicId(topic, FILES_PREFIX);
    if (sessionId) applyFiles(sessionId);
  };

  const pushGitStatus = (clientId: string, topic: string): void => {
    const sessionId = topicId(topic, GIT_PREFIX);
    if (!sessionId) return;
    const status = services.sourceControl.status(sessionId);
    if (!status) return;
    const update: GitStatusUpdate = { sessionId, status };
    sendTo(clientId, "git.statusChanged", update);
  };

  const pushPendingRequests = (clientId: string, topic: string): void => {
    const sessionId = topicId(topic, SESSION_PREFIX);
    if (!sessionId) return;
    for (const entry of services.sessions.listPendingRequests(sessionId)) {
      const event: ThreadEvent =
        entry.kind === "approval"
          ? { type: "approval.request", turnId: entry.turnId, request: entry.request }
          : { type: "question.request", turnId: entry.turnId, request: entry.request };
      sendTo(clientId, "turn.event", { sessionId, event });
    }
  };

  const providers: TopicProvider[] = [
    emptyStoreProvider(hub, ownsExact(APP_TOPIC)),
    emptyStoreProvider(hub, ownsExact(SIDEBAR_TOPIC)),
    emptyStoreProvider(hub, ownsExact(USAGE_TOPIC)),
    emptyStoreProvider(hub, ownsPrefix(GIT_PREFIX), {
      onAcquire: syncWatchedGit,
      onRelease: syncWatchedGit,
      onSubscribe: (clientId, topic) => pushGitStatus(clientId, topic),
      resync: syncWatchedGit
    }),
    emptyStoreProvider(hub, ownsPrefix(FILES_PREFIX), {
      onSubscribe: (_clientId, topic) => applyFilesTopic(topic),
      onUnsubscribe: (clientId, topic) => {
        const sessionId = topicId(topic, FILES_PREFIX);
        if (!sessionId) return;
        clientInputs.clearPaths(clientId, sessionId);
        applyFiles(sessionId);
      },
      resync: applyFilesTopic
    }),
    emptyStoreProvider(hub, ownsPrefix(PTY_PREFIX), {
      onUnsubscribe: (clientId, topic) => {
        const ptyId = topicId(topic, PTY_PREFIX);
        if (ptyId) services.ptys.detach(ptyId, clientId);
      }
    }),
    emptyStoreProvider(hub, ownsExact(GITHUB_RUNS_TOPIC), {
      onAcquire: () => services.runWatcher.setActive(true),
      onSubscribe: syncWatchedRuns,
      onUnsubscribe: (clientId) => {
        clientInputs.clearRunRefs(clientId);
        syncWatchedRuns();
      },
      onRelease: stopWatchingRuns,
      resync: () => {
        services.runWatcher.setActive(true);
        syncWatchedRuns();
      }
    }),
    emptyStoreProvider(hub, ownsPrefix(SESSION_PREFIX), {
      onSubscribe: (clientId, topic) => {
        pushPendingRequests(clientId, topic);
        services.prStore.reevaluate();
      },
      onUnsubscribe: () => services.prStore.reevaluate(),
      resync: () => services.prStore.reevaluate()
    })
  ];

  return { providers, syncWatchedRuns, applyFiles };
}
