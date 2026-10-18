import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
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
  const folder = (name: string) => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return { manager, driver, worktreesRoot, legacyRoot, folder };
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
});
