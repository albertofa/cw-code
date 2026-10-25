import { afterEach, describe, expect, test } from "bun:test";
import type { AppSettings, GitStatus, GitStatusUpdate, SessionMeta } from "@cw-code/contracts";
import type { GitService } from "../fs/GitService.js";
import type { PrTracker } from "../github/PrTracker.js";
import type { SessionManager } from "../sessions/SessionManager.js";
import type { GitWatcher } from "./GitWatcher.js";
import { SourceControlService } from "./SourceControlService.js";

function session(id: string): SessionMeta {
  return { id, projectId: "p", driver: "claude", title: id, status: "working", resumeCursor: "", createdAt: 0, updatedAt: 0, worktreePath: `/w/${id}` };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

let service: SourceControlService | null = null;

afterEach(async () => {
  await service?.dispose();
  service = null;
});

function setup() {
  const statusCalls: string[] = [];
  const emitted: GitStatusUpdate[] = [];
  const published: GitStatusUpdate[] = [];
  const sessions = [session("a"), session("b")];
  const created = new SourceControlService({
    git: {
      status: async (root: string) => {
        statusCalls.push(root);
        return { branch: root.split("/").at(-1), pullRequest: null } as GitStatus;
      },
      gitLocations: async () => null,
      invalidatePullRequest: () => {}
    } as unknown as GitService,
    sessions: {
      listAllSessions: () => sessions,
      sessionStatusContext: async (id: string) => ({ root: `/w/${id}` }),
      rootForProject: () => "/repo",
      getProject: () => ({ id: "p", rootPath: "/repo", name: "repo" }),
      syncFromStatus: () => null,
      trackedPrRefs: () => []
    } as unknown as SessionManager,
    tracker: { setTracked: () => {}, refresh: async () => {} } as unknown as PrTracker,
    watcher: { setRoots: () => {}, dispose: async () => {} } as unknown as GitWatcher,
    settings: () => ({ sourceControlRefreshIntervalSeconds: 3600 }) as AppSettings,
    emit: (update) => emitted.push(update),
    warn: () => {}
  });
  created.onPublished((update) => published.push(update));
  service = created;
  return { service: created, statusCalls, emitted, published };
}

describe("SourceControlService", () => {
  test("watches the union of topic subscribers and the working set and notifies publishes", async () => {
    const { service, emitted, published } = setup();
    service.start();
    service.setWatched(["a"]);
    service.setWorkingSet(["b"]);
    await until(() => published.length === 2);
    expect(published.map((update) => [update.sessionId, update.status.branch]).sort()).toEqual([
      ["a", "a"],
      ["b", "b"]
    ]);
    expect(emitted).toEqual(published);
  });

  test("a session leaving the topic stays watched while it is in the working set", async () => {
    const { service, statusCalls } = setup();
    service.start();
    service.setWorkingSet(["a"]);
    service.setWatched(["a"]);
    await until(() => statusCalls.length === 1);
    service.setWatched([]);
    service.setWatched(["a"]);
    service.setWorkingSet(["a", "b"]);
    await until(() => statusCalls.length === 2);
    expect(statusCalls).toEqual(["/w/a", "/w/b"]);
  });
});
