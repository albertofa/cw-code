import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { AccountUsageSnapshot, DriverKind, ThreadTopicData, TopicPatch, UsageTopicData } from "@cw-code/contracts";
import { sessionTopic, USAGE_TOPIC } from "@cw-code/shared/topics";
import { advanceTimersByTimeAsync } from "../../tests/testing.js";
import { ThreadService } from "../threads/ThreadService.js";
import { createThreadTopicProvider } from "../threads/threadTopic.js";
import { TopicHub } from "../topics/TopicHub.js";
import type { CallContext } from "../transport/Router.js";
import { ACCOUNT_REFRESH_MS, UsageTopic } from "./UsageTopic.js";
import { wireSessionUsageTotals, type SessionFamily } from "./wireSessionUsageTotals.js";
import type { UsageLedgerQuery, UsageLedgerRow } from "./ledgerTypes.js";

const ctx: CallContext = { clientId: "a", client: "web", auth: { kind: "owner" } };
const NOW = new Date(2026, 5, 15, 12).getTime();

function snapshot(driver: DriverKind): AccountUsageSnapshot {
  return { driver, fetchedAt: NOW, state: { status: "ok", windows: [], balances: [], notes: [] } };
}

function row(overrides: Partial<UsageLedgerRow> = {}): UsageLedgerRow {
  return {
    day: "2026-06-15",
    sessionId: "s1",
    projectId: "p1",
    driver: "claude",
    model: "sonnet",
    inputTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    outputTokens: 5,
    reasoningTokens: 0,
    turns: 1,
    costUsd: 0.5,
    unpricedTurns: 0,
    ...overrides
  };
}

function setup(rows: UsageLedgerRow[] = []) {
  const patches: TopicPatch[] = [];
  const hub = new TopicHub((_clientIds, frame) => patches.push(JSON.parse(frame) as TopicPatch));
  const fetched: Array<{ driver: DriverKind; force: boolean }> = [];
  const recorded: Array<(sessionId: string) => void> = [];
  const queries: UsageLedgerQuery[] = [];
  const topic = new UsageTopic(hub, {
    accountUsage: {
      get: async (drivers, force) => {
        for (const driver of drivers) fetched.push({ driver, force });
        return drivers.map(snapshot);
      }
    },
    ledgerRows: (query) => {
      queries.push(query);
      return rows.filter((entry) => (query.sessionId ? entry.sessionId === query.sessionId : true));
    },
    onUsageRecorded: (cb) => {
      recorded.push(cb);
      return () => undefined;
    },
    now: () => Date.now()
  });
  hub.register(topic);
  const recordTurn = (sessionId: string): void => recorded.forEach((cb) => cb(sessionId));
  return { hub, topic, patches, fetched, recordTurn, queries };
}

function data(hub: TopicHub): UsageTopicData {
  return hub.subscribe({ ...ctx, clientId: "probe" }, [USAGE_TOPIC])[USAGE_TOPIC]?.data as UsageTopicData;
}

