import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMeta } from "@cw-code/contracts";
import { SessionStore } from "./SessionStore.js";

function makeStore(): SessionStore {
  return new SessionStore(join(mkdtempSync(join(tmpdir(), "cw-store-")), "test.db"));
}

function seedStore(sessions: Array<Partial<SessionMeta>>): { dir: string; store: SessionStore } {
  const dir = mkdtempSync(join(tmpdir(), "cw-store-"));
  const persisted = sessions.map((session, index) => ({
    id: `sess_${index}`,
    projectId: "proj_1",
    driver: "claude",
    title: "seeded",
    status: "idle",
    resumeCursor: "",
    createdAt: 1,
    updatedAt: 2,
    ...session
  }));
  writeFileSync(join(dir, "test.db.json"), JSON.stringify({ projects: [], sessions: persisted }), "utf8");
  return { dir, store: new SessionStore(join(dir, "test.db")) };
}

describe("SessionStore", () => {
  it("lists all sessions across projects", () => {
    const store = makeStore();
    const p1 = store.addProject("C:/proj1");
    const p2 = store.addProject("C:/proj2");
    store.createSession(p1.id, "claude", "a");
    store.createSession(p2.id, "codex", "b");
    expect(store.listAllSessions()).toHaveLength(2);
  });

  it("loads persisted working and input-required sessions as holding without re-arming updatedAt", () => {
    const { store } = seedStore([
      { id: "sess_working", status: "working", updatedAt: 111 },
      { id: "sess_input", status: "input-required", updatedAt: 222 },
      { id: "sess_done", status: "done", updatedAt: 333 }
    ]);
    const byId = new Map(store.listAllSessions().map((session) => [session.id, session]));
    expect(byId.get("sess_working")).toMatchObject({ status: "holding", updatedAt: 111 });
    expect(byId.get("sess_input")).toMatchObject({ status: "holding", updatedAt: 222 });
    expect(byId.get("sess_done")).toMatchObject({ status: "done", updatedAt: 333 });
  });

  it("persists the holding migration across reloads", () => {
    const { dir } = seedStore([{ id: "sess_working", status: "working", updatedAt: 111 }]);
    const reloaded = new SessionStore(join(dir, "test.db"));
    expect(reloaded.getSession("sess_working")).toMatchObject({ status: "holding", updatedAt: 111 });
  });

  it("expires only holding sessions and preserves updatedAt", () => {
    const { dir, store } = seedStore([
      { id: "sess_holding", status: "holding", updatedAt: 1234 },
      { id: "sess_done", status: "done", updatedAt: 99 }
    ]);

    const expired = store.expireHolding("sess_holding");

    expect(expired).toMatchObject({ id: "sess_holding", status: "idle", updatedAt: 1234 });
    expect(store.getSession("sess_holding")).toMatchObject({ status: "idle", updatedAt: 1234 });
    expect(store.expireHolding("sess_holding")).toBeNull();
    expect(store.expireHolding("sess_done")).toBeNull();
    expect(store.expireHolding("missing")).toBeNull();
    expect(new SessionStore(join(dir, "test.db")).getSession("sess_holding")).toMatchObject({
      status: "idle",
      updatedAt: 1234
    });
  });

  it("round-trips a session's pull request link", () => {
    const store = makeStore();
    const project = store.addProject("C:/proj1");
    const session = store.createSession(project.id, "claude", "a");
    const link: SessionMeta["pr"] = {
      ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
      origin: "opened",
      lastSeenSha: "sha-1",
      lastSeenAt: 1000
    };

    store.updateSession(session.id, { pr: link });
    expect(store.getSession(session.id)?.pr).toEqual(link);

    store.updateSession(session.id, { pr: null });
    expect(store.getSession(session.id)?.pr).toBeUndefined();
  });

  it("drops auto-links held by sessions that cannot own them and keeps the rest", () => {
    const opened: SessionMeta["pr"] = {
      ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
      origin: "opened",
      lastSeenSha: "",
      lastSeenAt: 1
    };
    const { dir } = seedStore([
      { id: "sess_checkout", pr: opened },
      { id: "sess_archived", status: "archived", worktreePath: "C:/wt/a", pr: opened },
      { id: "sess_owner", worktreePath: "C:/wt/b", pr: opened },
      { id: "sess_manual", pr: { ...opened, origin: "linked" } }
    ]);
    const reloaded = new SessionStore(join(dir, "test.db"));
    expect(reloaded.getSession("sess_checkout")?.pr).toBeUndefined();
    expect(reloaded.getSession("sess_archived")?.pr).toBeUndefined();
    expect(reloaded.getSession("sess_owner")?.pr).toEqual(opened);
    expect(reloaded.getSession("sess_manual")?.pr?.origin).toBe("linked");
  });

  it("round-trips a session's unlinked pull request keys", () => {
    const store = makeStore();
    const project = store.addProject("C:/proj1");
    const session = store.createSession(project.id, "claude", "a");

    store.updateSession(session.id, { prUnlinked: ["github.com/acme/widgets#42"] });
    expect(store.getSession(session.id)?.prUnlinked).toEqual(["github.com/acme/widgets#42"]);

    store.updateSession(session.id, { prUnlinked: undefined });
    expect(store.getSession(session.id)?.prUnlinked).toBeUndefined();
  });
});
