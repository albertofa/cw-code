import { beforeEach, describe, expect, test } from "bun:test";
import type { ServerApp } from "../app/ServerApp.js";
import { Router, type CallContext } from "../transport/Router.js";
import { registerHistoryHandlers } from "./history.js";

const ctx: CallContext = { clientId: "a", client: "web", auth: { kind: "owner" } };

const SESSION_ROOT = "/repo/.worktrees/s1";
const MAIN = "/repo";
const OWNED = "/repo/.worktrees/s2";
const FREE = "/repo/.worktrees/free";

let calls: unknown[][];
let refreshed: string[];
let purposes: Array<string | undefined>;
let switchFailure: Error | null;
let dirty: boolean;
let owners: Record<string, string | null>;
let router: Router;
let projectRoot: string;

beforeEach(() => {
  calls = [];
  refreshed = [];
  purposes = [];
  switchFailure = null;
  dirty = false;
  projectRoot = FREE;
  owners = { [MAIN]: null, [SESSION_ROOT]: "s1", [OWNED]: "s2", [FREE]: null };
  const services = {
    sessions: {
      hasSession: (id: string) => id === "s1",
      getProject: (id: string) => {
        if (id !== "p1") throw new Error(`unknown project ${id}`);
        return { rootPath: projectRoot };
      },
      sessionStatusContext: async () => ({ root: SESSION_ROOT }),
      checkoutOwner: (path: string) => owners[path] ?? null,
      switchBranch: async (id: string, branch: string) => {
        calls.push(["switchBranch", id, branch]);
        if (switchFailure) throw switchFailure;
      },
      pullBranch: async (id: string) => calls.push(["pullBranch", id]),
      runCheckoutAction: async (id: string, run: (root: string) => Promise<void>, purpose?: string) => {
        calls.push(["runCheckoutAction", id]);
        purposes.push(purpose);
        return run(id === "s1" ? SESSION_ROOT : OWNED);
      },
      withUnownedCheckout: async <T>(root: string, run: () => Promise<T>) => {
        calls.push(["lock", root]);
        return run();
      }
    },
    git: {
      isWorkingTreeDirty: async (root: string) => {
        calls.push(["dirtyCheck", root]);
        return dirty;
      },
      checkoutBranch: async (root: string, branch: string) => calls.push(["checkoutBranch", root, branch]),
      pullFastForward: async (root: string) => calls.push(["pullFastForward", root]),
      githubRemote: async () => ({ host: "github.com", owner: "acme", repository: "app" }),
      fetchAll: async (root: string) => calls.push(["fetchAll", root]),
      push: async (root: string) => calls.push(["push", root]),
      stashPush: async (root: string, message?: string) => calls.push(["stashPush", root, message]),
      stashPop: async (root: string, sha: string) => calls.push(["stashPop", root, sha]),
      createBranch: async (root: string, name: string, sha: string, checkout: boolean) => calls.push(["createBranch", root, name, sha, checkout]),
      deleteBranchAt: async (root: string, name: string, sha: string) => {
        calls.push(["deleteBranchAt", root, name, sha]);
        return true;
      }
    },
    historyTopic: {
      rootsChanged: (roots: string[]) => refreshed.push(...roots)
    },
    commitPulls: {
      resolve: async (root: string, sha: string) => {
        calls.push(["commitPulls", root, sha]);
        return { pulls: [], unavailable: null };
      }
    },
    history: {
      worktrees: async () => [
        { path: MAIN, isMain: true },
        { path: SESSION_ROOT, isMain: false },
        { path: OWNED, isMain: false },
        { path: FREE, isMain: false }
      ],
      log: async (root: string) => {
        calls.push(["log", root]);
        return { commits: [], worktrees: [{ path: MAIN }, { path: OWNED }], homePath: MAIN };
      },
      wipCount: async (root: string) => {
        calls.push(["wipCount", root]);
        return 3;
      }
    }
  };
  router = new Router();
  registerHistoryHandlers(router, { requireServices: () => services } as unknown as ServerApp);
});

