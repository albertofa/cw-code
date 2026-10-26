import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { NativeSession, Project } from "@cw-code/contracts";
import type { WorktreeProject } from "../fs/GitService.js";
import { importableSessions, withProjects, withRepositories } from "./sessionImport.js";
import { comparableRoot } from "./worktreeCleanup.js";

const root = join("/", "work");
const project: Project = { id: "proj_1", rootPath: join(root, "app"), name: "app" };
const noWorktrees = new Map<string, WorktreeProject>();

function native(resumeCursor: string, cwd: string, extra: Partial<NativeSession> = {}): NativeSession {
  return { driver: "codex", resumeCursor, title: resumeCursor, cwd, createdAt: 0, updatedAt: 0, ...extra };
}

function worktreeOf(main: string, worktree: string): Map<string, WorktreeProject> {
  return new Map([[comparableRoot(worktree), { projectRoot: main, worktreePath: worktree }]]);
}

describe("importableSessions", () => {
  const ctx = { claimed: new Set(["codex:claimed"]), pending: [], appRoots: [join(root, ".cw-code")] };

  it("hides claimed, cw-originated and app-folder sessions and dedupes", () => {
    const listed = importableSessions(
      [
        native("keep", join(root, "app")),
        native("keep", join(root, "app")),
        native("claimed", join(root, "app")),
        native("by-cw", join(root, "app"), { createdByCwCode: true }),
        native("internal", join(root, ".cw-code", "worktrees", "proj_1", "sess_1")),
        native("app-root", join(root, ".cw-code")),
        native("sibling", join(root, ".cw-code-other"))
      ],
      ctx
    );
    expect(listed.map((s) => s.resumeCursor).sort()).toEqual(["keep", "sibling"]);
  });

  it("hides sessions a pending cw-code turn may own in the same folder and harness", () => {
    const pending = [{ driver: "codex" as const, root: join(root, "app"), since: 1_000_000 }];
    const listed = importableSessions(
      [
        native("after", join(root, "app"), { createdAt: 1_000_500 }),
        native("just-before", join(root, "app"), { createdAt: 990_000 }),
        native("long-before", join(root, "app"), { createdAt: 100_000 }),
        native("other-folder", join(root, "lib"), { createdAt: 1_000_500 }),
        native("other-harness", join(root, "app"), { createdAt: 1_000_500, driver: "claude" })
      ],
      { ...ctx, pending }
    );
    expect(listed.map((s) => s.resumeCursor).sort()).toEqual(["long-before", "other-folder", "other-harness"]);
  });
});

describe("withProjects", () => {
  const ctx = { claimed: new Set<string>(), pending: [], appRoots: [join(root, ".cw-code")] };

  it("matches projects by folder and parses GitHub remotes", () => {
    const sessions = importableSessions(
      [
        native("a", join(root, "app"), { updatedAt: 2, gitRemote: "git@github.com:acme/app.git" }),
        native("b", join(root, "lib"), { updatedAt: 1 })
      ],
      ctx
    );
    const [matched, other] = withProjects(sessions, [project], noWorktrees);
    expect(matched).toMatchObject({ projectId: "proj_1", projectName: "app", projectRoot: join(root, "app"), repository: "acme/app" });
    expect(other).toMatchObject({ projectName: "lib", projectRoot: join(root, "lib") });
    expect(other.projectId).toBeUndefined();
  });

  it("puts a worktree session in the project rooted at its main checkout", () => {
    const worktree = join(root, ".t3", "worktrees", "app", "t3code-1234");
    const sessions = importableSessions([native("wt", worktree)], ctx);

    const [session] = withProjects(sessions, [project], worktreeOf(project.rootPath, worktree));

    expect(session).toMatchObject({ cwd: worktree, projectId: "proj_1", projectName: "app", projectRoot: project.rootPath });
  });

  it("names a new project after the main checkout of a worktree", () => {
    const main = join(root, "fresh");
    const worktree = join(root, ".t3", "worktrees", "fresh", "t3code-5678");
    const sessions = importableSessions([native("new", worktree)], ctx);

    const [session] = withProjects(sessions, [], worktreeOf(main, worktree));

    expect(session).toMatchObject({ projectName: "fresh", projectRoot: main, cwd: worktree });
    expect(session.projectId).toBeUndefined();
  });

  it("fills repositories from folder lookups without overriding recorded ones", () => {
    const sessions = importableSessions([native("a", join(root, "lib")), native("b", join(root, "app"), { gitRemote: "https://github.com/acme/app" })], ctx);
    const remotes = new Map<string, string | null>([
      [comparableRoot(join(root, "lib")), "acme/lib"],
      [comparableRoot(join(root, "app")), "acme/other"]
    ]);
    expect(withRepositories(withProjects(sessions, [project], noWorktrees), remotes).map((s) => s.repository).sort()).toEqual(["acme/app", "acme/lib"]);
  });
});
