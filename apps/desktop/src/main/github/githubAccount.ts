import { homedir } from "node:os";
import type { AppSettings, GitHubAccountInfo } from "@cw-code/contracts";
import { defaultBinary, fetchGhAuthStatus, fetchGhToken, selectGitHubAccount } from "../fs/GitService.js";

export const GH_HOST = "github.com";
const ACCOUNT_CACHE_TTL_MS = 60_000;

export type AccountResolution = { account: GitHubAccountInfo; token: string } | { error: string };

const accountCache = new Map<string, { expiresAt: number; value: { account: GitHubAccountInfo; token: string } }>();
const accountInFlight = new Map<string, Promise<AccountResolution>>();

function isMissingBinaryError(message: string): boolean {
  return /ENOENT|not recognized as an internal or external command|command not found|no such file or directory/i.test(message);
}

export function githubCliBinary(settings: () => AppSettings): string {
  return settings().githubCliBinaryPath?.trim() || defaultBinary("gh");
}

export function resolveGitHubAccount(settings: () => AppSettings): Promise<AccountResolution> {
  const binary = githubCliBinary(settings);
  const cacheKey = `${GH_HOST}|${binary}`;
  const cached = accountCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  const pending = accountInFlight.get(cacheKey);
  if (pending) return pending;
  const promise = computeAccount(binary, cacheKey).finally(() => {
    if (accountInFlight.get(cacheKey) === promise) accountInFlight.delete(cacheKey);
  });
  accountInFlight.set(cacheKey, promise);
  return promise;
}

async function computeAccount(binary: string, cacheKey: string): Promise<AccountResolution> {
  let accounts: GitHubAccountInfo[];
  try {
    accounts = await fetchGhAuthStatus(binary, homedir());
  } catch (error) {
    const message = (error as Error).message;
    return { error: isMissingBinaryError(message) ? "GitHub CLI not found" : message || "GitHub CLI unavailable" };
  }
  const selection = selectGitHubAccount(accounts, GH_HOST, "");
  if (!selection.account) return { error: selection.error ?? "No authenticated github.com account in gh" };
  try {
    const token = await fetchGhToken(binary, homedir(), GH_HOST, selection.account.login);
    if (!token) return { error: `No token available for ${selection.account.login}` };
    const resolution = { account: selection.account, token };
    accountCache.set(cacheKey, { expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS, value: resolution });
    return resolution;
  } catch (error) {
    return { error: (error as Error).message || "GitHub CLI unavailable" };
  }
}
