import type { AppSettings, RunRef, WorkflowRunSummary } from "@cw-code/contracts";
import { parseGhIncludeOutput } from "./httpResponse.js";
import { assertRunRef } from "./githubRefs.js";
import { mapRestRun, newCiActivity } from "./runParsers.js";
import { createGhExec, type GhExec } from "./RunsService.js";

export const MAX_WATCHED_RUNS = 30;
const RUN_POLL_INTERVAL_MS = 15_000;
const MIN_NOTIFICATIONS_INTERVAL_SECONDS = 60;
const MIN_RATE_LIMIT_DELAY_MS = 60_000;
const RUN_POLL_CONCURRENCY = 4;

function runKey(ref: RunRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}/runs/${ref.runId}`.toLowerCase();
}

function runPath(ref: RunRef): string {
  return `repos/${ref.owner}/${ref.repo}/actions/runs/${ref.runId}`;
}

function isRateLimited(status: number): boolean {
  return status === 403 || status === 429;
}

export function rateLimitDelayMs(headers: Record<string, string>, now: number): number {
  const retryAfter = Number.parseInt(headers["retry-after"] ?? "", 10);
  const reset = Number.parseInt(headers["x-ratelimit-reset"] ?? "", 10);
  const advertised = Number.isFinite(retryAfter) ? retryAfter * 1000 : Number.isFinite(reset) ? reset * 1000 - now : 0;
  return Math.max(MIN_RATE_LIMIT_DELAY_MS, advertised);
}

type RunPoll = { kind: "unchanged" } | { kind: "gone" } | { kind: "changed"; run: WorkflowRunSummary; etag: string | null };

export class RunWatcher {
  onRunsChanged: (runs: WorkflowRunSummary[]) => void = () => undefined;
  onCiActivity: () => void = () => undefined;

  private watched = new Map<string, RunRef>();
  private etags = new Map<string, string>();
  private active = true;
  private disposed = false;
  private epoch = 0;
  private warned = new Set<string>();
  private runsTimer: ReturnType<typeof setTimeout> | null = null;
  private runsBusy = false;
  private runsBlockedUntil = 0;
  private notificationsTimer: ReturnType<typeof setTimeout> | null = null;
  private notificationsBusy = false;
  private notificationsBlockedUntil = 0;
  private notificationsIntervalSeconds = MIN_NOTIFICATIONS_INTERVAL_SECONDS;
  private lastModified: string | null = null;
  private ciSince: number | null = null;
  private exec: GhExec;

  constructor(settings: () => AppSettings, exec?: GhExec) {
    this.exec = exec ?? createGhExec(settings);
  }

  watch(refs: RunRef[]): void {
    const next = new Map<string, RunRef>();
    for (const ref of Array.isArray(refs) ? refs : []) {
      assertRunRef(ref);
      if (next.size >= MAX_WATCHED_RUNS) break;
      next.set(runKey(ref), { host: ref.host, owner: ref.owner, repo: ref.repo, runId: ref.runId });
    }
    for (const key of this.etags.keys()) {
      if (!next.has(key)) this.etags.delete(key);
    }
    this.watched = next;
    this.reconcile();
  }

  setActive(active: boolean): void {
    if (!active && this.active) this.epoch += 1;
    this.active = active;
    this.reconcile();
  }

  dispose(): void {
    this.epoch += 1;
    this.disposed = true;
    this.watched.clear();
    this.etags.clear();
    this.warned.clear();
    this.reconcile();
  }

  private reconcile(): void {
    const polling = !this.disposed && this.active;
    if (polling && this.watched.size > 0) this.scheduleRuns();
    else this.clearRunsTimer();
    if (polling) this.scheduleNotifications();
    else this.clearNotificationsTimer();
  }

  private warnOnce(scope: string, status: string): void {
    const key = `${scope}|${status}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[github] ${scope} polling failed: ${status}`);
  }

  private clearRunsTimer(): void {
    if (this.runsTimer) clearTimeout(this.runsTimer);
    this.runsTimer = null;
  }

  private clearNotificationsTimer(): void {
    if (this.notificationsTimer) clearTimeout(this.notificationsTimer);
    this.notificationsTimer = null;
    this.ciSince = null;
    this.lastModified = null;
  }

  private scheduleRuns(): void {
    if (this.runsTimer || this.runsBusy) return;
    const delay = Math.max(RUN_POLL_INTERVAL_MS, this.runsBlockedUntil - Date.now());
    this.runsTimer = setTimeout(() => void this.runsTick(), delay);
  }

  private async runsTick(): Promise<void> {
    this.runsTimer = null;
    this.runsBusy = true;
    try {
      await this.pollRuns();
    } finally {
      this.runsBusy = false;
      this.reconcile();
    }
  }

  private async pollRuns(): Promise<void> {
    const epoch = this.epoch;
    const refs = [...this.watched.values()];
    const changed: WorkflowRunSummary[] = [];
    for (let offset = 0; offset < refs.length; offset += RUN_POLL_CONCURRENCY) {
      const batch = refs.slice(offset, offset + RUN_POLL_CONCURRENCY);
      const polled = await Promise.all(
        batch.map((ref) =>
          this.pollRun(ref).catch((error: Error): RunPoll => {
            this.warnOnce(runKey(ref), `error ${error.message}`);
            return { kind: "unchanged" };
          })
        )
      );
      if (epoch !== this.epoch) return;
      batch.forEach((ref, index) => {
        const key = runKey(ref);
        const outcome = polled[index];
        if (!this.watched.has(key)) return;
        if (outcome.kind === "gone") {
          this.watched.delete(key);
          this.etags.delete(key);
        } else if (outcome.kind === "changed") {
          if (outcome.etag) this.etags.set(key, outcome.etag);
          if (outcome.run.status === "completed") {
            this.watched.delete(key);
            this.etags.delete(key);
          }
          changed.push(outcome.run);
        }
      });
    }
    if (changed.length > 0) this.onRunsChanged(changed);
  }

  private async pollRun(ref: RunRef): Promise<RunPoll> {
    const key = runKey(ref);
    const etag = this.etags.get(key);
    const headers = etag ? ["-H", `If-None-Match: ${etag}`] : [];
    const response = parseGhIncludeOutput((await this.exec(["api", "-i", ...headers, runPath(ref)])).stdout);
    if (!response) {
      this.warnOnce(key, "unparseable response");
      return { kind: "unchanged" };
    }
    if (response.status === 304) return { kind: "unchanged" };
    if (response.status === 404 || response.status === 410) {
      this.warnOnce(key, String(response.status));
      return { kind: "gone" };
    }
    if (isRateLimited(response.status)) {
      this.warnOnce(key, String(response.status));
      this.runsBlockedUntil = Date.now() + rateLimitDelayMs(response.headers, Date.now());
      return { kind: "unchanged" };
    }
    if (response.status !== 200) {
      this.warnOnce(key, String(response.status));
      return { kind: "unchanged" };
    }
    const jobs = await this.exec(["api", `${runPath(ref)}/jobs?per_page=100`]);
    if (jobs.code !== 0) {
      this.warnOnce(key, `jobs exit ${jobs.code}`);
      return { kind: "unchanged" };
    }
    const summary = mapRestRun(JSON.parse(response.body) as unknown, JSON.parse(jobs.stdout) as unknown);
    if (!summary) {
      this.warnOnce(key, "unexpected run payload");
      return { kind: "unchanged" };
    }
    return { kind: "changed", run: { ...summary, ref }, etag: response.headers["etag"] ?? null };
  }

  private scheduleNotifications(): void {
    if (this.notificationsTimer || this.notificationsBusy) return;
    if (this.ciSince === null) this.ciSince = Date.now();
    const delay = Math.max(this.notificationsIntervalSeconds * 1000, this.notificationsBlockedUntil - Date.now());
    this.notificationsTimer = setTimeout(() => void this.notificationsTick(), delay);
  }

  private async notificationsTick(): Promise<void> {
    this.notificationsTimer = null;
    this.notificationsBusy = true;
    try {
      await this.pollNotifications().catch((error: Error) => this.warnOnce("notifications", `error ${error.message}`));
    } finally {
      this.notificationsBusy = false;
      this.reconcile();
    }
  }

  private async pollNotifications(): Promise<void> {
    const epoch = this.epoch;
    const headers = this.lastModified ? ["-H", `If-Modified-Since: ${this.lastModified}`] : [];
    const response = parseGhIncludeOutput((await this.exec(["api", "-i", ...headers, "notifications"])).stdout);
    if (epoch !== this.epoch) return;
    if (!response) {
      this.warnOnce("notifications", "unparseable response");
      return;
    }
    if (isRateLimited(response.status)) {
      this.warnOnce("notifications", String(response.status));
      this.notificationsBlockedUntil = Date.now() + rateLimitDelayMs(response.headers, Date.now());
      return;
    }
    const pollSeconds = Number.parseInt(response.headers["x-poll-interval"] ?? "", 10);
    this.notificationsIntervalSeconds = Math.max(MIN_NOTIFICATIONS_INTERVAL_SECONDS, Number.isFinite(pollSeconds) ? pollSeconds : 0);
    if (response.status !== 200) {
      if (response.status !== 304) this.warnOnce("notifications", String(response.status));
      return;
    }
    this.lastModified = response.headers["last-modified"] ?? this.lastModified;
    const activity = newCiActivity(JSON.parse(response.body) as unknown, this.ciSince ?? Date.now());
    if (!activity.found) return;
    this.ciSince = activity.latest;
    this.onCiActivity();
  }
}
