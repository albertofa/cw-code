import { describe, expect, it } from "bun:test";
import { byModel, dailyByDriver, sinceDayFor, topSessions, totals, turnTokens, usageReport } from "./usageReport.js";
import type { UsageLedgerRow } from "./ledgerTypes.js";

function row(overrides: Partial<UsageLedgerRow> = {}): UsageLedgerRow {
  return {
    day: "2026-09-24",
    sessionId: "sess_1",
    projectId: "proj_1",
    driver: "claude",
    model: "claude-sonnet-5",
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    turns: 1,
    costUsd: null,
    unpricedTurns: 0,
    ...overrides
  };
}

describe("dailyByDriver", () => {
  it("fills days with no rows as zero and keeps the requested range", () => {
    const today = new Date(2026, 8, 24);
    const rows = [row({ day: "2026-09-24", driver: "claude", inputTokens: 10, outputTokens: 5 })];
    const points = dailyByDriver(rows, 3, "all", today);
    expect(points.map((p) => p.day)).toEqual(["2026-09-22", "2026-09-23", "2026-09-24"]);
    expect(points[0].byDriver).toEqual({ claude: 0, codex: 0, opencode: 0 });
    expect(points[1].byDriver).toEqual({ claude: 0, codex: 0, opencode: 0 });
    expect(points[2].byDriver.claude).toBe(15);
    expect(points[2].turns).toBe(1);
  });

  it("switches totals with the metric toggle", () => {
    const today = new Date(2026, 8, 24);
    const rows = [
      row({ day: "2026-09-24", driver: "codex", inputTokens: 4, cacheReadTokens: 100, cacheWriteTokens: 2, outputTokens: 6 })
    ];
    const all = dailyByDriver(rows, 1, "all", today);
    const fresh = dailyByDriver(rows, 1, "fresh", today);
    expect(all[0].byDriver.codex).toBe(112);
    expect(fresh[0].byDriver.codex).toBe(12);
  });
});

describe("byModel", () => {
  it("folds everything past the top N into Other", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      row({ model: `model-${i}`, driver: "claude", inputTokens: 100 - i * 10, outputTokens: 10, turns: 1 })
    );
    const grouped = byModel(rows, "all", 6);
    expect(grouped).toHaveLength(7);
    expect(grouped.slice(0, 6).map((r) => r.id)).toEqual(["model-0", "model-1", "model-2", "model-3", "model-4", "model-5"]);
    const other = grouped[6];
    expect(other.id).toBe("Other (2)");
    expect(other.driver).toBeNull();
    expect(other.turns).toBe(2);
  });

  it("keeps null cost null when no row in the group is priced", () => {
    const rows = [
      row({ model: "gpt-5.5-codex", driver: "codex", inputTokens: 10, outputTokens: 5, costUsd: null }),
      row({ model: "gpt-5.5-codex", driver: "codex", inputTokens: 20, outputTokens: 5, costUsd: null })
    ];
    const [entry] = byModel(rows, "all", 6);
    expect(entry.costUsd).toBeNull();
  });

  it("matches the fresh metric definition for freshTokens: input + cache write + output", () => {
    const rows = [row({ model: "claude-sonnet-5", inputTokens: 4, cacheReadTokens: 100, cacheWriteTokens: 2, outputTokens: 6 })];
    const [entry] = byModel(rows, "all", 6);
    expect(entry.freshTokens).toBe(12);
  });

  it("sums cost across priced rows and ignores unpriced ones in the same group", () => {
    const rows = [
      row({ model: "claude-sonnet-5", driver: "claude", costUsd: 1.5 }),
      row({ model: "claude-sonnet-5", driver: "claude", costUsd: null }),
      row({ model: "claude-sonnet-5", driver: "claude", costUsd: 0.5 })
    ];
    const [entry] = byModel(rows, "all", 6);
    expect(entry.costUsd).toBe(2);
  });
});

