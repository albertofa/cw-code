import { beforeEach, describe, expect, test } from "bun:test";
import type { PrRef, SessionMeta, SessionPrItem, SessionPrLink } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import type { ServerApp } from "../app/ServerApp.js";
import type { PrHeadInfo } from "../github/prParsers.js";
import { Router, type CallContext } from "../transport/Router.js";
import { registerSessionPrHandlers } from "./sessionPrs.js";

const WIDGETS = (number: number): PrRef => ({ host: "github.com", owner: "acme", repo: "widgets", number });

let sessions: SessionMeta[];
let heads: Map<string, PrHeadInfo>;
let unlinked: Array<[string, PrRef]>;
let prItems: SessionPrItem[];
let router: Router;

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { id, projectId: "p1", driver: "claude", title: id, status: "working", resumeCursor: "", createdAt: 1, updatedAt: 2, ...overrides };
}

function find(id: string): SessionMeta | undefined {
  return sessions.find((session) => session.id === id);
}

function agent(sessionId: string): CallContext {
  return { clientId: `mcp:${sessionId}`, client: "mcp", auth: { kind: "agent", sessionId } };
}

function buildRouter(): Router {
  const built = new Router();
  const services = {
    sessions: {
      findSession: find,
      rootFor: (id: string) => `/checkouts/${id}`,
      linkPr: (id: string, link: SessionPrLink) => {
        const session = find(id);
        if (session) session.prs = [...(session.prs ?? []), link];
      },
      unlinkPr: (id: string, ref: PrRef) => {
        unlinked.push([id, ref]);
        const session = find(id);
        if (session) session.prs = (session.prs ?? []).filter((link) => prKey(link.ref) !== prKey(ref));
      }
    },
    git: { githubRemote: async () => ({ host: "github.com", owner: "acme", repository: "widgets", slug: "acme/widgets", url: "" }) },
    pullRequests: {
      head: async (ref: PrRef) => {
        const head = heads.get(prKey(ref));
        if (!head) throw new Error("GraphQL: Could not resolve to a PullRequest");
        return head;
      }
    },
    sessionPrs: { extras: () => ({ prItems, prDock: [] }) }
  };
  registerSessionPrHandlers(built, { requireServices: () => services } as unknown as Pick<ServerApp, "requireServices">);
  return built;
}

beforeEach(() => {
  sessions = [meta("parent", { branch: "feature/a" }), meta("kid", { subagent: { parentSessionId: "parent", isolation: "worktree" } })];
  heads = new Map([[prKey(WIDGETS(7)), { headRefOid: "sha-7", state: "OPEN", updatedAt: 500 }]]);
  unlinked = [];
  prItems = [];
  router = buildRouter();
});

describe("sessionPrs.link", () => {
  test("links a PR the agent opened, read from GitHub, to the caller's session", async () => {
    const reply = await router.dispatch("sessionPrs.link", { pr: "#7", opened: true }, agent("parent"));
    expect(reply).toEqual({
      sessionId: "parent",
      pr: "acme/widgets#7",
      url: "https://github.com/acme/widgets/pull/7",
      state: "OPEN",
      origin: "opened",
      alreadyLinked: false
    });
    expect(find("parent")?.prs).toEqual([
      {
        ref: WIDGETS(7),
        origin: "opened",
        lastSeenSha: "sha-7",
        lastSeenAt: expect.any(Number),
        snapshot: { state: "OPEN", headRefOid: "sha-7", updatedAt: 500, syncedAt: expect.any(Number) }
      }
    ]);
  });

  test("links a subagent's PR to its parent session as a manual link by default", async () => {
    const reply = await router.dispatch("sessionPrs.link", { pr: "https://github.com/acme/widgets/pull/7" }, agent("kid"));
    expect(reply).toMatchObject({ sessionId: "parent", origin: "linked" });
    expect(find("kid")?.prs).toBeUndefined();
    expect(find("parent")?.prs?.map((link) => link.origin)).toEqual(["linked"]);
  });

  test("leaves an existing link, matched regardless of case, untouched", async () => {
    const existing: SessionPrLink = { ref: { ...WIDGETS(7), owner: "Acme" }, origin: "workflow", workflowId: "babysit", lastSeenSha: "old", lastSeenAt: 1 };
    find("parent")!.prs = [existing];
    const reply = await router.dispatch("sessionPrs.link", { pr: "acme/widgets#7", opened: true }, agent("parent"));
    expect(reply).toMatchObject({ pr: "Acme/widgets#7", origin: "workflow", alreadyLinked: true });
    expect(find("parent")?.prs).toEqual([existing]);
  });

  test("reports a PR that GitHub cannot find and links nothing", async () => {
    await expect(router.dispatch("sessionPrs.link", { pr: "#9" }, agent("parent"))).rejects.toThrow("Could not resolve to a PullRequest");
    heads.set(prKey(WIDGETS(9)), { headRefOid: null, state: null, updatedAt: null });
    await expect(router.dispatch("sessionPrs.link", { pr: "#9" }, agent("parent"))).rejects.toThrow("could not find pull request acme/widgets#9");
    expect(find("parent")?.prs).toBeUndefined();
  });

  test("rejects an empty or non-string pr", async () => {
    await expect(router.dispatch("sessionPrs.link", { pr: "  " }, agent("parent"))).rejects.toThrow("pr must not be empty");
    await expect(router.dispatch("sessionPrs.link", { pr: 7 }, agent("parent"))).rejects.toThrow("pr must be a string");
  });
});

