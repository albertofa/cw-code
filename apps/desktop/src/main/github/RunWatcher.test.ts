import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, RunRef, WorkflowRunSummary } from "@cw-code/contracts";
import { RunWatcher, rateLimitDelayMs } from "./RunWatcher.js";
import type { GhExec } from "./RunsService.js";

const REF_A: RunRef = { host: "github.com", owner: "acme", repo: "widgets", runId: 1 };
const REF_B: RunRef = { host: "github.com", owner: "acme", repo: "widgets", runId: 2 };
const NO_JOBS = { code: 0, stdout: JSON.stringify({ jobs: [] }), stderr: "" };

function restRun(id: number, status: string, conclusion: string | null = null) {
  return {
    id,
    run_number: id,
    name: "CI",
    display_title: "Run",
    event: "push",
    status,
    conclusion,
    head_branch: "main",
    head_sha: "abc",
    html_url: `https://github.com/acme/widgets/actions/runs/${id}`,
    actor: { login: "octocat" },
    created_at: "2024-03-01T10:00:00Z",
    updated_at: "2024-03-01T10:01:00Z",
    pull_requests: []
  };
}

function ok(headers: string[], body: unknown) {
  return { code: 0, stdout: `HTTP/2.0 200 OK\r\n${headers.join("\r\n")}\r\n\r\n${JSON.stringify(body)}`, stderr: "" };
}

function failure(statusLine: string, headers: string[] = []) {
  return { code: 1, stdout: `${[statusLine, ...headers].join("\r\n")}\r\n\r\n{}`, stderr: "" };
}

