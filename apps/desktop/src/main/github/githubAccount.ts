import type { AppSettings, GitHubAccountInfo } from "@cw-code/contracts";
import { defaultBinary } from "../fs/GitService.js";
import { defaultGitHubAccounts } from "./GitHubAccounts.js";

export const GH_HOST = "github.com";

export type AccountResolution = { account: GitHubAccountInfo; token: string } | { error: string };

function isMissingBinaryError(message: string): boolean {
  return /ENOENT|not recognized as an internal or external command|command not found|no such file or directory/i.test(message);
}

export function githubCliBinary(settings: () => AppSettings): string {
  return settings().githubCliBinaryPath?.trim() || defaultBinary("gh");
}

export async function resolveGitHubAccount(_settings: () => AppSettings, host = GH_HOST, owner = ""): Promise<AccountResolution> {
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