describe("UsageTopic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    setSystemTime();
  });

  it("refreshes every driver once on open and publishes the snapshots", async () => {
    const { hub, fetched, patches } = setup();
    const initial = hub.subscribe(ctx, [USAGE_TOPIC])[USAGE_TOPIC]?.data as UsageTopicData;
    expect(initial.account.claude.loading).toBe(true);
    await advanceTimersByTimeAsync(0);
    expect(fetched.map((entry) => entry.driver).sort()).toEqual(["claude", "codex", "opencode"]);
    expect(fetched.every((entry) => !entry.force)).toBe(true);
    const latest = data(hub);
    expect(latest.account.claude).toEqual({ snapshot: snapshot("claude"), loading: false, error: null });
    expect(latest.accountFetchedAt).toBe(NOW);
    expect(patches.length).toBeGreaterThan(0);
  });

  it("refreshes every five minutes only while subscribed", async () => {
    const { hub, fetched } = setup();
    expect(fetched).toHaveLength(0);
    await advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS * 2);
    expect(fetched).toHaveLength(0);

    hub.subscribe(ctx, [USAGE_TOPIC]);
    await advanceTimersByTimeAsync(0);
    expect(fetched).toHaveLength(3);
    await advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS);
    expect(fetched).toHaveLength(6);

    hub.unsubscribe(ctx, [USAGE_TOPIC]);
    await advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS * 3);
    expect(fetched).toHaveLength(6);
  });

  it("a second subscriber does not restart the refresh loop", async () => {
    const { hub, fetched } = setup();
    hub.subscribe(ctx, [USAGE_TOPIC]);
    await advanceTimersByTimeAsync(0);
    hub.subscribe({ ...ctx, clientId: "b" }, [USAGE_TOPIC]);
    await advanceTimersByTimeAsync(0);
    expect(fetched).toHaveLength(3);
  });

  it("dispose stops the loop and resume restarts it while subscribed", async () => {
    const { hub, topic, fetched } = setup();
    hub.subscribe(ctx, [USAGE_TOPIC]);
    await advanceTimersByTimeAsync(0);
    topic.dispose();
    await advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS * 2);
    expect(fetched).toHaveLength(3);
    topic.resume();
    await advanceTimersByTimeAsync(0);
    expect(fetched).toHaveLength(6);
  });

  it("resume followed by a resync starts a single refresh loop", async () => {
    const { hub, topic, fetched } = setup();
    hub.subscribe(ctx, [USAGE_TOPIC]);
    await advanceTimersByTimeAsync(0);
    topic.dispose();
    topic.resume();
    hub.resync();
    await advanceTimersByTimeAsync(0);
    expect(fetched).toHaveLength(6);
    await advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS);
    expect(fetched).toHaveLength(9);
  });

  it("refreshAccount forces a fetch and keeps working while unsubscribed", async () => {
    const { topic, fetched } = setup();
    await topic.refreshAccount(true);
    expect(fetched).toHaveLength(3);
    expect(fetched.every((entry) => entry.force)).toBe(true);
  });

  it("refreshAccount can target a single driver", async () => {
    const { topic, fetched } = setup();
    await topic.refreshAccount(true, ["codex"]);
    expect(fetched).toEqual([{ driver: "codex", force: true }]);
  });

  it("a background refresh keeps loading false once a snapshot exists; a forced one sets it", async () => {
    const { hub, topic, patches } = setup();
    hub.subscribe(ctx, [USAGE_TOPIC]);
    await advanceTimersByTimeAsync(0);
    patches.length = 0;
    await advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS);
    const loadingValues = (): boolean[] =>
      patches.flatMap((patch) => patch.ops).flatMap((op) => (op.op === "upsert" && op.key === "account" ? [(op.value as UsageTopicData["account"]).claude.loading] : []));
    expect(loadingValues().every((loading) => !loading)).toBe(true);
    patches.length = 0;
    const pending = topic.refreshAccount(true, ["claude"]);
    expect(loadingValues()).toContain(true);
    await pending;
    expect(data(hub).account.claude.loading).toBe(false);
  });

  it("a disposed topic ignores new subscribers and resyncs until resumed", async () => {
    const { hub, topic, fetched } = setup();
    topic.dispose();
    hub.subscribe(ctx, [USAGE_TOPIC]);
    hub.resync();
    await advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS * 2);
    expect(fetched).toHaveLength(0);
    topic.resume();
    await advanceTimersByTimeAsync(0);
    expect(fetched).toHaveLength(3);
  });

  it("records a failing driver as an error without dropping its last snapshot", async () => {
    const hub = new TopicHub(() => undefined);
    let fail = false;
    const topic = new UsageTopic(hub, {
      accountUsage: {
        get: async (drivers) => {
          if (fail) throw new Error("boom");
          return drivers.map(snapshot);
        }
      },
      ledgerRows: () => [],
      onUsageRecorded: () => () => undefined
    });
    hub.register(topic);
    hub.subscribe(ctx, [USAGE_TOPIC]);
    await advanceTimersByTimeAsync(0);
    fail = true;
    await topic.refreshAccount(true);
    const entry = data(hub).account.codex;
    expect(entry).toEqual({ snapshot: snapshot("codex"), loading: false, error: "boom" });
  });

  it("a recorded turn bumps ledgerRev for subscribers", async () => {
    const { hub, topic, recordTurn, patches } = setup();
    hub.subscribe(ctx, [USAGE_TOPIC]);
    await advanceTimersByTimeAsync(0);
    patches.length = 0;
    recordTurn("s1");
    recordTurn("s2");
    expect(topic.ledgerRev).toBe(2);
    expect(data(hub).ledgerRev).toBe(2);
    expect(patches.flatMap((patch) => patch.ops)).toContainEqual({ op: "upsert", key: "ledgerRev", value: 2 });
  });

  it("counts turns recorded while nobody is subscribed", () => {
    const { hub, recordTurn } = setup();
    recordTurn("s1");
    expect(data(hub).ledgerRev).toBe(1);
  });

  it("report filters the ledger and stamps the current ledgerRev", () => {
    const rows = [row(), row({ driver: "codex", sessionId: "s2", model: "gpt" }), row({ day: "2026-01-01", sessionId: "s3" })];
    const { topic, recordTurn, queries } = setup(rows);
    recordTurn("s1");
    const report = topic.report({ days: 7, metric: "all", driver: "claude", projectId: "all" });
    expect(queries).toEqual([{ sinceDay: "2026-06-09" }]);
    expect(report.sinceDay).toBe("2026-06-09");
    expect(report.ledgerRev).toBe(1);
    expect(report.totals.sessions).toBe(1);
    expect(report.totals.totalTokens).toBe(35);
    expect(report.daily).toHaveLength(7);
  });

  it("sessionTotals sums a session and is null without usage", () => {
    const { topic } = setup([row(), row({ model: "opus", inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 })]);
    expect(topic.sessionTotals("s1")).toMatchObject({ turns: 2, inputTokens: 11, cacheReadTokens: 20, outputTokens: 6, sessions: 1 });
    expect(topic.sessionTotals("missing")).toBeNull();
  });

  it("sessionTotals folds in the rows of the given children", () => {
    const { topic } = setup([row(), row({ sessionId: "kid", outputTokens: 100, costUsd: 1 }), row({ sessionId: "other", outputTokens: 999 })]);
    expect(topic.sessionTotals("s1", ["kid"])).toMatchObject({ turns: 2, outputTokens: 105, costUsd: 1.5, sessions: 2 });
    expect(topic.sessionTotals("none", ["kid"])).toMatchObject({ turns: 1, outputTokens: 100, sessions: 1 });
  });
});

