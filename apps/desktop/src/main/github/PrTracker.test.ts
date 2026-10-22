import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, PrRef, PrSummary } from "@cw-code/contracts";

const mocks = vi.hoisted(() => ({
  execWithStatus: vi.fn(),
  resolveGitHubAccount: vi.fn()
}));

vi.mock("../fs/GitService.js", () => ({
  authenticatedEnvironment: vi.fn(() => ({})),
  execWithStatus: mocks.execWithStatus
}));
vi.mock("./githubAccount.js", () => ({
  githubCliBinary: () => "gh",
  resolveGitHubAccount: mocks.resolveGitHubAccount
}));

import { PrTracker } from "./PrTracker.js";

const settings = () => ({}) as AppSettings;
const ref = (number: number): PrRef => ({ host: "github.com", owner: "acme", repo: "widgets", number });

function node(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state: "OPEN",
    headRefOid: "sha-1",
    mergeable: "MERGEABLE",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides
  };
}

function respond(data: Record<string, unknown>, extra: { code?: number; errors?: unknown[] } = {}) {
  return { code: extra.code ?? 0, stdout: JSON.stringify({ data, ...(extra.errors ? { errors: extra.errors } : {}) }), stderr: "" };
}

function queryOfCall(index: number): string {
  return mocks.execWithStatus.mock.calls[index][1].join(" ");
}

describe("PrTracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.resolveGitHubAccount.mockResolvedValue({ account: { host: "github.com", login: "octocat" }, token: "t" });
  });

  it("queries one batch per host and reports every first summary as changed", async () => {
    const onChanged = vi.fn();
    const tracker = new PrTracker(settings, onChanged);
    tracker.setTracked([{ ref: ref(1) }, { ref: ref(2) }]);
    mocks.execWithStatus.mockResolvedValue(respond({ pr0: { pullRequest: node(1) }, pr1: { pullRequest: node(2) } }));

    await tracker.tick();

    expect(mocks.execWithStatus).toHaveBeenCalledTimes(1);
    expect(mocks.resolveGitHubAccount).toHaveBeenCalledWith(settings, "github.com");
    expect(onChanged.mock.calls[0][0].map((item: PrSummary) => item.ref.number)).toEqual([1, 2]);
    expect(tracker.summary(ref(1))?.headRefOid).toBe("sha-1");
    expect(tracker.snapshot(ref(2))?.state).toBe("OPEN");
  });

  it("notifies only entries whose tracked fields changed", async () => {
    const onChanged = vi.fn();
    const tracker = new PrTracker(settings, onChanged);
    tracker.setTracked([{ ref: ref(1) }, { ref: ref(2) }]);
    mocks.execWithStatus.mockResolvedValueOnce(respond({ pr0: { pullRequest: node(1) }, pr1: { pullRequest: node(2) } }));
    await tracker.tick();
    onChanged.mockClear();

    mocks.execWithStatus.mockResolvedValueOnce(respond({ pr0: { pullRequest: node(1) }, pr1: { pullRequest: node(2, { headRefOid: "sha-2" }) } }));
    await tracker.refresh([ref(1), ref(2)]);

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0].map((item: PrSummary) => item.ref.number)).toEqual([2]);
  });

  it("uses partial data from a failed GraphQL exit and backs off the missing PR", async () => {
    const tracker = new PrTracker(settings, vi.fn());
    tracker.setTracked([{ ref: ref(1) }, { ref: ref(2) }]);
    mocks.execWithStatus.mockResolvedValue(respond({ pr0: { pullRequest: node(1, { updatedAt: new Date().toISOString() }) }, pr1: null }, { code: 1, errors: [{ message: "Could not resolve" }] }));

    await tracker.tick();
    expect(tracker.summaries().map((item) => item.ref.number)).toEqual([1]);

    mocks.execWithStatus.mockClear();
    await tracker.tick();
    expect(mocks.execWithStatus).toHaveBeenCalledTimes(1);
    expect(queryOfCall(0)).toContain("pullRequest(number: 1)");
    expect(queryOfCall(0)).not.toContain("pullRequest(number: 2)");
  });

  it("warns and backs the host off when the query fails, then recovers on an explicit refresh", async () => {
    const tracker = new PrTracker(settings, vi.fn());
    tracker.setTracked([{ ref: ref(1) }]);
    mocks.execWithStatus.mockResolvedValue({ code: 1, stdout: "", stderr: "HTTP 502" });

    await tracker.tick();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[pr-tracker] query failed for github.com: HTTP 502"));

    mocks.execWithStatus.mockClear();
    await tracker.tick();
    expect(mocks.execWithStatus).not.toHaveBeenCalled();

    mocks.execWithStatus.mockResolvedValue(respond({ pr0: { pullRequest: node(1) } }));
    await tracker.refresh([ref(1)]);
    expect(mocks.execWithStatus).toHaveBeenCalledTimes(1);
    expect(tracker.summary(ref(1))).not.toBeNull();
  });

  it("does not notify after stop", async () => {
    const onChanged = vi.fn();
    const tracker = new PrTracker(settings, onChanged);
    tracker.setTracked([{ ref: ref(1) }]);
    mocks.execWithStatus.mockResolvedValue(respond({ pr0: { pullRequest: node(1) } }));

    const pending = tracker.tick();
    tracker.stop();
    await pending;

    expect(onChanged).not.toHaveBeenCalled();
    expect(tracker.summary(ref(1))).not.toBeNull();
  });

  it("ignores a persisted snapshot synced in the future", () => {
    const tracker = new PrTracker(settings, vi.fn());
    tracker.setTracked([{ ref: ref(1), snapshot: { state: "MERGED", headRefOid: "x", updatedAt: 1, syncedAt: Date.now() + 3_600_000 } }]);
    expect(tracker.snapshot(ref(1))).toBeNull();
  });

  it("skips invalid refs, ignores malformed snapshots, and never refreshes a merged snapshot", async () => {
    const tracker = new PrTracker(settings, vi.fn());
    const merged = { state: "MERGED" as const, headRefOid: "x", updatedAt: 1, syncedAt: 1 };
    tracker.setTracked([
      { ref: { ...ref(1), owner: "bad owner" } },
      { ref: ref(2), snapshot: { ...merged, state: "WAT" as never } },
      { ref: ref(3), snapshot: merged }
    ]);
    expect(tracker.snapshot(ref(2))).toBeNull();
    expect(tracker.snapshot(ref(3))).toEqual(merged);
    mocks.execWithStatus.mockResolvedValue(respond({ pr0: { pullRequest: node(2) } }));

    await tracker.tick();

    expect(queryOfCall(0)).toContain("pullRequest(number: 2)");
    expect(queryOfCall(0)).not.toContain("pullRequest(number: 3)");
    expect(queryOfCall(0)).not.toContain("bad owner");
  });
});
