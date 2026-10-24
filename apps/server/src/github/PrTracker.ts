import { homedir } from "node:os";
import type { AppSettings, PrLinkSnapshot, PrRef, PrSummary } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { authenticatedEnvironment, execWithStatus } from "../fs/GitService.js";
import { RefreshScheduler } from "../sourceControl/RefreshScheduler.js";
import { defaultGitHubAccounts, isGitHubAuthError } from "./GitHubAccounts.js";
import { githubCliBinary, resolveGitHubAccount } from "./githubAccount.js";
import { assertPrRef } from "./PullRequestService.js";
import { graphqlOutcome, parseTrackedPrs } from "./prParsers.js";
import { buildTrackedPrQuery } from "./prQueries.js";
import {
  PR_IDLE_INTERVAL_MS,
  PR_TRACKER_BATCH,
  PR_TRACKER_TICK_MS,
  isPrDue,
  isValidSnapshot,
  snapshotOf,
  summaryChanged
} from "./prTracking.js";

const REQUEST_TIMEOUT_MS = 20_000;
const HOST_BACKOFF_TICKS = 2;
const SCHEDULER_CONCURRENCY = 2;
const LOG_PREFIX = "[pr-tracker]";

interface TrackedState {
  ref: PrRef;
  snapshot?: PrLinkSnapshot;
  summary?: PrSummary;
  forced: boolean;
  backoffUntil?: number;
}

