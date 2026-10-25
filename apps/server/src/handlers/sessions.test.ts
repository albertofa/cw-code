import { beforeEach, describe, expect, test } from "bun:test";
import type { SidebarReorderRequest } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import type { SidebarStatusAction } from "../sidebar/SidebarService.js";
import { Router, type CallContext } from "../transport/Router.js";
import { registerSessionHandlers } from "./sessions.js";

const ctx: CallContext = { clientId: "a", client: "web", auth: { kind: "owner" } };
const REQUEST: SidebarReorderRequest = { sessionId: "s1", from: "main", to: "resolved", targetId: null, before: false };

let calls: unknown[][];
let action: SidebarStatusAction | null;
let router: Router;

beforeEach(() => {
  calls = [];
  action = null;
  const services = {
    sidebar: {
      reorder: (request: SidebarReorderRequest) => {
        calls.push(["reorder", request]);
        return action;
      }
    },
    sessions: {
      resolveSession: async (sessionId: string, status: string, options: unknown) => {
        calls.push(["resolveSession", sessionId, status, options]);
        return { sessionId, status, worktreeOrphaned: false, worktreeRemoved: true, branchDeleted: true };
      },
      restoreSession: async (sessionId: string) => {
        calls.push(["restoreSession", sessionId]);
      }
    },
    fileWatcher: { unwatch: async (sessionId: string) => calls.push(["unwatch", sessionId]) },
    ptys: { killSession: (sessionId: string) => calls.push(["killSession", sessionId]) }
  };
  router = new Router();
  registerSessionHandlers(router, { requireServices: () => services } as unknown as ServerApp);
});

const dispatch = (params: unknown) => router.dispatch("sidebar.reorder", params, ctx);

describe("sidebar.reorder", () => {
  test("resolves through the same path as sessions.resolve", async () => {
    action = "resolve";
    await dispatch(REQUEST);
    expect(calls).toEqual([
      ["reorder", REQUEST],
      ["unwatch", "s1"],
      ["resolveSession", "s1", "resolved", { removeWorktree: true, forceBranch: false }],
      ["killSession", "s1"]
    ]);
  });

  test("restores through the session restore path", async () => {
    action = "restore";
    const request: SidebarReorderRequest = { ...REQUEST, from: "resolved", to: "main", targetId: "s2", before: true };
    await dispatch(request);
    expect(calls).toEqual([
      ["reorder", request],
      ["restoreSession", "s1"]
    ]);
  });

  test("changes no status when the reorder asks for none", async () => {
    await dispatch(REQUEST);
    expect(calls).toEqual([["reorder", REQUEST]]);
  });

  test("rejects malformed requests", async () => {
    const results = await Promise.allSettled([
      dispatch(null),
      dispatch({ ...REQUEST, to: "archived" }),
      dispatch({ ...REQUEST, targetId: 3 }),
      dispatch({ ...REQUEST, before: "yes" })
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(calls).toEqual([]);
  });
});