describe("sessionPrs.unlink", () => {
  test("unlinks from the owning session and reports whether it was linked", async () => {
    find("parent")!.prs = [{ ref: WIDGETS(7), origin: "opened", lastSeenSha: "a", lastSeenAt: 1 }];
    expect(await router.dispatch("sessionPrs.unlink", { pr: "#7" }, agent("kid"))).toEqual({ sessionId: "parent", pr: "acme/widgets#7", wasLinked: true });
    expect(await router.dispatch("sessionPrs.unlink", { pr: "#8" }, agent("parent"))).toEqual({ sessionId: "parent", pr: "acme/widgets#8", wasLinked: false });
    expect(unlinked).toEqual([
      ["parent", WIDGETS(7)],
      ["parent", WIDGETS(8)]
    ]);
    expect(find("parent")?.prs).toEqual([]);
  });
});

describe("sessionPrs.list", () => {
  test("lists the owning session's branch and PR items", async () => {
    prItems = [
      {
        key: prKey(WIDGETS(7)),
        ref: WIDGETS(7),
        source: "linked",
        link: { ref: WIDGETS(7), origin: "opened", lastSeenSha: "a", lastSeenAt: 1 },
        chip: { tone: "ok", icon: "check", label: "Passing", reason: "", title: "" },
        title: "Add widgets",
        url: "https://github.com/acme/widgets/pull/7",
        state: "OPEN",
        headSha: "a",
        unseen: false,
        urgency: 0,
        updatedAt: 1,
        canLink: false
      },
      {
        key: prKey(WIDGETS(8)),
        ref: WIDGETS(8),
        source: "branch",
        chip: { tone: "info", icon: "pr", label: "Open", reason: "", title: "" },
        title: null,
        url: "https://github.com/acme/widgets/pull/8",
        state: "OPEN",
        headSha: "",
        unseen: false,
        urgency: 0,
        updatedAt: 0,
        canLink: true
      }
    ];
    expect(await router.dispatch("sessionPrs.list", undefined, agent("kid"))).toEqual({
      sessionId: "parent",
      branch: "feature/a",
      prs: [
        { pr: "acme/widgets#7", url: "https://github.com/acme/widgets/pull/7", title: "Add widgets", state: "OPEN", linked: true, origin: "opened" },
        { pr: "acme/widgets#8", url: "https://github.com/acme/widgets/pull/8", title: null, state: "OPEN", linked: false, origin: null }
      ]
    });
  });
});

describe("sessionPrs access", () => {
  test.each(["sessionPrs.list", "sessionPrs.link", "sessionPrs.unlink"])("%s is only available to agents", async (method) => {
    const owner: CallContext = { clientId: "ui", client: "desktop-ui", auth: { kind: "owner" } };
    await expect(router.dispatch(method, { pr: "#7" }, owner)).rejects.toMatchObject({ code: "forbidden" });
  });
});