function hostOf(ref: PrRef): string {
  return ref.host.toLowerCase();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PrTracker {
  private readonly tracked = new Map<string, TrackedState>();
  private readonly hostBackoffUntil = new Map<string, number>();
  private readonly scheduler: RefreshScheduler;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly settings: () => AppSettings,
    private readonly onChanged: (changed: PrSummary[]) => void
  ) {
    this.scheduler = new RefreshScheduler((host) => this.refreshHost(host), {
      concurrency: SCHEDULER_CONCURRENCY,
      warn: (message) => console.warn(`${LOG_PREFIX} ${message}`)
    });
  }

  setTracked(entries: Array<{ ref: PrRef; snapshot?: PrLinkSnapshot }>): void {
    const next = new Map<string, TrackedState>();
    for (const { ref, snapshot } of entries) {
      if (!this.accepts(ref)) continue;
      const key = prKey(ref);
      const incoming = isValidSnapshot(snapshot) ? snapshot : undefined;
      const existing = next.get(key) ?? this.tracked.get(key);
      if (!existing) {
        next.set(key, { ref, forced: false, ...(incoming ? { snapshot: incoming } : {}) });
        continue;
      }
      if (incoming && (!existing.snapshot || incoming.syncedAt > existing.snapshot.syncedAt)) existing.snapshot = incoming;
      next.set(key, existing);
    }
    this.tracked.clear();
    for (const [key, state] of next) this.tracked.set(key, state);
  }

  async refresh(refs: PrRef[]): Promise<void> {
    const hosts = new Set<string>();
    for (const ref of refs) {
      if (!this.accepts(ref)) continue;
      const key = prKey(ref);
      const state = this.tracked.get(key) ?? { ref, forced: true };
      state.forced = true;
      this.tracked.set(key, state);
      hosts.add(hostOf(ref));
    }
    for (const host of hosts) this.hostBackoffUntil.delete(host);
    await this.requestHosts(hosts);
  }

  summary(ref: PrRef): PrSummary | null {
    return this.tracked.get(prKey(ref))?.summary ?? null;
  }

  snapshot(ref: PrRef): PrLinkSnapshot | null {
    return this.tracked.get(prKey(ref))?.snapshot ?? null;
  }

  summaries(): PrSummary[] {
    const items: PrSummary[] = [];
    for (const { summary } of this.tracked.values()) if (summary) items.push(summary);
    return items;
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), PR_TRACKER_TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    await this.requestHosts(new Set([...this.tracked.values()].map(({ ref }) => hostOf(ref))));
  }

  private requestHosts(hosts: Set<string>): Promise<unknown> {
    return Promise.all([...hosts].map((host) => this.scheduler.request(host, { forcePullRequest: false })));
  }

  private accepts(ref: PrRef): boolean {
    try {
      assertPrRef(ref);
      return true;
    } catch (error) {
      console.warn(`${LOG_PREFIX} skipping invalid pull request reference: ${describeError(error)}`);
      return false;
    }
  }

  private dueStates(host: string, now: number): TrackedState[] {
    const hostBlocked = (this.hostBackoffUntil.get(host) ?? 0) > now;
    const due: TrackedState[] = [];
    for (const state of this.tracked.values()) {
      if (hostOf(state.ref) !== host) continue;
      if (hostBlocked) continue;
      if (state.forced || ((state.backoffUntil ?? 0) <= now && isPrDue(state, now))) due.push(state);
    }
    return due;
  }

  private async refreshHost(host: string): Promise<void> {
    const due = this.dueStates(host, Date.now());
    if (due.length === 0) return;
    const resolution = await resolveGitHubAccount(this.settings, host);
    if ("error" in resolution) {
      this.backOff(host, `no GitHub account for ${host}: ${resolution.error}`);
      return;
    }
    const env = authenticatedEnvironment(resolution.account.host, resolution.token);
    const binary = githubCliBinary(this.settings);
    const changed: PrSummary[] = [];
    for (let start = 0; start < due.length; start += PR_TRACKER_BATCH) {
      const batch = due.slice(start, start + PR_TRACKER_BATCH);
      const wasForced = batch.map((state) => state.forced);
      for (const state of batch) state.forced = false;
      try {
        const summaries = await this.fetchBatch(binary, env, batch, resolution.account.login);
        changed.push(...this.applyBatch(batch, summaries));
      } catch (error) {
        batch.forEach((state, index) => {
          if (wasForced[index]) state.forced = true;
        });
        const message = describeError(error);
        if (isGitHubAuthError(message)) {
          defaultGitHubAccounts.invalidateToken(resolution.account.host, resolution.account.login);
          console.warn(`${LOG_PREFIX} GitHub rejected the token for ${resolution.account.login}@${host}; retrying with a fresh token next tick`);
        } else {
          this.backOff(host, `query failed for ${host}: ${message}`);
        }
        break;
      }
    }
    if (changed.length > 0) this.emitChanged(changed);
  }

  private async fetchBatch(binary: string, env: NodeJS.ProcessEnv, batch: TrackedState[], viewer: string): Promise<Map<string, PrSummary>> {
    const refs = batch.map((state) => state.ref);
    const result = await execWithStatus(binary, ["api", "graphql", "-f", `query=${buildTrackedPrQuery(refs)}`], homedir(), REQUEST_TIMEOUT_MS, env);
    const outcome = graphqlOutcome(result.stdout);
    if (!outcome.hasData) throw new Error(outcome.message ?? (result.stderr.trim() || `gh exited with code ${result.code}`));
    if (outcome.message) console.warn(`${LOG_PREFIX} partial GraphQL result: ${outcome.message}`);
    return parseTrackedPrs(result.stdout, refs, viewer);
  }

  private applyBatch(batch: TrackedState[], summaries: Map<string, PrSummary>): PrSummary[] {
    const now = Date.now();
    const changed: PrSummary[] = [];
    for (const state of batch) {
      const key = prKey(state.ref);
      if (this.tracked.get(key) !== state) continue;
      const summary = summaries.get(key);
      if (!summary) {
        console.warn(`${LOG_PREFIX} ${key} was not returned by GitHub`);
        state.backoffUntil = now + PR_IDLE_INTERVAL_MS;
        continue;
      }
      const previous = state.summary;
      state.summary = summary;
      state.snapshot = snapshotOf(summary, now);
      state.backoffUntil = undefined;
      if (summaryChanged(previous, summary)) changed.push(summary);
    }
    return changed;
  }

  private backOff(host: string, reason: string): void {
    console.warn(`${LOG_PREFIX} ${reason}`);
    this.hostBackoffUntil.set(host, Date.now() + HOST_BACKOFF_TICKS * PR_TRACKER_TICK_MS);
  }

  private emitChanged(changed: PrSummary[]): void {
    if (this.stopped) return;
    try {
      this.onChanged(changed);
    } catch (error) {
      console.warn(`${LOG_PREFIX} change listener failed: ${describeError(error)}`);
    }
  }
}
