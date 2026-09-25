import { describe, expect, it } from "vitest";
import type { UsageLedgerRow } from "../cw.js";
import { byModel, dailyByDriver, topSessions, totals } from "./usageModel.js";

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
