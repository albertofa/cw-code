import { homedir } from "node:os";
import type { GitHubAccountInfo, GitHubAccountSelectionSource } from "@cw-code/contracts";
import { authenticatedEnvironment, defaultBinary, execText, fetchGhAuthStatus, fetchGhToken, selectGitHubAccount } from "../fs/GitService.js";

const ACCOUNTS_CACHE_TTL_MS = 5 * 60_000;
const REPO_VIEW_TIMEOUT_MS = 8_000;

export interface GitHubAccountSelection {
  account: GitHubAccountInfo | null;
  source: GitHubAccountSelectionSource;
  error: string | null;
  accounts: GitHubAccountInfo[];
}

class TtlCache<V> {
  private entries = new Map<string, { expiresAt: number; value: V }>();
  private pending = new Map<string, Promise<V>>();

  constructor(private ttlMs: number) {}

  peek(key: string): V | null {
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > Date.now() ? entry.value : null;
  }

  load(key: string, loader: () => Promise<V>): Promise<V> {
    const cached = this.peek(key);
    if (cached !== null) return Promise.resolve(cached);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const promise = loader()
      .then((value) => {
        this.entries.set(key, { expiresAt: Date.now() + this.ttlMs, value });
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
}

export class GitHubAccounts {
  private authStatus = new TtlCache<GitHubAccountInfo[]>(ACCOUNTS_CACHE_TTL_MS);
  private repositoryAccess = new TtlCache<boolean>(ACCOUNTS_CACHE_TTL_MS);
  private tokens = new TtlCache<string>(ACCOUNTS_CACHE_TTL_MS);

  constructor(private binary: () => string) {}

  async accounts(host: string): Promise<GitHubAccountInfo[]> {
    const binary = this.binary();
    const all = await this.authStatus.load(binary, () => fetchGhAuthStatus(binary, homedir()));
    const wanted = host.toLowerCase();
    return all.filter((account) => account.host.toLowerCase() === wanted).map((account) => ({ ...account }));
  }

  async withAccess(host: string, slug: string): Promise<GitHubAccountInfo[]> {
    const accounts = await this.accounts(host);
    return Promise.all(accounts.map(async (account) => ({
      ...account,
      hasRepositoryAccess: account.authenticated ? await this.canAccess(host, slug, account.login) : false
    })));
  }

  async select(
    host: string,
    owner: string,
    configured?: { host: string; login: string },
    slug?: string
  ): Promise<GitHubAccountSelection> {
    let accounts: GitHubAccountInfo[];
    try {
      accounts = slug ? await this.withAccess(host, slug) : await this.accounts(host);
    } catch (error) {
      return { account: null, source: "none", error: (error as Error).message || "GitHub CLI unavailable", accounts: [] };
    }
    return { ...selectGitHubAccount(accounts, host, owner, configured), accounts };
  }

  token(host: string, login: string): Promise<string> {
    const binary = this.binary();
    return this.tokens.load(this.tokenKey(binary, host, login), async () => {
      const value = await fetchGhToken(binary, homedir(), host, login);
      if (!value) throw new Error(`No token available for ${login}`);
      return value;
    });
  }

  cachedToken(host: string, login: string): string | null {
    return this.tokens.peek(this.tokenKey(this.binary(), host, login));
  }

  private tokenKey(binary: string, host: string, login: string): string {
    return `${binary}|${host.toLowerCase()}|${login.toLowerCase()}`;
  }

  private canAccess(host: string, slug: string, login: string): Promise<boolean> {
    const binary = this.binary();
    const key = `${this.tokenKey(binary, host, login)}|${slug.toLowerCase()}`;
    return this.repositoryAccess.load(key, async () => {
      try {
        const token = await this.token(host, login);
        await execText(binary, ["repo", "view", `${host}/${slug}`, "--json", "nameWithOwner"], homedir(), REPO_VIEW_TIMEOUT_MS, authenticatedEnvironment(host, token));
        return true;
      } catch {
        return false;
      }
    });
  }
}

let binarySource: () => string = () => defaultBinary("gh");

export const defaultGitHubAccounts = new GitHubAccounts(() => binarySource());

export function configureGitHubAccounts(binary: () => string): void {
  binarySource = binary;
}
