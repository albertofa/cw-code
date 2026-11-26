import { describe, expect, test } from "bun:test";
import type { HistoryLog, HistoryRef, HistoryWorktree, PrRef, PrSummary, SessionMeta, SessionRow } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import {
  buildSidebarModel,
  defaultStash,
  filterSidebarModel,
  groupBranches,
  hiddenOpenPrs,
  prForBranch,
  projectSessions,
  remoteGroups,
  sectionCounts,
  sessionCheckout,
  sessionRunningIn,
  stashBranch,
  unionPrs
} from "./sidebarModel.js";

function ref(kind: HistoryRef["kind"], name: string, extra: Partial<HistoryRef> = {}): HistoryRef {
  return {
    fullName: kind === "local" ? `refs/heads/${name}` : kind === "remote" ? `refs/remotes/${name}` : kind === "tag" ? `refs/tags/${name}` : name,
    name,
    kind,
    target: `sha-${name}`,
    isCurrent: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    ...extra
  };
}

const prRef = (number: number, owner = "nuria"): PrRef => ({ host: "github.com", owner, repo: "infra", number });

function summary(number: number, extra: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: prRef(number),
    url: `https://github.com/nuria/infra/pull/${number}`,
    title: `PR ${number}`,
    state: "OPEN",
    isDraft: false,
    author: { login: "someone", isBot: false },
    viewerIsAuthor: false,
    reviewRequestedFromViewer: false,
    headRefName: `branch-${number}`,
    headRefOid: `oid-${number}`,
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "passing",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 } as PrSummary["checks"],
    review: "none",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 0,
    ...extra
  };
}

function row(id: string, extra: Partial<SessionMeta> = {}, rowExtra: Partial<SessionRow> = {}): SessionRow {
  return {
    session: {
      id,
      projectId: "p1",
      driver: "claude",
      title: `Session ${id}`,
      status: "idle",
      resumeCursor: "",
      createdAt: 0,
      updatedAt: 0,
      ...extra
    },
    busy: false,
    branch: null,
    attention: null,
    babysit: null,
    prBadge: null,
    pendingQuestionIds: [],
    latestUnseenPrUpdateAt: null,
    prMuted: false,
    ...rowExtra
  };
}

const link = (number: number, owner?: string) => ({ ref: prRef(number, owner), origin: "linked" as const, lastSeenSha: "", lastSeenAt: 0 });

describe("groupBranches", () => {
  test("lists local branches with the current one first, then by name", () => {
    const { local } = groupBranches([ref("local", "zeta"), ref("local", "alpha"), ref("local", "main", { isCurrent: true })]);
    expect(local.map((entry) => entry.name)).toEqual(["main", "alpha", "zeta"]);
  });

  test("keeps remote-only branches and drops the twins of local branches", () => {
    const { remoteOnly } = groupBranches([
      ref("local", "main", { upstream: "origin/main" }),
      ref("local", "renamed", { upstream: "origin/feat/remote-name" }),
      ref("local", "feature"),
      ref("remote", "origin/main"),
      ref("remote", "origin/feat/remote-name"),
      ref("remote", "origin/feature"),
      ref("remote", "origin/docs/only-remote"),
      ref("remote", "upstream/another"),
      ref("tag", "v1.0.0")
    ]);
    expect(remoteOnly.map((entry) => entry.name)).toEqual(["origin/docs/only-remote", "upstream/another"]);
  });

  test("groups remote-only branches per remote with origin first", () => {
    const groups = remoteGroups([ref("remote", "fork/x"), ref("remote", "origin/b"), ref("remote", "origin/a"), ref("remote", "alpha/y")]);
    expect(groups.map((group) => [group.remote, group.refs.map((entry) => entry.name)])).toEqual([
      ["origin", ["origin/b", "origin/a"]],
      ["alpha", ["alpha/y"]],
      ["fork", ["fork/x"]]
    ]);
  });
});

describe("sessionCheckout", () => {
  const worktree = (path: string, isMain: boolean, sessionId: string | null): HistoryWorktree => ({
    key: path,
    path,
    name: path.split("/").pop() ?? path,
    branch: null,
    head: null,
    isCurrent: false,
    isMain,
    sessionId
  });
  const worktrees = [worktree("/repo", true, "newest-folder-session"), worktree("/wt/sess_1", false, "s1")];

  test("matches the session's own worktree path, ignoring trailing separators and backslashes", () => {
    expect(sessionCheckout(worktrees, { worktreePath: "/wt/sess_1/" })?.path).toBe("/wt/sess_1");
    expect(sessionCheckout([worktree("C:/wt/sess_2", false, null)], { worktreePath: "c:\\wt\\Sess_2" })?.path).toBe("C:/wt/sess_2");
  });

  test("resolves a folder session to the main checkout even when another session owns it", () => {
    expect(sessionCheckout(worktrees, {})?.path).toBe("/repo");
  });

  test("finds nothing for a worktree outside this repository", () => {
    expect(sessionCheckout(worktrees, { worktreePath: "/elsewhere" })).toBeNull();
  });
});

