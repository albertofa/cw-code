import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./SessionStore.js";

function makeStore(): SessionStore {
  return new SessionStore(join(mkdtempSync(join(tmpdir(), "cw-store-")), "test.db"));
}

describe("SessionStore", () => {
  it("counts worktree references across all sessions, excluding one session", () => {
    const store = makeStore();
    const project = store.addProject("C:/proj");
    const a = store.createSession(project.id, "claude", "a", { worktreePath: "C:/wt/proj/sess1" });
    store.createSession(project.id, "claude", "b", { worktreePath: "C:/wt/proj/sess1/" });
    const c = store.createSession(project.id, "claude", "c", { worktreePath: "C:/wt/proj/sess2" });
    expect(store.countWorktreeRefs("C:/wt/proj/sess1")).toBe(2);
    expect(store.countWorktreeRefs("C:/wt/proj/sess1", a.id)).toBe(1);
    expect(store.countWorktreeRefs("C:/wt/proj/sess2", c.id)).toBe(0);
    expect(store.countWorktreeRefs("C:/wt/proj/missing")).toBe(0);
  });

  it("lists all sessions across projects", () => {
    const store = makeStore();
    const p1 = store.addProject("C:/proj1");
    const p2 = store.addProject("C:/proj2");
    store.createSession(p1.id, "claude", "a");
    store.createSession(p2.id, "codex", "b");
    expect(store.listAllSessions()).toHaveLength(2);
  });
});
