import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@cw-code/contracts";

const gitService = vi.hoisted(() => ({
  defaultBinary: vi.fn((name: string) => name),
  fetchGhAuthStatus: vi.fn(),
  fetchGhToken: vi.fn(),
  selectGitHubAccount: vi.fn(),
  authenticatedEnvironment: vi.fn(),
  execText: vi.fn()
}));

vi.mock("../fs/GitService.js", () => gitService);

import { configureGitHubAccounts, GitHubAccounts } from "./GitHubAccounts.js";
import { resolveGitHubAccount } from "./githubAccount.js";

const settings = (() => ({}) as AppSettings);

describe("resolveGitHubAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitService.fetchGhAuthStatus.mockResolvedValue([{ host: "github.com", login: "octocat", authenticated: true }]);
    gitService.selectGitHubAccount.mockReturnValue({ account: { host: "github.com", login: "octocat" }, source: "single", error: null });
    gitService.fetchGhToken.mockResolvedValue("token");
  });

  it("shares one gh spawn between concurrent calls", async () => {
    configureGitHubAccounts(() => "gh-concurrent");
    const results = await Promise.all([resolveGitHubAccount(settings), resolveGitHubAccount(settings), resolveGitHubAccount(settings)]);
    expect(gitService.fetchGhAuthStatus).toHaveBeenCalledTimes(1);
    expect(gitService.fetchGhToken).toHaveBeenCalledTimes(1);
    expect(results.every((result) => "account" in result && result.token === "token")).toBe(true);
  });

  it("does not cache a failure and retries on the next call", async () => {
    configureGitHubAccounts(() => "gh-failing");
    gitService.fetchGhAuthStatus.mockRejectedValueOnce(new Error("spawn gh ENOENT"));
    expect(await resolveGitHubAccount(settings)).toEqual({ error: "GitHub CLI not found" });
    expect(await resolveGitHubAccount(settings)).toMatchObject({ token: "token" });
    expect(gitService.fetchGhAuthStatus).toHaveBeenCalledTimes(2);
  });

  it("selects the account for the requested host and owner", async () => {
    configureGitHubAccounts(() => "gh-host");
    await resolveGitHubAccount(settings, "ghe.example.com", "acme");
    expect(gitService.selectGitHubAccount).toHaveBeenCalledWith(expect.any(Array), "ghe.example.com", "acme", undefined);
    expect(gitService.fetchGhToken).toHaveBeenCalledWith("gh-host", expect.any(String), "ghe.example.com", "octocat");
  });
});

describe("GitHubAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitService.fetchGhToken.mockResolvedValue("token");
    gitService.execText.mockResolvedValue("{}");
    gitService.fetchGhAuthStatus.mockResolvedValue([
      { host: "github.com", login: "one", active: true, authenticated: true, hasRepositoryAccess: null },
      { host: "GHE.example.com", login: "two", active: true, authenticated: true, hasRepositoryAccess: null },
      { host: "github.com", login: "stale", active: false, authenticated: false, hasRepositoryAccess: null }
    ]);
  });

  it("filters accounts by host, ignoring case", async () => {
    const accounts = new GitHubAccounts(() => "gh-filter");
    expect((await accounts.accounts("ghe.example.com")).map((account) => account.login)).toEqual(["two"]);
    expect((await accounts.accounts("github.com")).map((account) => account.login)).toEqual(["one", "stale"]);
    expect(gitService.fetchGhAuthStatus).toHaveBeenCalledTimes(1);
  });

  it("marks repository access per account and skips unauthenticated ones", async () => {
    gitService.fetchGhAuthStatus.mockResolvedValue([
      { host: "github.com", login: "one", active: true, authenticated: true, hasRepositoryAccess: null },
      { host: "github.com", login: "two", active: false, authenticated: true, hasRepositoryAccess: null },
      { host: "github.com", login: "stale", active: false, authenticated: false, hasRepositoryAccess: null }
    ]);
    gitService.fetchGhToken.mockImplementation(async (_binary: string, _cwd: string, _host: string, login: string) => `token-${login}`);
    gitService.authenticatedEnvironment.mockImplementation((_host: string, token: string) => ({ TOKEN: token }));
    gitService.execText.mockImplementation(async (_binary: string, _args: string[], _cwd: string, _timeout: number, env: { TOKEN: string }) => {
      if (env.TOKEN === "token-two") throw new Error("repository not found");
      return "{}";
    });
    const accounts = new GitHubAccounts(() => "gh-access");
    const result = await accounts.withAccess("github.com", "acme/widgets");
    expect(result.map((account) => [account.login, account.hasRepositoryAccess])).toEqual([["one", true], ["two", false], ["stale", false]]);
    expect(gitService.execText).toHaveBeenCalledTimes(2);
    await accounts.withAccess("github.com", "acme/widgets");
    expect(gitService.execText).toHaveBeenCalledTimes(2);
  });

  it("caches the token and exposes it synchronously once warm", async () => {
    const accounts = new GitHubAccounts(() => "gh-token");
    expect(accounts.cachedToken("github.com", "one")).toBeNull();
    expect(await accounts.token("github.com", "one")).toBe("token");
    expect(await accounts.token("GitHub.com", "one")).toBe("token");
    expect(accounts.cachedToken("github.com", "one")).toBe("token");
    expect(gitService.fetchGhToken).toHaveBeenCalledTimes(1);
  });

  it("throws on an empty token and does not cache it", async () => {
    const accounts = new GitHubAccounts(() => "gh-empty-token");
    gitService.fetchGhToken.mockResolvedValueOnce("");
    await expect(accounts.token("github.com", "one")).rejects.toThrow("No token available for one");
    expect(accounts.cachedToken("github.com", "one")).toBeNull();
    expect(await accounts.token("github.com", "one")).toBe("token");
  });

  it("returns the failure as a selection error when gh is unavailable", async () => {
    gitService.fetchGhAuthStatus.mockRejectedValueOnce(new Error("gh exploded"));
    const accounts = new GitHubAccounts(() => "gh-broken");
    expect(await accounts.select("github.com", "acme")).toEqual({ account: null, source: "none", error: "gh exploded", accounts: [] });
  });
});
