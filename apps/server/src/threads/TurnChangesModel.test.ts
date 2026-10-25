import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Project, SessionMeta, ThreadTurnChanges, TurnChanges } from "@cw-code/contracts";
import { waitFor } from "../../tests/testing.js";
import { TurnChangesModel } from "./TurnChangesModel.js";

function until(condition: () => boolean): Promise<void> {
  return waitFor(() => {
    if (!condition()) throw new Error("condition not met yet");
  });
}

const warn = spyOn(console, "warn").mockImplementation(() => {});

afterEach(() => warn.mockClear());

function session(id: string, projectId: string, worktreePath?: string): SessionMeta {
  return {
    id,
    projectId,
    driver: "claude",
    title: id,
    status: "idle",
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 0,
    ...(worktreePath ? { worktreePath } : {})
  };
}

function changesFor(turnId: string): TurnChanges {
  return { turnId, files: [], endSha: "end", undoable: false, reason: "The turn changed no files", conflicts: [] };
}

const PROJECTS: Project[] = [
  { id: "p1", rootPath: "C:\\Repo\\app", name: "app" },
  { id: "p2", rootPath: "C:\\Other", name: "other" }
];
const SESSIONS = [session("a", "p1"), session("b", "p1"), session("c", "p2"), session("wt", "p1", "C:\\wt\\one")];

function setup(open: string[]) {
  const openIds = new Set(open);
  const computed: string[] = [];
  const published: string[] = [];
  let failWith: string | null = null;
  let version = 0;
  const model: TurnChangesModel = new TurnChangesModel({
    sessions: () => SESSIONS,
    projects: () => PROJECTS,
    isOpen: (sessionId) => openIds.has(sessionId),
    turnChanges: async (sessionId) => {
      computed.push(sessionId);
      if (failWith) throw new Error(failWith);
      return changesFor(`${sessionId}-${version}`);
    },
    refresh: (sessionId) => published.push(sessionId)
  });
  return {
    model,
    openIds,
    computed,
    published,
    bump: () => (version += 1),
    failWith: (message: string | null) => (failWith = message),
    value: (sessionId: string): ThreadTurnChanges | null => model.extras(sessionId).turnChanges ?? null
  };
}

describe("TurnChangesModel", () => {
  test("computes when a thread opens and publishes the changes with the same-root session ids", async () => {
    const t = setup(["a"]);
    expect(t.value("a")).toBeNull();
    t.model.opened("a");
    await until(() => t.published.includes("a"));
    expect(t.value("a")).toEqual({ changes: changesFor("a-0"), error: null, rootSessionIds: ["a", "b"] });
  });

  test("a sibling session's snapshot change recomputes every open session on the same root", async () => {
    const t = setup(["a", "b", "c"]);
    t.model.opened("a");
    t.model.opened("c");
    await until(() => t.published.length === 2);
    t.computed.length = 0;
    t.bump();
    t.model.snapshotChanged("b");
    await until(() => t.computed.includes("a"));
    expect([...t.computed].sort()).toEqual(["a", "b"]);
    expect(t.value("a")?.changes?.turnId).toBe("a-1");
    expect(t.value("c")?.changes?.turnId).toBe("c-0");
  });

  test("closed threads are not computed", async () => {
    const t = setup(["a"]);
    t.model.snapshotChanged("b");
    t.model.snapshotChanged("c");
    t.model.opened("b");
    await Promise.resolve();
    await Promise.resolve();
    expect(t.computed).toEqual(["a"]);
  });

  test("closing a thread drops its value and ignores a result that lands afterwards", async () => {
    const t = setup(["a"]);
    t.model.opened("a");
    await until(() => t.published.includes("a"));
    t.openIds.delete("a");
    t.model.closed("a");
    expect(t.value("a")).toBeNull();

    t.openIds.add("a");
    t.model.opened("a");
    await Promise.resolve();
    t.openIds.delete("a");
    await until(() => t.computed.length === 2);
    await Promise.resolve();
    expect(t.value("a")).toBeNull();
  });

  test("coalesces triggers that arrive while a recompute is in flight", async () => {
    const t = setup(["a"]);
    t.model.opened("a");
    await until(() => t.published.length === 1);
    t.computed.length = 0;
    t.bump();
    t.model.snapshotChanged("a");
    t.model.snapshotChanged("a");
    t.model.snapshotChanged("b");
    await until(() => t.published.length === 2);
    await Promise.resolve();
    expect(t.computed).toEqual(["a"]);
  });

  test("does not republish an unchanged result", async () => {
    const t = setup(["a"]);
    t.model.opened("a");
    await until(() => t.published.length === 1);
    t.model.snapshotChanged("a");
    await until(() => t.computed.length === 2);
    await Promise.resolve();
    expect(t.published).toEqual(["a"]);
  });

  test("lands a failed computation in error", async () => {
    const t = setup(["a"]);
    t.failWith("session worktree is missing");
    t.model.opened("a");
    await until(() => t.published.includes("a"));
    expect(t.value("a")).toEqual({ changes: null, error: "session worktree is missing", rootSessionIds: ["a", "b"] });
  });
});