describe("stash defaults", () => {
  const stash = (index: number, subject: string) => ({ ref: ref("stash", `stash@{${index}}`), subject });

  test("reads the branch a stash was made on", () => {
    expect(stashBranch("On feature/x: parked")).toBe("feature/x");
    expect(stashBranch("WIP on main: abc1234 subject: with colon")).toBe("main");
    expect(stashBranch("WIP on (no branch): abc1234 subject")).toBe("(no branch)");
    expect(stashBranch("")).toBeNull();
  });

  test("prefers the newest stash made on the checked-out branch, else the top one", () => {
    const stashes = [stash(0, "On other: top"), stash(1, "WIP on main: abc1234 mine"), stash(2, "On main: older")];
    expect(defaultStash(stashes, "main")?.ref.name).toBe("stash@{1}");
    expect(defaultStash(stashes, "elsewhere")?.ref.name).toBe("stash@{0}");
    expect(defaultStash(stashes, null)?.ref.name).toBe("stash@{0}");
    expect(defaultStash([], "main")).toBeNull();
  });
});

describe("sessionRunningIn", () => {
  const worktree = (path: string, isMain: boolean): HistoryWorktree => ({ key: path, path, name: path, branch: null, head: null, isCurrent: false, isMain, sessionId: null });
  const worktrees = [worktree("/repo", true), worktree("/wt/s2", false)];

  test("finds a busy session whose checkout is the given path", () => {
    const rows = [row("s1", {}, { busy: true }), row("s2", { worktreePath: "/wt/s2" }, { busy: false })];
    expect(sessionRunningIn(rows, worktrees, "/repo")?.session.id).toBe("s1");
    expect(sessionRunningIn(rows, worktrees, "/wt/s2")).toBeNull();
    expect(sessionRunningIn(rows, worktrees, null)).toBeNull();
  });
});

describe("projectSessions", () => {
  test("keeps the project's visible sessions with this session first", () => {
    const rows = [
      row("old", { updatedAt: 1 }),
      row("new", { updatedAt: 5 }),
      row("me", { updatedAt: 2 }),
      row("child", { updatedAt: 9, subagent: { parentSessionId: "me", isolation: "shared" } }),
      row("gone", { updatedAt: 9, status: "resolved" }),
      row("archived", { updatedAt: 9, status: "archived" }),
      row("elsewhere", { updatedAt: 9, projectId: "p2" })
    ];
    expect(projectSessions(rows, "p1", "me").map((entry) => entry.session.id)).toEqual(["me", "new", "old"]);
  });

  test("lists nothing without a project", () => {
    expect(projectSessions([row("a")], null, null)).toEqual([]);
  });
});

describe("unionPrs", () => {
  test("puts this session's PRs first, then other sessions', then open PRs, without duplicates", () => {
    const sessions = [row("other", { prs: [link(151), link(145)] }), row("me", { prs: [link(145)] })];
    const open = [summary(150), summary(151), summary(149)];
    const prs = unionPrs(sessions, "me", open, new Map([[prKey(prRef(145)), summary(145, { title: "Runner" })]]));
    expect(prs.map((pr) => [pr.ref.number, pr.sessionId, pr.linkedHere])).toEqual([
      [145, "me", true],
      [151, "other", false],
      [150, null, false],
      [149, null, false]
    ]);
    expect(prs[0]?.title).toBe("Runner");
    expect(prs[1]?.title).toBe("PR 151");
  });

  test("treats references that differ only in case as the same PR", () => {
    const prs = unionPrs([row("me", { prs: [link(7, "Nuria")] })], "me", [summary(7)], new Map());
    expect(prs).toHaveLength(1);
    expect(prs[0]?.sessionId).toBe("me");
    expect(prs[0]?.headRefName).toBe("branch-7");
  });

  test("keeps only linked PRs of this repository when it is known", () => {
    const foreign = { ref: { host: "github.com", owner: "other", repo: "tools", number: 9 }, origin: "linked" as const, lastSeenSha: "", lastSeenAt: 0 };
    const sessions = [row("me", { prs: [foreign, link(3, "NURIA")] })];
    expect(unionPrs(sessions, "me", [], new Map(), { owner: "nuria", repo: "INFRA" }).map((pr) => pr.ref.number)).toEqual([3]);
    expect(unionPrs(sessions, "me", [], new Map()).map((pr) => pr.ref.number)).toEqual([9, 3]);
  });

  test("tags nothing as linked here in project scope", () => {
    const prs = unionPrs([row("a", { prs: [link(1)] })], null, [], new Map());
    expect(prs[0]?.linkedHere).toBe(false);
    expect(prs[0]?.sessionId).toBe("a");
  });
});

