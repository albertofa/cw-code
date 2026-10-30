import type { DriverKind } from "@cw-code/contracts";

const REGISTRY_URL = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 4000;
const HIT_TTL_MS = 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;
const VERSION_RE = /^\d+\.\d+\.\d+/;

export interface LatestVersionDeps {
  fetch: typeof fetch;
  now(): number;
}

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

interface InFlight {
  promise: Promise<string | null>;
}

export function packageFor(binary: DriverKind, currentVersion: string | null): string {
  if (binary === "claude") return "@anthropic-ai/claude-code";
  if (binary === "codex") return "@openai/codex";
  const major = Number(currentVersion?.match(/(\d+)\.\d+\.\d+/)?.[1] ?? 0);
  return major >= 2 ? "@opencode/cli" : "opencode-ai";
}

export class LatestVersionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlight>();

  constructor(private readonly deps: LatestVersionDeps) {}

  get(pkg: string, opts: { fresh: boolean }): Promise<string | null> {
    if (!opts.fresh) {
      const entry = this.entries.get(pkg);
      if (entry && entry.expiresAt > this.deps.now()) return Promise.resolve(entry.value);
      const pending = this.inFlight.get(pkg);
      if (pending) return pending.promise;
    }
    return this.request(pkg);
  }

  clear(pkg?: string): void {
    if (pkg === undefined) {
      this.entries.clear();
      this.inFlight.clear();
      return;
    }
    this.entries.delete(pkg);
    this.inFlight.delete(pkg);
  }

  private request(pkg: string): Promise<string | null> {
    const token: InFlight = { promise: Promise.resolve(null) };
    token.promise = this.fetchLatest(pkg).then((value) => {
      if (this.inFlight.get(pkg) === token) {
        this.inFlight.delete(pkg);
        this.entries.set(pkg, { value, expiresAt: this.deps.now() + (value === null ? MISS_TTL_MS : HIT_TTL_MS) });
      }
      return value;
    });
    this.inFlight.set(pkg, token);
    return token.promise;
  }

  private async fetchLatest(pkg: string): Promise<string | null> {
    try {
      const response = await this.deps.fetch(`${REGISTRY_URL}/${encodeURIComponent(pkg)}/latest`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("version" in body)) return null;
      const { version } = body;
      return typeof version === "string" && VERSION_RE.test(version) ? version : null;
    } catch {
      return null;
    }
  }
}