function notModified() {
  return { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\netag: W/"x"\r\n\r\n', stderr: "" };
}

function isJobsCall(args: string[]): boolean {
  return (args.at(-1) ?? "").includes("/jobs");
}

const settings = (() => ({})) as unknown as () => AppSettings;

describe("RunWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-01T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(handler: (args: string[]) => ReturnType<GhExec>) {
    const exec = vi.fn<GhExec>(handler);
    const watcher = new RunWatcher(settings, exec);
    const changed: WorkflowRunSummary[][] = [];
    watcher.onRunsChanged = (runs) => changed.push(runs);
    return { exec, watcher, changed };
  }

  it("emits on a 200 with jobs and sends the stored ETag on the next poll", async () => {
    const jobs = {
      jobs: [{ name: "build", status: "in_progress", conclusion: null, started_at: "2024-03-01T10:00:05Z", completed_at: null, html_url: "https://example.test/job" }]
    };
    const { exec, watcher, changed } = setup(async (args) => {
      if (isJobsCall(args)) return { code: 0, stdout: JSON.stringify(jobs), stderr: "" };
      return ok(['etag: W/"v1"'], restRun(1, "in_progress"));
    });
    watcher.watch([REF_A]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(changed).toHaveLength(1);
    expect(changed[0][0]).toMatchObject({ ref: REF_A, status: "in_progress" });
    expect(changed[0][0].jobs).toHaveLength(1);
    expect(exec).toHaveBeenCalledWith(["api", "-i", "repos/acme/widgets/actions/runs/1"]);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(exec).toHaveBeenCalledWith(["api", "-i", "-H", 'If-None-Match: W/"v1"', "repos/acme/widgets/actions/runs/1"]);
    watcher.dispose();
  });

  it("keeps state and emits nothing on a 304", async () => {
    let call = 0;
    const { exec, watcher, changed } = setup(async (args) => {
      if (isJobsCall(args)) return NO_JOBS;
      call += 1;
      return call === 1 ? ok(['etag: "e1"'], restRun(1, "in_progress")) : notModified();
    });
    watcher.watch([REF_A]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(changed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changed).toHaveLength(1);
    const runCalls = exec.mock.calls.filter(([args]) => !isJobsCall(args) && args.includes("repos/acme/widgets/actions/runs/1"));
    expect(runCalls).toHaveLength(3);
    expect(runCalls[2][0]).toContain('If-None-Match: "e1"');
    watcher.dispose();
  });

  it("stops watching a run once it completes", async () => {
    const { exec, watcher, changed } = setup(async (args) => {
      if (isJobsCall(args)) return NO_JOBS;
      return ok([], restRun(1, "completed", "success"));
    });
    watcher.watch([REF_A]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(changed[0][0]).toMatchObject({ status: "completed", conclusion: "success" });
    const before = exec.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    const later = exec.mock.calls.slice(before).filter(([args]) => args.includes("repos/acme/widgets/actions/runs/1"));
    expect(later).toHaveLength(0);
    watcher.dispose();
  });

  it("replaces the watched set and polls only the new refs", async () => {
    const { exec, watcher } = setup(async (args) => (isJobsCall(args) ? NO_JOBS : notModified()));
    watcher.watch([REF_A]);
    watcher.watch([REF_B]);
    await vi.advanceTimersByTimeAsync(15_000);
    const paths = exec.mock.calls.map(([args]) => args.at(-1)).filter((path) => path?.startsWith("repos/"));
    expect(paths).toEqual(["repos/acme/widgets/actions/runs/2"]);
    watcher.dispose();
  });

  it("rejects invalid refs", () => {
    const { watcher } = setup(async () => notModified());
    expect(() => watcher.watch([{ ...REF_A, owner: "a/b" }])).toThrow();
    expect(() => watcher.watch([{ ...REF_A, runId: 0 }])).toThrow();
    watcher.dispose();
  });

  it("pauses every timer while hidden, even with runs watched, and resumes when visible", async () => {
    const { exec, watcher } = setup(async (args) => (isJobsCall(args) ? NO_JOBS : notModified()));
    watcher.setActive(false);
    watcher.watch([REF_A]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(exec).not.toHaveBeenCalled();

    watcher.setActive(true);
    expect(vi.getTimerCount()).toBe(2);
    watcher.setActive(false);
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it("stops the runs timer when an empty set is watched while visible", () => {
    const { watcher } = setup(async () => notModified());
    watcher.watch([REF_A]);
    expect(vi.getTimerCount()).toBe(2);
    watcher.watch([]);
    expect(vi.getTimerCount()).toBe(1);
    watcher.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards a notifications result that completes after a pause", async () => {
    let release: (value: Awaited<ReturnType<GhExec>>) => void = () => undefined;
    const { watcher } = setup(() => new Promise((resolve) => (release = resolve)));
    const onCiActivity = vi.fn();
    watcher.onCiActivity = onCiActivity;
    watcher.watch([]);
    await vi.advanceTimersByTimeAsync(60_000);
    watcher.setActive(false);
    release(ok([], [{ reason: "ci_activity", updated_at: "2024-03-01T11:00:00Z" }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(onCiActivity).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("emits the polled ref and unwatches a run that returns 404, warning once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const upperRef: RunRef = { host: "github.com", owner: "Acme", repo: "Widgets", runId: 1 };
    const { exec, watcher, changed } = setup(async (args) => {
      if (isJobsCall(args)) return NO_JOBS;
      if (args.at(-1)?.includes("/runs/2")) return failure("HTTP/2.0 404 Not Found");
      return ok([], restRun(1, "in_progress"));
    });
    watcher.watch([upperRef, REF_B]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(changed[0][0].ref).toEqual(upperRef);
    await vi.advanceTimersByTimeAsync(30_000);
    const missing = exec.mock.calls.filter(([args]) => args.at(-1)?.endsWith("/runs/2"));
    expect(missing).toHaveLength(1);
    expect(warn.mock.calls.filter(([message]) => String(message).includes("404"))).toHaveLength(1);
    expect(String(warn.mock.calls[0][0])).toContain("[github]");
    warn.mockRestore();
    watcher.dispose();
  });

  it("delays the next poll until the advertised retry-after and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { exec, watcher } = setup(async () => failure("HTTP/2.0 429 Too Many Requests", ["retry-after: 120"]));
    const runCalls = () => exec.mock.calls.filter(([args]) => args.at(-1)?.endsWith("/runs/1")).length;
    watcher.watch([REF_A]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(runCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runCalls()).toBe(2);
    expect(warn.mock.calls.filter(([message]) => String(message).includes("runs/1") && String(message).includes("429"))).toHaveLength(1);
    warn.mockRestore();
    watcher.dispose();
  });

  it("keeps polling notifications while visible with nothing watched, and stops on dispose", async () => {
    const { exec, watcher } = setup(async () => notModified());
    watcher.watch([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exec).toHaveBeenCalledWith(["api", "-i", "notifications"]);
    watcher.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("emits onCiActivity only for ci_activity newer than the baseline and honors X-Poll-Interval and Last-Modified", async () => {
    const bodies = [
      [
        { reason: "ci_activity", updated_at: "2024-03-01T09:59:00Z" },
        { reason: "mention", updated_at: "2024-03-01T10:00:30Z" }
      ],
      [{ reason: "ci_activity", updated_at: "2024-03-01T10:02:00Z" }]
    ];
    let call = 0;
    const { exec, watcher } = setup(async () => {
      const body = bodies[call];
      call += 1;
      return body ? ok(["last-modified: Fri, 01 Mar 2024 10:01:00 GMT", "x-poll-interval: 90"], body) : notModified();
    });
    const onCiActivity = vi.fn();
    watcher.onCiActivity = onCiActivity;
    watcher.watch([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(onCiActivity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(89_000);
    expect(exec).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exec).toHaveBeenLastCalledWith(["api", "-i", "-H", "If-Modified-Since: Fri, 01 Mar 2024 10:01:00 GMT", "notifications"]);
    expect(onCiActivity).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it("never polls faster than 60 seconds when GitHub advertises a shorter interval", async () => {
    const { exec, watcher } = setup(async () => ok(["x-poll-interval: 10"], []));
    watcher.watch([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(exec).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exec).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it("survives exec failures and keeps polling", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let call = 0;
    const { watcher, changed } = setup(async (args) => {
      call += 1;
      if (call === 1) throw new Error("spawn failed");
      if (isJobsCall(args)) return NO_JOBS;
      return ok([], restRun(1, "in_progress"));
    });
    watcher.watch([REF_A]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(changed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(changed).toHaveLength(1);
    watcher.dispose();
  });
});

describe("rateLimitDelayMs", () => {
  const now = Date.parse("2024-03-01T10:00:00Z");

  it("uses retry-after seconds and never goes below 60 seconds", () => {
    expect(rateLimitDelayMs({ "retry-after": "120" }, now)).toBe(120_000);
    expect(rateLimitDelayMs({ "retry-after": "5" }, now)).toBe(60_000);
  });

  it("falls back to x-ratelimit-reset epoch seconds", () => {
    expect(rateLimitDelayMs({ "x-ratelimit-reset": String(now / 1000 + 300) }, now)).toBe(300_000);
    expect(rateLimitDelayMs({ "x-ratelimit-reset": String(now / 1000 - 10) }, now)).toBe(60_000);
  });

  it("defaults to 60 seconds without headers", () => {
    expect(rateLimitDelayMs({}, now)).toBe(60_000);
  });
});
