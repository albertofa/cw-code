import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { AppSettings, HistoryAvatarAuthor, HistoryAvatars } from "@cw-code/contracts";
import { authenticatedEnvironment, execText } from "../fs/GitService.js";
import { GH_HOST, githubCliBinary, withGitHubAccount } from "../github/githubAccount.js";
import { OWNER_RE, REPO_RE } from "../github/githubRefs.js";
import { isFullSha } from "./historyParsers.js";

export interface AvatarRemote {
  host: string;
  owner: string;
  repository: string;
}

export type AvatarLookup = (owner: string, repo: string, sha: string) => Promise<string | null>;

export class AvatarNotFoundError extends Error {}
export class AvatarAuthError extends Error {}
export class AvatarUnavailableError extends Error {}

export interface HistoryAvatarsOptions {
  cacheFile: string;
  remote: (root: string) => Promise<AvatarRemote | null>;
  lookup: AvatarLookup;
  now?: () => number;
}

type Outcome = { done: true; url: string | null } | { done: false };

interface CacheEntry {
  url: string | null;
  checkedAt: number;
}

const PENDING: Outcome = { done: false };
const AVATAR_HOST = "avatars.githubusercontent.com";
const AVATAR_SIZE = "64";
const BOM = String.fromCharCode(0xfeff);
const NOREPLY_ID = /^(\d+)\+([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i;
const NOREPLY_LOGIN = /^([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i;
const RATE_LIMIT = /rate limit|HTTP 429/i;
const AUTH = /HTTP 40[13]\b|gh auth login|not logged in|bad credentials/i;
const NOT_FOUND = /HTTP (?:404|422)\b/;
const UNAVAILABLE = /GitHub CLI not found|No authenticated|ENOENT|not recognized as an internal or external command|command not found/i;
const GH_TIMEOUT_MS = 10_000;
const GH_PARALLEL = 3;
const UNAVAILABLE_PAUSE_MS = 10 * 60_000;
const AUTH_PAUSE_MS = 5 * 60_000;
const MAX_SHAS_PER_AUTHOR = 3;
const MAX_AUTHORS = 100;
const MAX_EMAIL_LENGTH = 320;
const UNSAFE_EMAIL = /[\s\x00-\x1f\x7f]/;
const NULL_TTL_MS = 7 * 24 * 60 * 60_000;
const SAVE_DEBOUNCE_MS = 1000;

export function githubAvatarFromEmail(email: string): string | null {
  const text = email.trim();
  const withId = NOREPLY_ID.exec(text);
  if (withId) return `https://${AVATAR_HOST}/u/${withId[1]}?s=${AVATAR_SIZE}`;
  const loginOnly = NOREPLY_LOGIN.exec(text);
  if (loginOnly) return `https://${AVATAR_HOST}/${loginOnly[1]}?s=${AVATAR_SIZE}`;
  return null;
}

export function normalizeAvatarUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== AVATAR_HOST) return null;
  parsed.searchParams.set("s", AVATAR_SIZE);
  return parsed.toString();
}

export function classifyAvatarFailure(message: string): Error {
  if (RATE_LIMIT.test(message) || AUTH.test(message)) return new AvatarAuthError(message);
  if (NOT_FOUND.test(message)) return new AvatarNotFoundError(message);
  if (UNAVAILABLE.test(message)) return new AvatarUnavailableError(message);
  return new Error(message);
}

export function parseAvatarAuthors(raw: unknown): HistoryAvatarAuthor[] {
  if (!Array.isArray(raw)) throw new Error("authors must be an array");
  if (raw.length > MAX_AUTHORS) throw new Error(`at most ${MAX_AUTHORS} authors per request`);
  return raw.map((value) => {
    const { email, shas } = (value ?? {}) as Partial<HistoryAvatarAuthor>;
    if (typeof email !== "string" || email.length === 0 || email.length > MAX_EMAIL_LENGTH || UNSAFE_EMAIL.test(email)) {
      throw new Error("invalid author email");
    }
    if (!Array.isArray(shas) || shas.length === 0 || shas.length > MAX_SHAS_PER_AUTHOR || !shas.every(isFullSha)) {
      throw new Error(`provide 1 to ${MAX_SHAS_PER_AUTHOR} full 40-character shas per author`);
    }
    return { email, shas: [...shas] };
  });
}

export function ghAvatarLookup(settings: () => AppSettings): AvatarLookup {
  return async (owner, repo, sha) => {
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || !isFullSha(sha)) return null;
    try {
      const stdout = await withGitHubAccount(settings, GH_HOST, owner, ({ account, token }) =>
        execText(
          githubCliBinary(settings),
          ["api", `repos/${owner}/${repo}/commits/${sha}`, "--jq", ".author.avatar_url"],
          homedir(),
          GH_TIMEOUT_MS,
          authenticatedEnvironment(account.host, token)
        )
      );
      const value = stdout.trim();
      return value === "" || value === "null" ? null : value;
    } catch (error) {
      throw classifyAvatarFailure((error as Error).message ?? "");
    }
  };
}

function isCachedUrl(value: unknown): value is string {
  return typeof value === "string" && normalizeAvatarUrl(value) !== null;
}

async function loadCache(file: string): Promise<Map<string, CacheEntry>> {
  const entries = new Map<string, CacheEntry>();
  try {
    const text = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return entries;
    for (const [email, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== "object") continue;
      const { url, checkedAt } = value as Record<string, unknown>;
      if (typeof checkedAt !== "number") continue;
      if (url === null) entries.set(email, { url: null, checkedAt });
      else if (isCachedUrl(url)) entries.set(email, { url, checkedAt });
    }
  } catch {
    return entries;
  }
  return entries;
}

function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    while (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export class HistoryAvatarService {
  private readonly now: () => number;
  private readonly limit = createLimiter(GH_PARALLEL);
  private readonly inflight = new Map<string, Promise<Outcome>>();
  private cachePromise: Promise<Map<string, CacheEntry>> | null = null;
  private pausedUntil = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly options: HistoryAvatarsOptions) {
    this.now = options.now ?? Date.now;
  }

  async resolve(root: string, authors: HistoryAvatarAuthor[]): Promise<HistoryAvatars> {
    const merged = new Map<string, string[]>();
    for (const author of authors) {
      const email = author.email.toLowerCase();
      const known = merged.get(email) ?? [];
      for (const sha of author.shas) if (!known.includes(sha)) known.push(sha);
      merged.set(email, known);
    }
    const avatars: Record<string, string | null> = {};
    const pending: string[] = [];
    let remote: Promise<AvatarRemote | null> | null = null;
    const remoteOnce = () => (remote ??= this.options.remote(root));
    await Promise.all(
      [...merged].map(async ([email, shas]) => {
        const outcome = await this.lookup(email, shas, remoteOnce);
        if (outcome.done) avatars[email] = outcome.url;
        else pending.push(email);
      })
    );
    return { avatars, pending: pending.sort() };
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saving = this.saving.then(() => this.writeCache());
    }
    await this.saving;
  }

  private cache(): Promise<Map<string, CacheEntry>> {
    return (this.cachePromise ??= loadCache(this.options.cacheFile));
  }

  private async writeCache(): Promise<void> {
    const entries = await this.cache();
    const file = this.options.cacheFile;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temporary, JSON.stringify(Object.fromEntries(entries)), "utf8");
      await rename(temporary, file);
    } catch {
      return;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saving = this.saving.then(() => this.writeCache());
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private async remember(email: string, url: string | null): Promise<void> {
    (await this.cache()).set(email, { url, checkedAt: this.now() });
    this.scheduleSave();
  }

  private async lookup(email: string, shas: string[], remoteOf: () => Promise<AvatarRemote | null>): Promise<Outcome> {
    const hit = (await this.cache()).get(email);
    if (hit !== undefined && (hit.url !== null || this.now() - hit.checkedAt < NULL_TTL_MS)) return { done: true, url: hit.url };
    const noreply = githubAvatarFromEmail(email);
    if (noreply !== null) return { done: true, url: noreply };
    const valid = shas.filter(isFullSha).slice(0, MAX_SHAS_PER_AUTHOR);
    if (valid.length === 0) return { done: true, url: null };
    let remote: AvatarRemote | null;
    try {
      remote = await remoteOf();
    } catch {
      return PENDING;
    }
    if (remote === null || remote.host.toLowerCase() !== GH_HOST) return { done: true, url: null };
    const key = `${remote.owner}/${remote.repository}|${email}`.toLowerCase();
    let shared = this.inflight.get(key);
    if (shared === undefined) {
      shared = this.queryGithub(email, remote, valid).finally(() => this.inflight.delete(key));
      this.inflight.set(key, shared);
    }
    return shared;
  }

  private async queryGithub(email: string, remote: AvatarRemote, shas: string[]): Promise<Outcome> {
    for (const sha of shas) {
      if (this.now() < this.pausedUntil) return PENDING;
      try {
        const raw = await this.limit(() => this.options.lookup(remote.owner, remote.repository, sha));
        const url = raw === null ? null : normalizeAvatarUrl(raw);
        await this.remember(email, url);
        return { done: true, url };
      } catch (error) {
        if (error instanceof AvatarNotFoundError) continue;
        if (error instanceof AvatarAuthError) this.pausedUntil = this.now() + AUTH_PAUSE_MS;
        else if (error instanceof AvatarUnavailableError) this.pausedUntil = this.now() + UNAVAILABLE_PAUSE_MS;
        return PENDING;
      }
    }
    return PENDING;
  }
}
