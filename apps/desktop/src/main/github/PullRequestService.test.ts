import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PrRef, PrSummary } from "@cw-code/contracts";
import type { GitService, ParsedGitHubRemote } from "../fs/GitService.js";
import { DEFAULT_SETTINGS } from "../settings/SettingsStore.js";
import { assertPrRef, assertRunId, cloneTargetPath, mergeInboxItems, PullRequestService } from "./PullRequestService.js";

function ref(overrides: Partial<PrRef> = {}): PrRef {
  return { host: "github.com", owner: "acme", repo: "widgets", number: 1, ...overrides };
}

function summary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 1 },
    url: "https://github.com/acme/widgets/pull/1",
    title: "Base PR",
    state: "OPEN",
    isDraft: false,
    author: { login: "octocat", isBot: false },
    viewerIsAuthor: false,
    reviewRequestedFromViewer: false,
    headRefName: "feature",
    headRefOid: "sha-1",
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "none",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    review: "none",
    mergeable: "UNKNOWN",
    labels: [],
    updatedAt: 0,
    ...overrides
  };
}

describe("mergeInboxItems", () => {
  it("keeps the first list's order and drops later duplicates by prKey", () => {
    const open = [summary({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 1 } })];
    const merged = [
      summary({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 1 }, title: "duplicate" }),
      summary({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 2 } })
    ];
    const result = mergeInboxItems([open, merged]);
    expect(result.map((item) => item.ref.number)).toEqual([1, 2]);
    expect(result[0].title).toBe("Base PR");
  });

  it("returns an empty list when every input list is empty", () => {
    expect(mergeInboxItems([[], []])).toEqual([]);
  });
});

describe("cloneTargetPath", () => {
  const home = resolve("/home/tester");

  it("expands ~ against the given home directory and appends owner/repo", () => {
    const target = cloneTargetPath("~/.cw-code/repos", { owner: "acme", repo: "widgets" }, { homeDir: home });
    expect(target).toBe(join(home, ".cw-code", "repos", "acme", "widgets"));
  });

  it("leaves an absolute clone root untouched", () => {
    const root = resolve("/repos");
    const target = cloneTargetPath(root, { owner: "acme", repo: "widgets" }, { homeDir: home });
    expect(target).toBe(join(root, "acme", "widgets"));
  });

  it("omits the owner folder when includeOwner is false", () => {
    const root = resolve("/repos");
    const target = cloneTargetPath(root, { owner: "acme", repo: "widgets" }, { includeOwner: false, homeDir: home });
    expect(target).toBe(join(root, "widgets"));
  });

  it("keeps the owner folder when includeOwner is true", () => {
    const root = resolve("/repos");
    const target = cloneTargetPath(root, { owner: "acme", repo: "widgets" }, { includeOwner: true, homeDir: home });
    expect(target).toBe(join(root, "acme", "widgets"));
  });

  it("rejects a relative clone root", () => {
    expect(() => cloneTargetPath("repos", { owner: "acme", repo: "widgets" }, { homeDir: "C:\\Users\\tester" })).toThrow();
  });

  it("rejects a clone root starting with a dash", () => {
    expect(() => cloneTargetPath("-rf", { owner: "acme", repo: "widgets" }, { homeDir: "C:\\Users\\tester" })).toThrow();
  });

  it("rejects a repo segment that would escape the clone root", () => {
    expect(() => cloneTargetPath("C:\\repos", { owner: "acme", repo: ".." }, { homeDir: "C:\\Users\\tester" })).toThrow();
  });

  it("rejects an owner segment that would escape the clone root when included", () => {
    expect(() => cloneTargetPath("C:\\repos", { owner: "..", repo: "widgets" }, { homeDir: "C:\\Users\\tester" })).toThrow();
  });
});