const dispatch = (method: string, params: unknown) => router.dispatch(method, params, ctx);

describe("history target resolution", () => {
  test("rejects an unknown session", async () => {
    await expect(dispatch("history.log", { sessionId: "nope" })).rejects.toThrow("unknown session nope");
  });

  test("rejects a worktree that does not belong to the repository", async () => {
    await expect(dispatch("history.checkout", { sessionId: "s1", worktree: "/elsewhere", branch: "main" })).rejects.toThrow("is not a worktree of this repository");
    expect(calls).toEqual([]);
  });

  test("reads the session checkout without a worktree and the worktree itself with one", async () => {
    const own = await dispatch("history.log", { sessionId: "s1" });
    const other = await dispatch("history.log", { sessionId: "s1", worktree: FREE });
    expect(calls).toEqual([
      ["log", SESSION_ROOT],
      ["log", FREE],
      ["wipCount", FREE]
    ]);
    expect(own).toMatchObject({ wipCount: null, worktrees: [{ path: MAIN, sessionId: null }, { path: OWNED, sessionId: "s2" }] });
    expect(other).toMatchObject({ wipCount: 3 });
  });
});

describe("history project target", () => {
  test("rejects both or neither of sessionId and projectId", async () => {
    await expect(dispatch("history.log", { sessionId: "s1", projectId: "p1" })).rejects.toThrow("pass either sessionId or projectId");
    await expect(dispatch("history.log", {})).rejects.toThrow("pass either sessionId or projectId");
    await expect(dispatch("history.pull", { sessionId: "", projectId: "" })).rejects.toThrow("pass either sessionId or projectId");
  });

  test("rejects an unknown project", async () => {
    await expect(dispatch("history.log", { projectId: "nope" })).rejects.toThrow("unknown project nope");
  });

  test("returns the uncommitted count for the project root", async () => {
    const log = await dispatch("history.log", { projectId: "p1" });
    expect(calls).toEqual([
      ["log", FREE],
      ["wipCount", FREE]
    ]);
    expect(log).toMatchObject({ wipCount: 3 });
  });

  test("goes through the owning session when one holds the project root", async () => {
    projectRoot = OWNED;
    await dispatch("history.checkout", { projectId: "p1", branch: "feat" });
    await dispatch("history.pull", { projectId: "p1" });
    expect(calls).toEqual([
      ["switchBranch", "s2", "feat"],
      ["pullBranch", "s2"]
    ]);
  });

  test("takes the folder lock on the project root when no session owns it", async () => {
    await dispatch("history.checkout", { projectId: "p1", branch: "feat" });
    expect(calls).toEqual([
      ["lock", FREE],
      ["checkoutBranch", FREE, "feat"]
    ]);
  });

  test("refuses a dirty main checkout", async () => {
    projectRoot = MAIN;
    dirty = true;
    await expect(dispatch("history.pull", { projectId: "p1" })).rejects.toThrow("uncommitted changes");
    expect(calls).toEqual([
      ["lock", MAIN],
      ["dirtyCheck", MAIN]
    ]);
  });

  test("reads commits from the project root", async () => {
    await expect(dispatch("history.commit", { projectId: "p1", sha: "x" })).rejects.toThrow("full 40-character");
  });
});