const NO_FAMILY: SessionFamily = { childIds: () => [], parentId: () => null };

describe("session usage totals extra", () => {
  it("fills the thread snapshot and updates for the recorded session", () => {
    const rows = [row()];
    const { hub, topic } = setup(rows);
    const threads = new ThreadService({
      hub,
      history: async () => [],
      liveTasks: () => [],
      pendingRequests: () => [],
      loadHistoryOnSubscribe: false
    });
    hub.register(createThreadTopicProvider(threads));
    const recorded: Array<(sessionId: string) => void> = [];
    wireSessionUsageTotals(threads, topic, (cb) => recorded.push(cb), NO_FAMILY);
    const totalsOf = (sessionId: string, clientId: string) =>
      (hub.subscribe({ ...ctx, clientId }, [sessionTopic(sessionId)])[sessionTopic(sessionId)]?.data as ThreadTopicData).usageTotals;

    expect(totalsOf("s1", "c1")?.turns).toBe(1);
    expect(totalsOf("s2", "c2")).toBeNull();

    rows.push(row({ model: "opus", outputTokens: 100 }));
    recorded.forEach((cb) => cb("s1"));

    expect(totalsOf("s1", "c3")?.turns).toBe(2);
    expect(totalsOf("s1", "c3")?.outputTokens).toBe(105);
    expect(totalsOf("s2", "c4")).toBeNull();
  });

  it("does not query the ledger again when extras refresh for other reasons", () => {
    const { hub, topic, queries } = setup([row()]);
    const threads = new ThreadService({
      hub,
      history: async () => [],
      liveTasks: () => [],
      pendingRequests: () => [],
      loadHistoryOnSubscribe: false
    });
    hub.register(createThreadTopicProvider(threads));
    wireSessionUsageTotals(threads, topic, () => undefined, NO_FAMILY);
    hub.subscribe(ctx, [sessionTopic("s1")]);
    threads.refreshExtras("s1");
    threads.refreshExtras("s1");
    expect(queries.filter((query) => query.sessionId === "s1")).toHaveLength(1);
  });

  it("publishes an error instead of empty totals when the ledger query fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { hub } = setup();
    const failing = { sessionTotals: () => { throw new Error("ledger locked"); } };
    const threads = new ThreadService({
      hub,
      history: async () => [],
      liveTasks: () => [],
      pendingRequests: () => [],
      loadHistoryOnSubscribe: false
    });
    hub.register(createThreadTopicProvider(threads));
    wireSessionUsageTotals(threads, failing, () => undefined, NO_FAMILY);
    const state = hub.subscribe(ctx, [sessionTopic("s1")])[sessionTopic("s1")]?.data as ThreadTopicData;
    expect(state.usageTotals).toBeNull();
    expect(state.usageTotalsError).toBe("ledger locked");
    warn.mockRestore();
  });

  it("sums the parent with its children and refreshes the parent when a child records usage", () => {
    const rows = [row(), row({ sessionId: "kid", outputTokens: 100 })];
    const { hub, topic, patches } = setup(rows);
    const threads = new ThreadService({
      hub,
      history: async () => [],
      liveTasks: () => [],
      pendingRequests: () => [],
      loadHistoryOnSubscribe: false
    });
    hub.register(createThreadTopicProvider(threads));
    const recorded: Array<(sessionId: string) => void> = [];
    wireSessionUsageTotals(threads, topic, (cb) => recorded.push(cb), {
      childIds: (sessionId) => (sessionId === "s1" ? ["kid"] : []),
      parentId: (sessionId) => (sessionId === "kid" ? "s1" : null)
    });
    const state = hub.subscribe(ctx, [sessionTopic("s1")])[sessionTopic("s1")]?.data as ThreadTopicData;
    expect(state.usageTotals).toMatchObject({ turns: 2, outputTokens: 105 });
    patches.length = 0;

    rows.push(row({ sessionId: "kid", model: "opus", outputTokens: 50 }));
    recorded.forEach((cb) => cb("kid"));
    const upsert = patches.flatMap((patch) => patch.ops).find((op) => op.op === "upsert" && op.key === "usageTotals");
    expect(upsert).toMatchObject({ value: { turns: 3, outputTokens: 155 } });
  });
});
