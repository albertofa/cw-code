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

const AUTH_FAILURE_RE = /HTTP 401|Bad credentials|authentication|gh auth login/i;

export function isGitHubAuthError(message: string): boolean {
  return AUTH_FAILURE_RE.test(message);
}

class TtlCache<V> {
  private entries = new Map<string, { expiresAt: number; value: V }>();
  private pending = new Map<string, Promise<V>>();
  private generation = 0;

  constructor(private ttlMs: number, private shouldCache: (value: V) => boolean = () => true) {}

  peek(key: string): V | null {
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > Date.now() ? entry.value : null;
  }

  load(key: string, loader: () => Promise<V>): Promise<V> {
    const cached = this.peek(key);
    if (cached !== null) return Promise.resolve(cached);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const generation = this.generation;
    const promise = loader()
      .then((value) => {
        if (generation === this.generation && this.shouldCache(value)) this.entries.set(key, { expiresAt: Date.now() + this.ttlMs, value });
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }

  delete(key: string): void {
    this.entries.delete(key);
    this.pending.delete(key);
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.pending.clear();
  }
}

export class GitHubAccounts {
  private authStatus = new TtlCache<GitHubAccountInfo[]>(ACCOUNTS_CACHE_TTL_MS, (accounts) => accounts.length > 0);
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
    host = host.toLowerCase();
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
    const hostname = host.toLowerCase();
    return this.tokens.load(this.tokenKey(binary, hostname, login), async () => {
      const value = await fetchGhToken(binary, homedir(), hostname, login);
      if (!value) throw new Error(`No token available for ${login}`);
      return value;
    });
  }

  async withToken<T>(host: string, login: string, run: (token: string) => Promise<T>): Promise<T> {
    const first = await this.token(host, login);
    try {
      return await run(first);
    } catch (error) {
      if (!isGitHubAuthError((error as Error).message ?? "")) throw error;
      this.invalidateToken(host, login);
      return run(await this.token(host, login));
    }
  }

  invalidateToken(host: string, login: string): void {
    this.tokens.delete(this.tokenKey(this.binary(), host, login));
  }

  invalidate(): void {
    this.authStatus.clear();
    this.repositoryAccess.clear();
    this.tokens.clear();
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
        await this.withToken(host, login, (token) =>
          execText(binary, ["repo", "view", `${host}/${slug}`, "--json", "nameWithOwner"], homedir(), REPO_VIEW_TIMEOUT_MS, authenticatedEnvironment(host, token))
        );
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
