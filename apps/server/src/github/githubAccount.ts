import type { AppSettings, GitHubAccountInfo } from "@cw-code/contracts";
import { defaultBinary } from "../fs/GitService.js";
import { defaultGitHubAccounts, isGitHubAuthError } from "./GitHubAccounts.js";

export const GH_HOST = "github.com";

export type AccountResolution = { account: GitHubAccountInfo; token: string } | { error: string };

function isMissingBinaryError(message: string): boolean {
  return /ENOENT|not recognized as an internal or external command|command not found|no such file or directory/i.test(message);
}

export function githubCliBinary(settings: () => AppSettings): string {
  return settings().githubCliBinaryPath?.trim() || defaultBinary("gh");
}

export async function resolveGitHubAccount(_settings: () => AppSettings, rawHost = GH_HOST, owner = ""): Promise<AccountResolution> {
  const host = rawHost.toLowerCase();
  const selection = await defaultGitHubAccounts.select(host, owner);
  if (!selection.account) {
    const message = selection.error ?? `No authenticated ${host} account in gh`;
    return { error: isMissingBinaryError(message) ? "GitHub CLI not found" : message };
  }
  try {
    const token = await defaultGitHubAccounts.token(host, selection.account.login);
    return { account: selection.account, token };
  } catch (error) {
    return { error: (error as Error).message || "GitHub CLI unavailable" };
  }
}

export async function withGitHubAccount<T>(
  settings: () => AppSettings,
  host: string,
  owner: string,
  run: (resolved: { account: GitHubAccountInfo; token: string }) => Promise<T>
): Promise<T> {
  const resolve = async (): Promise<{ account: GitHubAccountInfo; token: string }> => {
    const resolution = await resolveGitHubAccount(settings, host, owner);
    if ("error" in resolution) throw new Error(resolution.error);
    return resolution;
  };
  const first = await resolve();
  try {
    return await run(first);
  } catch (error) {
    if (!isGitHubAuthError((error as Error).message ?? "")) throw error;
    defaultGitHubAccounts.invalidateToken(first.account.host, first.account.login);
    return run(await resolve());
  }
}
