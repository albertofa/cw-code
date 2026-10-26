import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CliDriver, HistoryMessage, NativeSession, TurnHandle } from "@cw-code/contracts";
import { SessionManager } from "./SessionManager.js";

class NativeListingDriver implements CliDriver {
  readonly kind = "claude" as const;
  native: NativeSession[] = [];
  listCalls = 0;
  async listSessions(): Promise<[]> {
    return [];
  }
  async listNativeSessions(): Promise<NativeSession[]> {
    this.listCalls += 1;
    return this.native;
  }
  async getHistory(): Promise<HistoryMessage[]> {
    return [];
  }
  startTurn(): TurnHandle {
    return { turnId: randomUUID(), events: (async function* () {})() };
  }
  interrupt(): void {}
  async renameSession(): Promise<void> {}
  async *events(): AsyncIterable<never> {}
}

function native(overrides: Partial<NativeSession> & Pick<NativeSession, "resumeCursor" | "cwd">): NativeSession {
  return { driver: "claude", title: `Session ${overrides.resumeCursor}`, createdAt: 1, updatedAt: 2, ...overrides };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cw-import-"));
  const worktreesRoot = join(dir, "worktrees");
  const legacyRoot = join(dir, "legacy-userdata");
  const manager = new SessionManager({
    dbPath: join(dir, "data", "test.db"),
    settingsPath: join(dir, "settings.json"),
    worktreesRoot,
    legacyAppRoots: [legacyRoot]
  });
  const driver = new NativeListingDriver();
  (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = { claude: driver, opencode: driver, codex: driver };
  manager.setSettings({ autoTitleEnabled: false });
  const folder = (name: string) => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return { manager, driver, worktreesRoot, legacyRoot, folder };
}

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function gitRepository(dir: string): string {
  const repository = join(dir, "repo");
  mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repository]);
  writeFileSync(join(repository, "README.md"), "base\n", "utf8");
  git(repository, "add", "README.md");
  git(repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial");
  return repository;
}

function linkedWorktree(repository: string, parent: string): string {
  mkdirSync(parent, { recursive: true });
  const worktree = join(parent, "wt");
  git(repository, "worktree", "add", "-b", "feature", worktree);
  return worktree;
}

