import type { AppSettings, RunRef, WorkflowRunSummary } from "@cw-code/contracts";
import { parseGhIncludeOutput } from "./httpResponse.js";
import { assertRunRef } from "./githubRefs.js";
import { mapRestRun, newCiActivity } from "./runParsers.js";
import { createGhExec, type GhExec } from "./RunsService.js";

export const MAX_WATCHED_RUNS = 30;
const RUN_POLL_INTERVAL_MS = 15_000;
const MIN_NOTIFICATIONS_INTERVAL_SECONDS = 60;
const RUN_POLL_CONCURRENCY = 4;

function runKey(ref: RunRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}/runs/${ref.runId}`.toLowerCase();
}

function runPath(ref: RunRef): string {
  return `repos/${ref.owner}/${ref.repo}/actions/runs/${ref.runId}`;
}

export class RunWatcher {
  onRunsChanged: (runs: WorkflowRunSummary[]) => void = () => undefined;
  onCiActivity: () => void = () => undefined;

  private watched = new Map<string, RunRef>();
  private etags = new Map<string, string>();
  private active = true;
  private disposed = false;
  private runsTimer: ReturnType<typeof setTimeout> | null = null;
  private runsBusy = false;
  private notificationsTimer: ReturnType<typeof setTimeout> | null = null;
  private notificationsBusy = false;
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
    this.active = active;
    this.reconcile();
  }

  dispose(): void {
    this.disposed = true;
    this.watched.clear();
    this.etags.clear();
    this.reconcile();
  }

  private reconcile(): void {
    const polling = !this.disposed && (this.active || this.watched.size > 0);
    if (polling && this.watched.size > 0) this.scheduleRuns();
    else this.clearRunsTimer();
    if (polling) this.scheduleNotifications();
    else this.clearNotificationsTimer();
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
    this.runsTimer = setTimeout(() => void this.runsTick(), RUN_POLL_INTERVAL_MS);
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
    const refs = [...this.watched.values()];
    const changed: WorkflowRunSummary[] = [];
    for (let offset = 0; offset < refs.length; offset += RUN_POLL_CONCURRENCY) {
      const batch = refs.slice(offset, offset + RUN_POLL_CONCURRENCY);
      const polled = await Promise.all(batch.map((ref) => this.pollRun(ref).catch(() => null)));
      for (const run of polled) {
        if (run) changed.push(run);
      }
    }
    for (const run of changed) {
      if (run.status !== "completed") continue;
      const key = runKey(run.ref);
      this.watched.delete(key);
      this.etags.delete(key);
    }
    if (changed.length > 0 && !this.disposed) this.onRunsChanged(changed);
  }

  private async pollRun(ref: RunRef): Promise<WorkflowRunSummary | null> {
    const key = runKey(ref);
    const etag = this.etags.get(key);
    const headers = etag ? ["-H", `If-None-Match: ${etag}`] : [];
    const response = parseGhIncludeOutput((await this.exec(["api", "-i", ...headers, runPath(ref)])).stdout);
    if (!response || response.status !== 200) return null;
    const run = JSON.parse(response.body) as unknown;
    const jobs = await this.exec(["api", `${runPath(ref)}/jobs?per_page=100`]);
    if (jobs.code !== 0) return null;
    const summary = mapRestRun(run, JSON.parse(jobs.stdout) as unknown);
    if (!summary || !this.watched.has(key)) return null;
    const nextEtag = response.headers["etag"];
    if (nextEtag) this.etags.set(key, nextEtag);
    return summary;
  }

  private scheduleNotifications(): void {
    if (this.notificationsTimer || this.notificationsBusy) return;
    if (this.ciSince === null) this.ciSince = Date.now();
    this.notificationsTimer = setTimeout(() => void this.notificationsTick(), this.notificationsIntervalSeconds * 1000);
  }

  private async notificationsTick(): Promise<void> {
    this.notificationsTimer = null;
    this.notificationsBusy = true;
    try {
      await this.pollNotifications().catch(() => undefined);
    } finally {
      this.notificationsBusy = false;
      this.reconcile();
    }
  }

  private async pollNotifications(): Promise<void> {
    const headers = this.lastModified ? ["-H", `If-Modified-Since: ${this.lastModified}`] : [];
    const response = parseGhIncludeOutput((await this.exec(["api", "-i", ...headers, "notifications"])).stdout);
    if (!response) return;
    const pollSeconds = Number.parseInt(response.headers["x-poll-interval"] ?? "", 10);
    this.notificationsIntervalSeconds = Math.max(MIN_NOTIFICATIONS_INTERVAL_SECONDS, Number.isFinite(pollSeconds) ? pollSeconds : 0);
    if (response.status !== 200) return;
    this.lastModified = response.headers["last-modified"] ?? this.lastModified;
    const activity = newCiActivity(JSON.parse(response.body) as unknown, this.ciSince ?? 0);
    if (!activity.found) return;
    this.ciSince = activity.latest;
    if (!this.disposed) this.onCiActivity();
  }
}
