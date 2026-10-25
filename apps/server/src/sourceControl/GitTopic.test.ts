import { describe, expect, test } from "bun:test";
import type { GitStatus, GitTopicData, SessionMeta } from "@cw-code/contracts";
import { gitTopic } from "@cw-code/shared/topics";
import { TopicHub } from "../topics/TopicHub.js";
import { GitTopic } from "./GitTopic.js";

const CTX = { clientId: "c1", client: "web" as const, auth: { kind: "owner" as const } };

function status(branch: string, headSha = "abc123"): GitStatus {
  return { available: true, branch, headSha, clean: true, dirtyCount: 0 } as GitStatus;
}

function setup() {
  const statuses = new Map<string, GitStatus>();
  const failures = new Map<string, string>();
  const sessions = new Map<string, SessionMeta>([["s1", { id: "s1", projectId: "p", branch: "cw/a" } as SessionMeta]]);
  const watched: string[][] = [];
  const hub = new TopicHub(() => {});
  const git = new GitTopic(hub, {
    status: (sessionId) => statuses.get(sessionId) ?? null,
    failure: (sessionId) => failures.get(sessionId) ?? null,
    session: (sessionId) => sessions.get(sessionId),
    setWatched: (sessionIds) => watched.push(sessionIds)
  });
  hub.register(git);
  const topic = gitTopic("s1");
  const data = (): GitTopicData => hub.subscribe(CTX, [topic])[topic].data as GitTopicData;
  const setStatus = (next: GitStatus): void => {
    statuses.set("s1", next);
    git.statusChanged("s1");
  };
  return { hub, git, topic, data, setStatus, failures, watched };
}

describe("GitTopic", () => {
  test("publishes the status, the failure and the branch mismatch, and watches subscribed sessions", () => {
    const ctx = setup();
    ctx.setStatus(status("main"));
    expect(ctx.data()).toEqual({
      status: status("main"),
      error: null,
      mismatch: { sessionBranch: "cw/a", folderBranch: "main", folderHead: "main" },
      keptFolderHead: null
    });
    expect(ctx.watched.at(-1)).toEqual(["s1"]);

    ctx.failures.set("s1", "git status failed");
    ctx.git.stateChanged("s1");
    expect(ctx.data().error).toBe("git status failed");

    ctx.hub.unsubscribe(CTX, [ctx.topic]);
    expect(ctx.watched.at(-1)).toEqual([]);
  });

  test("the mismatch is null while a kept head is valid", () => {
    const ctx = setup();
    ctx.setStatus(status("main"));
    expect(ctx.git.keepFolderHead("s1")).toBe("main");
    expect(ctx.git.mismatch("s1")).toBeNull();
    expect(ctx.data()).toMatchObject({ mismatch: null, keptFolderHead: "main" });
    expect(ctx.git.keptFolderHead("s1")).toBe("main");
  });

  test("a kept head clears when the folder head changes", () => {
    const ctx = setup();
    ctx.setStatus(status("main"));
    ctx.git.keepFolderHead("s1");
    ctx.setStatus(status("main", "def456"));
    expect(ctx.git.keptFolderHead("s1")).toBe("main");

    ctx.setStatus(status("feature"));
    expect(ctx.git.keptFolderHead("s1")).toBeNull();
    expect(ctx.data()).toMatchObject({
      keptFolderHead: null,
      mismatch: { sessionBranch: "cw/a", folderBranch: "feature", folderHead: "feature" }
    });
  });

  test("a detached kept head clears when the commit changes", () => {
    const ctx = setup();
    ctx.setStatus(status("HEAD", "abc123"));
    expect(ctx.git.keepFolderHead("s1")).toBe("abc123");
    ctx.setStatus(status("HEAD", "def456"));
    expect(ctx.git.keptFolderHead("s1")).toBeNull();
  });

  test("nothing is kept while the status is unavailable", () => {
    const ctx = setup();
    expect(ctx.git.keepFolderHead("s1")).toBeNull();
    ctx.setStatus({ available: false, branch: "", headSha: "" } as GitStatus);
    expect(ctx.git.keepFolderHead("s1")).toBeNull();
    expect(ctx.git.keptFolderHead("s1")).toBeNull();
  });
});