describe("assertPrRef", () => {
  it("accepts a valid ref", () => {
    expect(() => assertPrRef(ref())).not.toThrow();
  });

  it("rejects a number smuggled in as a string starting with @", () => {
    expect(() => assertPrRef(ref({ number: "@file" as unknown as number }))).toThrow();
  });

  it("rejects a negative number", () => {
    expect(() => assertPrRef(ref({ number: -1 }))).toThrow();
  });

  it("rejects a float number", () => {
    expect(() => assertPrRef(ref({ number: 1.5 }))).toThrow();
  });

  it("rejects a repo of '..'", () => {
    expect(() => assertPrRef(ref({ repo: ".." }))).toThrow();
  });

  it("rejects an owner containing a slash", () => {
    expect(() => assertPrRef(ref({ owner: "acme/evil" }))).toThrow();
  });

  it("rejects a host other than github.com", () => {
    expect(() => assertPrRef(ref({ host: "github.example.com" }))).toThrow();
  });
});

function remoteFor(owner: string, repo: string): ParsedGitHubRemote {
  return {
    host: "github.com",
    owner,
    repository: repo,
    slug: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}.git`
  };
}

function fakeGit(overrides: Partial<Pick<GitService, "repositoryRoot" | "githubRemote">> = {}): GitService {
  return {
    repositoryRoot: async () => {
      throw new Error("not a repository");
    },
    githubRemote: async () => null,
    ...overrides
  } as unknown as GitService;
}

describe("PullRequestService.clone target identity", () => {
  function prRef(owner: string): PrRef {
    return { host: "github.com", owner, repo: "widgets", number: 1 };
  }

  function existingTarget(): { root: string; target: string } {
    const root = mkdtempSync(join(tmpdir(), "cw-clone-test-"));
    const target = join(root, "widgets");
    mkdirSync(target, { recursive: true });
    return { root, target };
  }

  function serviceAt(root: string, git: GitService): PullRequestService {
    return new PullRequestService(
      git,
      () => ({ ...DEFAULT_SETTINGS, prCloneRoot: root, prCloneIncludeOwner: false }),
      (rootPath) => ({ id: "cloned", rootPath, name: "widgets" })
    );
  }

  it("reuses a target checkout only when its remote matches the PR repository", async () => {
    const { root, target } = existingTarget();
    const service = serviceAt(
      root,
      fakeGit({ repositoryRoot: async () => target, githubRemote: async () => remoteFor("acme", "widgets") })
    );
    await expect(service.clone(prRef("acme"))).resolves.toMatchObject({ rootPath: target });
  });

  it("refuses a target checkout that belongs to another repository", async () => {
    const { root, target } = existingTarget();
    const service = serviceAt(
      root,
      fakeGit({ repositoryRoot: async () => target, githubRemote: async () => remoteFor("alice", "widgets") })
    );
    await expect(service.clone(prRef("bob"))).rejects.toThrow(/belongs to alice\/widgets, not bob\/widgets/);
  });

  it("refuses a target checkout whose remote cannot be identified", async () => {
    const { root, target } = existingTarget();
    const service = serviceAt(root, fakeGit({ repositoryRoot: async () => target, githubRemote: async () => null }));
    await expect(service.clone(prRef("acme"))).rejects.toThrow(/unrecognized GitHub remote/);
  });

  it("does not share an in-flight clone between repositories that map to the same target", async () => {
    const { root, target } = existingTarget();
    let release = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const service = serviceAt(
      root,
      fakeGit({
        repositoryRoot: async () => {
          await gate;
          return target;
        },
        githubRemote: async () => remoteFor("alice", "widgets")
      })
    );
    const first = service.clone(prRef("alice"));
    const second = service.clone(prRef("bob"));
    release();
    await expect(first).resolves.toMatchObject({ rootPath: target });
    await expect(second).rejects.toThrow(/belongs to alice\/widgets, not bob\/widgets/);
  });
});

describe("assertRunId", () => {
  it("accepts a positive safe integer", () => {
    expect(() => assertRunId(123)).not.toThrow();
  });

  it("rejects a flag-shaped string", () => {
    expect(() => assertRunId("--web" as unknown as number)).toThrow();
  });

  it("rejects zero and negative values", () => {
    expect(() => assertRunId(0)).toThrow();
    expect(() => assertRunId(-5)).toThrow();
  });
});