describe("history branch actions", () => {
  test("act on the session itself without a worktree", async () => {
    await dispatch("history.checkout", { sessionId: "s1", branch: "feat" });
    await dispatch("history.pull", { sessionId: "s1" });
    expect(calls).toEqual([
      ["switchBranch", "s1", "feat"],
      ["pullBranch", "s1"]
    ]);
  });

  test("go through the owning session for an owned worktree", async () => {
    await dispatch("history.checkout", { sessionId: "s1", worktree: OWNED, branch: "feat" });
    await dispatch("history.pull", { sessionId: "s1", worktree: OWNED });
    expect(calls).toEqual([
      ["switchBranch", "s2", "feat"],
      ["pullBranch", "s2"]
    ]);
  });

  test("take the folder lock on the worktree's own root when no session owns it", async () => {
    await dispatch("history.checkout", { sessionId: "s1", worktree: FREE, branch: "feat" });
    await dispatch("history.pull", { sessionId: "s1", worktree: FREE });
    expect(calls).toEqual([
      ["lock", FREE],
      ["checkoutBranch", FREE, "feat"],
      ["lock", FREE],
      ["pullFastForward", FREE]
    ]);
  });

  test("refuse to touch a dirty main checkout no session owns", async () => {
    dirty = true;
    await expect(dispatch("history.checkout", { sessionId: "s1", worktree: MAIN, branch: "feat" })).rejects.toThrow("uncommitted changes");
    await expect(dispatch("history.pull", { sessionId: "s1", worktree: MAIN })).rejects.toThrow("uncommitted changes");
    expect(calls).toEqual([
      ["lock", MAIN],
      ["dirtyCheck", MAIN],
      ["lock", MAIN],
      ["dirtyCheck", MAIN]
    ]);
  });

  test("rejects a checkout without a branch name", async () => {
    await expect(dispatch("history.checkout", { sessionId: "s1", branch: "" })).rejects.toThrow("branch must be a name");
  });
});

describe("history.commitPulls", () => {
  const sha = "b".repeat(40);

  test("rejects a short sha", async () => {
    await expect(dispatch("history.commitPulls", { sessionId: "s1", sha: "abc" })).rejects.toThrow("sha must be a full 40-character commit id");
    expect(calls).toEqual([]);
  });

  test("requires exactly one scope", async () => {
    await expect(dispatch("history.commitPulls", { sha })).rejects.toThrow("pass either sessionId or projectId");
    await expect(dispatch("history.commitPulls", { sessionId: "s1", projectId: "p1", sha })).rejects.toThrow("pass either sessionId or projectId");
  });

  test("passes the service result through for a session and a project", async () => {
    expect(await dispatch("history.commitPulls", { sessionId: "s1", sha })).toEqual({ pulls: [], unavailable: null });
    expect(await dispatch("history.commitPulls", { projectId: "p1", sha })).toEqual({ pulls: [], unavailable: null });
    expect(calls).toEqual([
      ["commitPulls", SESSION_ROOT, sha],
      ["commitPulls", FREE, sha]
    ]);
  });
});