describe("topSessions", () => {
  it("ranks sessions by total tokens and respects the limit", () => {
    const rows = [
      row({ sessionId: "sess_a", inputTokens: 1000, outputTokens: 0 }),
      row({ sessionId: "sess_b", inputTokens: 5000, outputTokens: 0 }),
      row({ sessionId: "sess_c", inputTokens: 100, outputTokens: 0 })
    ];
    const ranked = topSessions(rows, 2);
    expect(ranked.map((r) => r.sessionId)).toEqual(["sess_b", "sess_a"]);
  });
});

describe("totals", () => {
  it("counts unpriced turns and leaves cost null when nothing is priced", () => {
    const rows = [
      row({ sessionId: "sess_a", inputTokens: 10, outputTokens: 5, unpricedTurns: 1, costUsd: null }),
      row({ sessionId: "sess_b", inputTokens: 20, outputTokens: 5, unpricedTurns: 1, costUsd: null })
    ];
    const result = totals(rows);
    expect(result.costUsd).toBeNull();
    expect(result.unpricedTurns).toBe(2);
    expect(result.sessions).toBe(2);
    expect(result.totalTokens).toBe(40);
  });

  it("sums priced rows even when other rows in the same query are unpriced", () => {
    const rows = [
      row({ sessionId: "sess_a", costUsd: 2.5, unpricedTurns: 0 }),
      row({ sessionId: "sess_b", costUsd: null, unpricedTurns: 1 })
    ];
    const result = totals(rows);
    expect(result.costUsd).toBe(2.5);
    expect(result.unpricedTurns).toBe(1);
  });
});

describe("turnTokens", () => {
  it("sums input, cache and output tokens but not reasoning", () => {
    const counts = { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40, reasoningTokens: 99 };
    expect(turnTokens(counts)).toBe(100);
  });
});

describe("usageReport", () => {
  const today = new Date(2026, 8, 24);
  const rows = [
    row({ day: "2026-09-24", driver: "claude", projectId: "p1", sessionId: "s1", inputTokens: 100, turns: 2, costUsd: 1 }),
    row({ day: "2026-09-23", driver: "codex", projectId: "p2", sessionId: "s2", model: "gpt-5", outputTokens: 50, turns: 1, costUsd: 0.5 }),
    row({ day: "2026-09-10", driver: "claude", projectId: "p1", sessionId: "s3", inputTokens: 999, turns: 1 })
  ];
  const query = { days: 7, metric: "all" as const, driver: "all" as const, projectId: "all" };

  it("computes the window start", () => {
    expect(sinceDayFor(7, today)).toBe("2026-09-18");
    expect(usageReport(rows, query, today).sinceDay).toBe("2026-09-18");
  });

  it("ignores rows older than the window", () => {
    const report = usageReport(rows, query, today, 4);
    expect(report.totals.totalTokens).toBe(150);
    expect(report.totals.sessions).toBe(2);
    expect(report.daily).toHaveLength(7);
    expect(report.daily[6]).toEqual({ day: "2026-09-24", byDriver: { claude: 100, codex: 0, opencode: 0 }, turns: 2 });
    expect(report.ledgerRev).toBe(4);
  });

  it("filters by driver", () => {
    const report = usageReport(rows, { ...query, driver: "codex" }, today);
    expect(report.totals.totalTokens).toBe(50);
    expect(report.models.map((m) => m.id)).toEqual(["gpt-5"]);
    expect(report.sessions.map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("filters by project", () => {
    const report = usageReport(rows, { ...query, projectId: "p1" }, today);
    expect(report.totals.totalTokens).toBe(100);
    expect(report.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
  });

  it("applies the metric to model values", () => {
    const cached = [row({ day: "2026-09-24", inputTokens: 10, cacheReadTokens: 90 })];
    expect(usageReport(cached, query, today).models[0]?.value).toBe(100);
    expect(usageReport(cached, { ...query, metric: "fresh" }, today).models[0]?.value).toBe(10);
  });

  it("returns an empty report without rows", () => {
    const report = usageReport([], query, today);
    expect(report.totals).toEqual({ totalTokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: null, turns: 0, sessions: 0, unpricedTurns: 0 });
    expect(report.models).toEqual([]);
    expect(report.sessions).toEqual([]);
  });
});
