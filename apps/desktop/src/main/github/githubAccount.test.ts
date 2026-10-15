import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@cw-code/contracts";

const gitService = vi.hoisted(() => ({
  defaultBinary: vi.fn((name: string) => name),
  fetchGhAuthStatus: vi.fn(),
  fetchGhToken: vi.fn(),
  selectGitHubAccount: vi.fn()
}));

vi.mock("../fs/GitService.js", () => gitService);

import { resolveGitHubAccount } from "./githubAccount.js";

function settings(binary: string): () => AppSettings {
  return () => ({ githubCliBinaryPath: binary }) as AppSettings;
}

describe("resolveGitHubAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitService.fetchGhAuthStatus.mockResolvedValue([{ host: "github.com", login: "octocat" }]);
    gitService.selectGitHubAccount.mockReturnValue({ account: { host: "github.com", login: "octocat" } });
    gitService.fetchGhToken.mockResolvedValue("token");
  });

  it("shares one gh spawn between concurrent calls", async () => {
    const getSettings = settings("gh-concurrent");
    const results = await Promise.all([resolveGitHubAccount(getSettings), resolveGitHubAccount(getSettings), resolveGitHubAccount(getSettings)]);
    expect(gitService.fetchGhAuthStatus).toHaveBeenCalledTimes(1);
    expect(gitService.fetchGhToken).toHaveBeenCalledTimes(1);
    expect(results.every((result) => "account" in result && result.token === "token")).toBe(true);
  });

  it("does not cache a failure and retries on the next call", async () => {
    const getSettings = settings("gh-failing");
    gitService.fetchGhAuthStatus.mockRejectedValueOnce(new Error("spawn gh ENOENT"));
    expect(await resolveGitHubAccount(getSettings)).toEqual({ error: "GitHub CLI not found" });
    expect(await resolveGitHubAccount(getSettings)).toMatchObject({ token: "token" });
    expect(gitService.fetchGhAuthStatus).toHaveBeenCalledTimes(2);
  });
});