describe("session import", () => {
  it("lists native sessions that cw-code does not already manage", async () => {
    const { manager, driver, worktreesRoot, legacyRoot, folder } = setup();
    const known = folder("known");
    const fresh = folder("fresh");
    const project = manager.addProject(known);
    const claimed = await manager.createSession(project.id, "claude", { useWorktree: false });
    (manager as unknown as { store: { updateSession(id: string, patch: { resumeCursor: string }): void } }).store.updateSession(claimed.id, {
      resumeCursor: "claimed"
    });
    driver.native = [
      native({ resumeCursor: "old", cwd: known, updatedAt: 10 }),
      native({ resumeCursor: "new", cwd: fresh, updatedAt: 20, gitRemote: "git@github.com:acme/fresh.git", gitBranch: "main" }),
      native({ resumeCursor: "claimed", cwd: known }),
      native({ resumeCursor: "by-cw", cwd: known, createdByCwCode: true }),
      native({ resumeCursor: "in-worktree", cwd: join(worktreesRoot, "proj_x", "sess_y") }),
      native({ resumeCursor: "in-legacy-worktree", cwd: join(legacyRoot, "worktrees", "proj_x", "sess_z") })
    ];

    const listed = await manager.listImportableSessions("claude");

    expect(listed.map((s) => s.resumeCursor)).toEqual(["new", "old"]);
    expect(listed[0]).toMatchObject({ projectName: "fresh", repository: "acme/fresh", gitBranch: "main" });
    expect(listed[0].projectId).toBeUndefined();
    expect(listed[1]).toMatchObject({ projectId: project.id, projectName: project.name });
  });

  it("imports into a new project rooted at the session folder and hides it afterwards", async () => {
    const { manager, driver, folder } = setup();
    const cwd = folder("outside");
    driver.native = [native({ resumeCursor: "abc", cwd, title: "Refactor auth" })];
    await manager.listImportableSessions("claude");

    const { project, session } = await manager.importSession({ driver: "claude", resumeCursor: "abc" });

    expect(project.rootPath).toBe(cwd);
    expect(session).toMatchObject({ projectId: project.id, driver: "claude", resumeCursor: "abc", title: "Refactor auth", status: "idle" });
    expect(session.worktreePath).toBeUndefined();
    expect(await manager.listSessions(project.id)).toHaveLength(1);
    expect(await manager.listImportableSessions("claude")).toEqual([]);
    await expect(manager.importSession({ driver: "claude", resumeCursor: "abc" })).rejects.toThrow(/already managed/);
  });

  it("reuses the existing project for the session folder", async () => {
    const { manager, driver, folder } = setup();
    const cwd = folder("repo");
    const project = manager.addProject(cwd);
    driver.native = [native({ resumeCursor: "abc", cwd: `${cwd}${process.platform === "win32" ? "\\" : "/"}` })];

    const result = await manager.importSession({ driver: "claude", resumeCursor: "abc" });

    expect(result.project.id).toBe(project.id);
    expect(manager.listProjects()).toHaveLength(1);
    expect(driver.listCalls).toBe(1);
  });

  it("refuses sessions whose folder is gone or that the harness never listed", async () => {
    const { manager, driver } = setup();
    driver.native = [native({ resumeCursor: "gone", cwd: join(tmpdir(), `cw-missing-${randomUUID()}`) })];

    await expect(manager.importSession({ driver: "claude", resumeCursor: "gone" })).rejects.toThrow(/no longer exists/);
    await expect(manager.importSession({ driver: "claude", resumeCursor: "unknown" })).rejects.toThrow(/not found/);
    expect(manager.listProjects()).toEqual([]);
  });

  it("hides sessions a running cw-code turn may own before its cursor is stored", async () => {
    const { manager, driver, folder } = setup();
    const cwd = folder("busy");
    const other = folder("other");
    const project = manager.addProject(cwd);
    const session = await manager.createSession(project.id, "claude", { useWorktree: false });
    await manager.startTurn(session.id, "do the thing");
    const now = Date.now();
    driver.native = [
      native({ resumeCursor: "in-flight", cwd, createdAt: now }),
      native({ resumeCursor: "older", cwd, createdAt: now - 10 * 60_000 }),
      native({ resumeCursor: "elsewhere", cwd: other, createdAt: now })
    ];

    const listed = await manager.listImportableSessions("claude");

    expect(listed.map((s) => s.resumeCursor).sort()).toEqual(["elsewhere", "older"]);
    await expect(manager.importSession({ driver: "claude", resumeCursor: "in-flight" })).rejects.toThrow(/already managed/);
  });

  it("hides sessions created after a cw-code turn that ended without a cursor", async () => {
    const { manager, driver, folder } = setup();
    const cwd = folder("errored");
    const project = manager.addProject(cwd);
    const session = await manager.createSession(project.id, "claude", { useWorktree: false });
    (manager as unknown as { store: { updateSession(id: string, patch: { title: string }): void } }).store.updateSession(session.id, {
      title: "Fix the login redirect"
    });
    driver.native = [
      native({ resumeCursor: "orphan", cwd, createdAt: session.createdAt + 1_000 }),
      native({ resumeCursor: "older", cwd, createdAt: session.createdAt - 10 * 60_000 }),
      native({ resumeCursor: "other-harness", cwd, createdAt: session.createdAt + 1_000, driver: "codex" })
    ];

    expect((await manager.listImportableSessions("claude")).map((s) => s.resumeCursor).sort()).toEqual(["older", "other-harness"]);
  });

  it("imports a worktree session into the project at its main checkout and keeps the worktree", async () => {
    const { manager, driver, folder } = setup();
    const repository = gitRepository(folder("repo"));
    const worktree = linkedWorktree(repository, folder("external"));
    driver.native = [native({ resumeCursor: "wt", cwd: worktree, title: "Worktree work" })];

    const listed = await manager.listImportableSessions("claude");

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ cwd: worktree, projectName: "repo", projectRoot: repository });
    expect(listed[0].projectId).toBeUndefined();

    const { project, session } = await manager.importSession({ driver: "claude", resumeCursor: "wt" });

    expect(project.rootPath).toBe(repository);
    expect(session.worktreePath).toBe(worktree);
    expect(manager.rootFor(session.id)).toBe(worktree);
    expect(await manager.listImportableSessions("claude")).toEqual([]);
  });

  it("reuses the project already rooted at the main checkout", async () => {
    const { manager, driver, folder } = setup();
    const repository = gitRepository(folder("repo"));
    const worktree = linkedWorktree(repository, folder("external"));
    const project = manager.addProject(repository);
    driver.native = [native({ resumeCursor: "wt", cwd: worktree })];

    const result = await manager.importSession({ driver: "claude", resumeCursor: "wt" });

    expect(result.project.id).toBe(project.id);
    expect(manager.listProjects()).toHaveLength(1);
    expect(result.session.worktreePath).toBe(worktree);
  });

  it("never removes a worktree another tool owns when resolving an imported session", async () => {
    const { manager, driver, folder } = setup();
    const repository = gitRepository(folder("repo"));
    const worktree = linkedWorktree(repository, folder("external"));
    driver.native = [native({ resumeCursor: "wt", cwd: worktree })];
    const { session } = await manager.importSession({ driver: "claude", resumeCursor: "wt" });

    const result = await manager.resolveSession(session.id, "resolved", { removeWorktree: true });

    expect(result.worktreeRemoved).toBe(false);
    expect(existsSync(worktree)).toBe(true);
    expect(manager.rootFor(session.id)).toBe(worktree);
  });
});
