import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { NativeSession, Project } from "@cw-code/contracts";
import { importableSessions, withRepositories } from "./sessionImport.js";
import { comparableRoot } from "./worktreeCleanup.js";

const root = join("/", "work");
const project: Project = { id: "proj_1", rootPath: join(root, "app"), name: "app" };

function native(resumeCursor: string, cwd: string, extra: Partial<NativeSession> = {}): NativeSession {
  return { driver: "codex", resumeCursor, title: resumeCursor, cwd, createdAt: 0, updatedAt: 0, ...extra };
}

describe("importableSessions", () => {
  const ctx = { claimed: new Set(["codex:claimed"]), projects: [project], appRoots: [join(root, ".cw-code")] };

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

  it("matches projects by folder and parses GitHub remotes", () => {
    const [matched, other] = importableSessions(
      [
        native("a", join(root, "app"), { updatedAt: 2, gitRemote: "git@github.com:acme/app.git" }),
        native("b", join(root, "lib"), { updatedAt: 1 })
      ],
      ctx
    );
    expect(matched).toMatchObject({ projectId: "proj_1", projectName: "app", repository: "acme/app" });
    expect(other).toMatchObject({ projectName: "lib" });
    expect(other.projectId).toBeUndefined();
  });

  it("fills repositories from folder lookups without overriding recorded ones", () => {
    const listed = importableSessions([native("a", join(root, "lib")), native("b", join(root, "app"), { gitRemote: "https://github.com/acme/app" })], ctx);
    const remotes = new Map<string, string | null>([
      [comparableRoot(join(root, "lib")), "acme/lib"],
      [comparableRoot(join(root, "app")), "acme/other"]
    ]);
    expect(withRepositories(listed, remotes).map((s) => s.repository).sort()).toEqual(["acme/app", "acme/lib"]);
  });
});