describe("history git actions", () => {
  const sha = "c".repeat(40);

  test("go through the session's own checkout", async () => {
    await dispatch("history.fetch", { sessionId: "s1" });
    await dispatch("history.stash", { sessionId: "s1", message: "wip" });
    expect(calls).toEqual([
      ["runCheckoutAction", "s1"],
      ["fetchAll", SESSION_ROOT],
      ["runCheckoutAction", "s1"],
      ["stashPush", SESSION_ROOT, "wip"]
    ]);
  });

  test("go through the owning session for an owned worktree", async () => {
    await dispatch("history.push", { sessionId: "s1", worktree: OWNED });
    expect(calls).toEqual([
      ["runCheckoutAction", "s2"],
      ["push", OWNED]
    ]);
  });

  test("take the folder lock when no session owns the checkout", async () => {
    await dispatch("history.push", { sessionId: "s1", worktree: FREE });
    expect(calls).toEqual([
      ["lock", FREE],
      ["push", FREE]
    ]);
  });

  test("refuse a dirty main checkout only for pop and a branch with checkout", async () => {
    dirty = true;
    await dispatch("history.fetch", { sessionId: "s1", worktree: MAIN });
    await dispatch("history.stash", { sessionId: "s1", worktree: MAIN });
    await dispatch("history.branch", { sessionId: "s1", worktree: MAIN, name: "feat", sha, checkout: false });
    expect(calls.filter((call) => call[0] === "dirtyCheck")).toEqual([]);
    await expect(dispatch("history.stashPop", { sessionId: "s1", worktree: MAIN, sha })).rejects.toThrow(
      "The main checkout has uncommitted changes — commit or stash them before popping a stash"
    );
    await expect(dispatch("history.branch", { sessionId: "s1", worktree: MAIN, name: "feat", sha, checkout: true })).rejects.toThrow(
      "The main checkout has uncommitted changes — commit or stash them before switching branches or pulling"
    );
    expect(calls.filter((call) => call[0] === "dirtyCheck")).toEqual([
      ["dirtyCheck", MAIN],
      ["dirtyCheck", MAIN]
    ]);
  });

  test("pop the stash the client confirmed and require its full sha", async () => {
    await dispatch("history.stashPop", { sessionId: "s1", sha });
    expect(calls.at(-1)).toEqual(["stashPop", SESSION_ROOT, sha]);
    await expect(dispatch("history.stashPop", { sessionId: "s1" })).rejects.toThrow("full 40-character");
    await expect(dispatch("history.stashPop", { sessionId: "s1", sha: "abc" })).rejects.toThrow("full 40-character");
  });

  test("tell a running session apart from a branch switch", async () => {
    await dispatch("history.fetch", { sessionId: "s1" });
    await dispatch("history.push", { sessionId: "s1", worktree: OWNED });
    await dispatch("history.stashPop", { sessionId: "s1", sha });
    expect(purposes).toEqual(["changing this checkout", "changing this checkout", "changing this checkout"]);
  });

  test("refresh the History topics of the checkout each action ran in", async () => {
    await dispatch("history.fetch", { sessionId: "s1" });
    await dispatch("history.push", { sessionId: "s1", worktree: OWNED });
    await dispatch("history.stash", { sessionId: "s1", worktree: FREE });
    await dispatch("history.checkout", { sessionId: "s1", worktree: FREE, branch: "feat" });
    await dispatch("history.pull", { sessionId: "s1" });
    expect(refreshed).toEqual([SESSION_ROOT, OWNED, FREE, FREE, SESSION_ROOT]);
  });

  test("do not refresh after a failed action", async () => {
    dirty = true;
    await expect(dispatch("history.stashPop", { sessionId: "s1", worktree: MAIN, sha })).rejects.toThrow("uncommitted changes");
    expect(refreshed).toEqual([]);
  });

  test("delete the new branch again when its checkout is refused", async () => {
    switchFailure = new Error("busy");
    await expect(dispatch("history.branch", { sessionId: "s1", name: "feat", sha, checkout: true })).rejects.toThrow("busy");
    expect(calls.map((call) => call[0])).toEqual(["runCheckoutAction", "createBranch", "switchBranch", "deleteBranchAt"]);
    expect(calls.at(-1)).toEqual(["deleteBranchAt", SESSION_ROOT, "feat", sha]);
  });

  test("check out a new branch through the session, so its stored branch follows", async () => {
    await dispatch("history.branch", { sessionId: "s1", name: "feat", sha, checkout: true });
    expect(calls.map((call) => call[0])).toEqual(["runCheckoutAction", "createBranch", "switchBranch"]);
    expect(calls.at(-1)).toEqual(["switchBranch", "s1", "feat"]);
  });

  test("validate branch arguments", async () => {
    await expect(dispatch("history.branch", { sessionId: "s1", name: "", sha, checkout: false })).rejects.toThrow("name must be");
    await expect(dispatch("history.branch", { sessionId: "s1", name: "x", sha: "abc", checkout: false })).rejects.toThrow("full 40-character");
    await expect(dispatch("history.branch", { sessionId: "s1", name: "x", sha, checkout: "yes" })).rejects.toThrow("checkout must be");
  });

  test("history.log carries the github.com repo", async () => {
    expect(await dispatch("history.log", { sessionId: "s1" })).toMatchObject({ github: { owner: "acme", repo: "app" } });
  });
});
