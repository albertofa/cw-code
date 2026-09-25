import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Project, SessionMeta, SessionPrLink } from "@cw-code/contracts";
import { MetadataError } from "../storage/metadataDocument.js";
import { SESSION_SCHEMA_VERSION, SessionStore } from "./SessionStore.js";

const FIXTURE = readFileSync(fileURLToPath(new URL("../storage/__fixtures__/sessions-v0.json", import.meta.url)));

function writeRaw(content: string | Buffer): { dir: string; file: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "cw-store-"));
  const file = join(dir, "test.db.json");
  writeFileSync(file, content);
  return { dir, file, dbPath: join(dir, "test.db") };
}

function readJson(file: string): { schemaVersion?: number; projects: Array<Record<string, unknown>>; sessions: Array<Record<string, unknown>>; [key: string]: unknown } {
  return JSON.parse(readFileSync(file, "utf8"));
}

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

  it("migrates the schema-0 fixture keeping every identifier, cursor, root, account and worktree reference", () => {
    const { file, dbPath } = writeRaw(FIXTURE);
    const original = JSON.parse(FIXTURE.toString("utf8")) as { projects: Project[]; sessions: SessionMeta[] };

    const store = new SessionStore(dbPath);

    expect(store.listProjects().map((p) => ({ ...p }))).toEqual(
      [...original.projects].sort((a, b) => a.name.localeCompare(b.name))
    );
    for (const session of original.sessions) {
      const expected = session.status === "working" ? { ...session, status: "holding" } : session;
      expect(store.getSession(session.id)).toEqual(expected);
    }
    const persisted = readJson(file);
    expect(persisted.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(persisted.projects).toEqual(original.projects);
    expect(persisted.sessions.map((s) => s.resumeCursor)).toEqual(original.sessions.map((s) => s.resumeCursor));
    expect(readFileSync(`${file}.v0.bak`).equals(FIXTURE)).toBe(true);
  });

  it("does not rewrite the migrated file on a later startup", () => {
    const { file, dbPath } = writeRaw(FIXTURE);
    new SessionStore(dbPath);
    const bytes = readFileSync(file);
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(file, past, past);
    const mtime = statSync(file).mtimeMs;

    const reloaded = new SessionStore(dbPath);

    expect(reloaded.listAllSessions()).toHaveLength(5);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(mtime);
    expect(readFileSync(`${file}.v0.bak`).equals(FIXTURE)).toBe(true);
  });

  it("normalizes schema-0 roots, worktree paths and GitHub accounts during migration", () => {
    const { dbPath } = writeRaw(JSON.stringify({
      projects: [
        { id: "proj_a", rootPath: "C:/fixture/a///", name: "a", githubAccount: { host: " GitHub.COM ", login: " someone " } },
        { id: "proj_b", rootPath: "/fixture/b/", name: "b", githubAccount: { host: "github.com", login: "  " } }
      ],
      sessions: [{ id: "sess_a", projectId: "proj_a", driver: "claude", title: "a", status: "idle", resumeCursor: "c", createdAt: 1, updatedAt: 2, worktreePath: "C:\\fixture\\wt\\\\" }]
    }));

    const store = new SessionStore(dbPath);

    expect(store.getProject("proj_a")).toMatchObject({ rootPath: "C:/fixture/a", githubAccount: { host: "github.com", login: "someone" } });
    expect(store.getProject("proj_b")).toEqual({ id: "proj_b", rootPath: "/fixture/b", name: "b" });
    expect(store.getSession("sess_a")?.worktreePath).toBe("C:\\fixture\\wt");
  });

  it("preserves unknown top-level and per-record fields across migration and later writes", () => {
    const { file, dbPath } = writeRaw(JSON.stringify({
      projects: [{ id: "proj_a", rootPath: "/fixture/a", name: "a", futureProjectField: { keep: true } }],
      sessions: [{ id: "sess_a", projectId: "proj_a", driver: "claude", title: "a", status: "idle", resumeCursor: "c", createdAt: 1, updatedAt: 2, futureSessionField: [1, 2] }],
      futureTopLevel: "kept"
    }));

    const store = new SessionStore(dbPath);
    store.addProject("/fixture/b");
    store.updateSession("sess_a", { title: "renamed" });

    const persisted = readJson(file);
    expect(persisted.futureTopLevel).toBe("kept");
    expect(persisted.projects[0]).toMatchObject({ futureProjectField: { keep: true } });
    expect(persisted.sessions[0]).toMatchObject({ title: "renamed", futureSessionField: [1, 2] });
    expect(persisted.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
  });

  it("writes schemaVersion for a brand new store", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-store-"));
    const store = new SessionStore(join(dir, "test.db"));
    store.addProject("/fixture/new");
    expect(readJson(join(dir, "test.db.json"))).toMatchObject({ schemaVersion: SESSION_SCHEMA_VERSION, sessions: [] });
  });

  it.each([
    ["corrupt JSON", "not-json{{{", "corrupt"],
    ["a newer schema", '{"schemaVersion":99,"projects":[],"sessions":[]}', "future-schema"],
    ["a missing sessions array", '{"projects":[]}', "invalid-shape"],
    ["a project without a root", '{"projects":[{"id":"proj_a"}],"sessions":[]}', "invalid-shape"]
  ])("refuses %s instead of starting empty and leaves the file untouched", (_label, content, kind) => {
    const { file, dbPath } = writeRaw(content);
    let thrown: unknown;
    try {
      new SessionStore(dbPath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MetadataError);
    expect((thrown as MetadataError).kind).toBe(kind);
    expect((thrown as MetadataError).store).toBe("sessions");
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("refuses to start empty when the store file is gone but its last-good backup is restorable", () => {
    const { file, dbPath } = writeRaw(FIXTURE);
    new SessionStore(dbPath);
    new SessionStore(dbPath);
    rmSync(file);

    let thrown: unknown;
    try {
      new SessionStore(dbPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MetadataError);
    expect((thrown as MetadataError).kind).toBe("missing");
    expect(existsSync(file)).toBe(false);
  });
});
