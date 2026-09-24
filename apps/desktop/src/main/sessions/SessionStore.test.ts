import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMeta, SessionPrLink } from "@cw-code/contracts";
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

  it("round-trips a session's pull request links", () => {
    const store = makeStore();
    const project = store.addProject("C:/proj1");
    const session = store.createSession(project.id, "claude", "a");
    const links: SessionPrLink[] = [
      { ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 }, origin: "opened", lastSeenSha: "sha-1", lastSeenAt: 1000 },
      { ref: { host: "github.com", owner: "acme", repo: "widgets", number: 43 }, origin: "linked", lastSeenSha: "sha-2", lastSeenAt: 2000 }
    ];

    store.updateSession(session.id, { prs: links });
    expect(store.getSession(session.id)?.prs).toEqual(links);

    store.updateSession(session.id, { prs: [] });
    expect(store.getSession(session.id)).not.toHaveProperty("prs");
  });

  it("migrates a legacy single pull request link into the link list and persists it", () => {
    const legacy: SessionPrLink = {
      ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
      origin: "workflow",
      workflowId: "review",
      lastSeenSha: "sha-1",
      lastSeenAt: 1000
    };
    const { dir, store } = seedStore([
      { id: "sess_legacy", updatedAt: 555, ...({ pr: legacy } as Partial<SessionMeta>) },
      { id: "sess_plain" }
    ]);

    const migrated = store.getSession("sess_legacy");
    expect(migrated?.prs).toEqual([legacy]);
    expect(migrated).not.toHaveProperty("pr");
    expect(migrated?.updatedAt).toBe(555);
    expect(store.getSession("sess_plain")).not.toHaveProperty("prs");

    const persisted = JSON.parse(readFileSync(join(dir, "test.db.json"), "utf8")) as { sessions: Array<Record<string, unknown>> };
    const raw = persisted.sessions.find((s) => s.id === "sess_legacy");
    expect(raw).not.toHaveProperty("pr");
    expect(raw?.prs).toEqual([legacy]);

    const reloaded = new SessionStore(join(dir, "test.db"));
    expect(reloaded.getSession("sess_legacy")?.prs).toEqual([legacy]);
  });

  it("drops a malformed legacy link with a warning instead of failing to load", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, store } = seedStore([
      { id: "sess_bad", ...({ pr: { ref: { host: "github.com", owner: "acme" }, origin: "opened" } } as Partial<SessionMeta>) },
      { id: "sess_null", ...({ pr: null } as Partial<SessionMeta>) }
    ]);

    expect(store.getSession("sess_bad")).not.toHaveProperty("pr");
    expect(store.getSession("sess_bad")).not.toHaveProperty("prs");
    expect(store.getSession("sess_null")).not.toHaveProperty("pr");
    expect(warn).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(readFileSync(join(dir, "test.db.json"), "utf8")) as { sessions: Array<Record<string, unknown>> };
    expect(persisted.sessions.every((s) => !("pr" in s))).toBe(true);
    warn.mockRestore();
  });

  it("merges a legacy link into existing links without duplicating the same pull request", () => {
    const legacy: SessionPrLink = {
      ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
      origin: "opened",
      lastSeenSha: "sha-legacy",
      lastSeenAt: 1
    };
    const other: SessionPrLink = { ...legacy, ref: { ...legacy.ref, number: 7 }, lastSeenSha: "sha-7" };
    const { store } = seedStore([{ id: "sess_both", prs: [other], ...({ pr: legacy } as Partial<SessionMeta>) }]);
    expect(store.getSession("sess_both")?.prs).toEqual([other, legacy]);
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
