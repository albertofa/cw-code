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
let dirty: boolean;
let owners: Record<string, string | null>;
let router: Router;
let projectRoot: string;

beforeEach(() => {
  calls = [];
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
      switchBranch: async (id: string, branch: string) => calls.push(["switchBranch", id, branch]),
      pullBranch: async (id: string) => calls.push(["pullBranch", id]),
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
      pullFastForward: async (root: string) => calls.push(["pullFastForward", root])
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