describe("prForBranch", () => {
  const prs = unionPrs([], null, [summary(1, { headRefName: "feature", state: "MERGED" }), summary(2, { headRefName: "feature" }), summary(3, { headRefName: "remote-name" })], new Map());

  test("prefers the open PR whose head is the branch", () => {
    expect(prForBranch(prs, ref("local", "feature"))?.ref.number).toBe(2);
  });

  test("never marks a branch with a PR whose head and base share its name, like a fork's main", () => {
    const fork = unionPrs([], null, [summary(4, { headRefName: "main", baseRefName: "main" })], new Map());
    expect(prForBranch(fork, ref("local", "main"))).toBeNull();
  });

  test("matches the tracked branch and remote branches by their short name", () => {
    expect(prForBranch(prs, ref("local", "local", { upstream: "origin/remote-name" }))?.ref.number).toBe(3);
    expect(prForBranch(prs, ref("remote", "origin/feature"))?.ref.number).toBe(2);
    expect(prForBranch(prs, ref("local", "main"))).toBeNull();
  });
});

describe("buildSidebarModel and filterSidebarModel", () => {
  const log: HistoryLog = {
    head: { sha: "sha-main", branch: "main", detached: false },
    refs: [
      ref("local", "main", { isCurrent: true, upstream: "origin/main" }),
      ref("local", "cw/saml"),
      ref("remote", "origin/main"),
      ref("remote", "origin/docs/acs"),
      ref("tag", "v0.9.0"),
      ref("tag", "v0.10.0"),
      ref("stash", "stash@{1}", { target: "s1" }),
      ref("stash", "stash@{0}", { target: "s0" })
    ],
    commits: [
      { sha: "s0", parents: [], authorName: "", authorEmail: "", authorDate: 0, committerDate: 0, subject: "On main: try idle.sh", isStash: true },
      { sha: "s1", parents: [], authorName: "", authorEmail: "", authorDate: 0, committerDate: 0, subject: "WIP on cw/saml: saml", isStash: true }
    ],
    truncated: false,
    worktrees: [
      { key: "main", path: "/repo", name: "repo", branch: "main", head: "sha-main", isCurrent: false, isMain: true, sessionId: null },
      { key: "w1", path: "/wt/sess_1", name: "sess_1", branch: "cw/saml", head: "sha-cw/saml", isCurrent: true, isMain: false, sessionId: "me" }
    ],
    wipCount: null,
    github: { owner: "nuria", repo: "infra" }
  };
  const input = {
    log,
    rows: [row("me", { title: "OpenSearch SAML", prs: [link(151)] }), row("other", { title: "Elastic log config" })],
    projectId: "p1",
    sessionId: "me",
    homePath: "/wt/sess_1",
    openPrs: [summary(150, { title: "docs: ACS route notes" })],
    openCount: null,
    summaries: new Map<string, PrSummary>()
  };
  const model = buildSidebarModel(input);

  test("builds every section from the log, the sidebar rows and the open PRs", () => {
    expect(model.tags.map((entry) => entry.name)).toEqual(["v0.10.0", "v0.9.0"]);
    expect(model.stashes.map((entry) => [entry.ref.name, entry.subject])).toEqual([
      ["stash@{0}", "On main: try idle.sh"],
      ["stash@{1}", "WIP on cw/saml: saml"]
    ]);
    expect(model.worktrees.map((entry) => [entry.worktree.name, entry.owner?.session.id ?? null, entry.isHome])).toEqual([
      ["repo", null, false],
      ["sess_1", "me", true]
    ]);
    expect(sectionCounts(model)).toEqual({ sessions: 2, prs: 2, branches: 3, worktrees: 2, tags: 2, stashes: 2 });
  });

  test("filters every section case-insensitively and recounts", () => {
    expect(sectionCounts(filterSidebarModel(model, "SAML"))).toEqual({ sessions: 1, prs: 1, branches: 1, worktrees: 1, tags: 0, stashes: 1 });
    expect(sectionCounts(filterSidebarModel(model, "acs"))).toEqual({ sessions: 0, prs: 1, branches: 1, worktrees: 0, tags: 0, stashes: 0 });
    expect(sectionCounts(filterSidebarModel(model, "#151"))).toEqual({ sessions: 0, prs: 1, branches: 0, worktrees: 0, tags: 0, stashes: 0 });
  });

  test("counts open PRs GitHub has beyond the loaded page, without the linked ones already listed", () => {
    const prs = unionPrs([row("me", { prs: [link(151)] })], "me", [summary(150)], new Map([[prKey(prRef(151)), summary(151)]]));
    expect(hiddenOpenPrs(prs, [summary(150)], 20)).toBe(18);
    expect(hiddenOpenPrs(prs, [summary(150)], null)).toBe(0);
    const paged = buildSidebarModel({ ...input, openCount: 20 });
    expect(paged.hiddenOpenPrs).toBe(19);
    expect(sectionCounts(paged).prs).toBe(21);
    expect(filterSidebarModel(paged, "acs").hiddenOpenPrs).toBe(0);
  });

  test("returns the same model for a blank filter", () => {
    expect(filterSidebarModel(model, "   ")).toBe(model);
  });
});
