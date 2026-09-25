import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnModelUsage } from "@cw-code/contracts";
import { UsageLedger } from "./UsageLedger.js";

let dir = "";

function usage(overrides: Partial<TurnModelUsage> = {}): TurnModelUsage {
  return {
    model: "claude-sonnet-5",
    inputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
    reasoningTokens: 0,
    costUsd: null,
    ...overrides
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cw-usage-ledger-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("UsageLedger", () => {
  it("adds counts for the same day, session and model", () => {
    const ledger = new UsageLedger(dir);
    ledger.record({
      turnId: "t1",
      sessionId: "s1",
      projectId: "p1",
      driver: "claude",
      at: new Date(2026, 0, 15, 9),
      usage: [usage({ inputTokens: 10, outputTokens: 5 })]
    });
    ledger.record({
      turnId: "t2",
      sessionId: "s1",
      projectId: "p1",
      driver: "claude",
      at: new Date(2026, 0, 15, 10),
      usage: [usage({ inputTokens: 3, outputTokens: 2 })]
    });
    const rows = ledger.query({ sessionId: "s1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2026-01-15",
      sessionId: "s1",
      model: "claude-sonnet-5",
      inputTokens: 13,
      outputTokens: 7,
      turns: 2
    });
  });

  it("counts a multi-model turn once, on the entry with the largest outputTokens", () => {
    const ledger = new UsageLedger(dir);
    ledger.record({
      turnId: "t1",
      sessionId: "s1",
      projectId: "p1",
      driver: "claude",
      at: new Date(2026, 0, 15),
      usage: [
        usage({ model: "claude-haiku-4-5", outputTokens: 3, costUsd: null }),
        usage({ model: "claude-sonnet-5", outputTokens: 10, costUsd: 0.5 })
      ]
    });
    const rows = ledger.query({ sessionId: "s1" });
    expect(rows).toHaveLength(2);
    const totalTurns = rows.reduce((sum, row) => sum + row.turns, 0);
    expect(totalTurns).toBe(1);
    const sonnetRow = rows.find((row) => row.model === "claude-sonnet-5");
    const haikuRow = rows.find((row) => row.model === "claude-haiku-4-5");
    expect(sonnetRow?.turns).toBe(1);
    expect(haikuRow?.turns).toBe(0);
    expect(sonnetRow?.unpricedTurns).toBe(0);
    expect(haikuRow?.unpricedTurns).toBe(0);
  });

  it("ties on outputTokens go to the first entry", () => {
    const ledger = new UsageLedger(dir);
    ledger.record({
      turnId: "t1",
      sessionId: "s1",
      projectId: "p1",
      driver: "claude",
      at: new Date(2026, 0, 15),
      usage: [
        usage({ model: "model-a", outputTokens: 5, costUsd: null }),
        usage({ model: "model-b", outputTokens: 5, costUsd: null })
      ]
    });
    const rows = ledger.query({ sessionId: "s1" });
    const rowA = rows.find((row) => row.model === "model-a");
    const rowB = rows.find((row) => row.model === "model-b");
    expect(rowA?.turns).toBe(1);
    expect(rowA?.unpricedTurns).toBe(1);
    expect(rowB?.turns).toBe(0);
    expect(rowB?.unpricedTurns).toBe(0);
  });

  it("counts two records with the same turnId separately (background-task turns reuse a turnId)", () => {
    const ledger = new UsageLedger(dir);
    const record = () =>
      ledger.record({
        turnId: "reused",
        sessionId: "s1",
        projectId: "p1",
        driver: "claude",
        at: new Date(2026, 0, 15),
        usage: [usage({ inputTokens: 10 })]
      });
    record();
    record();
    const rows = ledger.query({ sessionId: "s1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(20);
    expect(rows[0].turns).toBe(2);
  });

  it("keeps costUsd null until a priced turn arrives, and tracks unpriced turns", () => {
    const ledger = new UsageLedger(dir);
    ledger.record({
      turnId: "t1",
      sessionId: "s1",
      projectId: "p1",
      driver: "codex",
      at: new Date(2026, 0, 15),
      usage: [usage({ costUsd: null })]
    });
    let row = ledger.query({ sessionId: "s1" })[0];
    expect(row.costUsd).toBeNull();
    expect(row.unpricedTurns).toBe(1);

    ledger.record({
      turnId: "t2",
      sessionId: "s1",
      projectId: "p1",
      driver: "codex",
      at: new Date(2026, 0, 15),
      usage: [usage({ costUsd: 0.5 })]
    });
    row = ledger.query({ sessionId: "s1" })[0];
    expect(row.costUsd).toBe(0.5);
    expect(row.unpricedTurns).toBe(1);
    expect(row.turns).toBe(2);
  });

  it("queries by sinceDay across two months, reading only the relevant ones", () => {
    const ledger = new UsageLedger(dir);
    ledger.record({
      turnId: "jan",
      sessionId: "s1",
      projectId: "p1",
      driver: "claude",
      at: new Date(2026, 0, 20),
      usage: [usage()]
    });
    ledger.record({
      turnId: "feb",
      sessionId: "s1",
      projectId: "p1",
      driver: "claude",
      at: new Date(2026, 1, 3),
      usage: [usage()]
    });
    ledger.flush();

    const fresh = new UsageLedger(dir);
    const rows = fresh.query({ sinceDay: "2026-02-01" });
    expect(rows.map((row) => row.day)).toEqual(["2026-02-03"]);
  });

  it("queries by sessionId across all months", () => {
    const ledger = new UsageLedger(dir);
    ledger.record({
      turnId: "jan",
      sessionId: "s1",
      projectId: "p1",
      driver: "claude",
      at: new Date(2026, 0, 20),
      usage: [usage()]
    });
    ledger.record({
      turnId: "feb",
      sessionId: "s1",
      projectId: "p1",
      driver: "claude",
      at: new Date(2026, 1, 3),
      usage: [usage()]
    });
    ledger.record({
      turnId: "other-session",
      sessionId: "s2",
      projectId: "p1",
      driver: "claude",
      at: new Date(2026, 1, 3),
      usage: [usage()]
    });
    ledger.flush();

    const fresh = new UsageLedger(dir);
    const rows = fresh.query({ sessionId: "s1" });
    expect(rows.map((row) => row.day).sort()).toEqual(["2026-01-20", "2026-02-03"]);
  });

  it("round-trips a write and read through a temp dir", () => {
    const ledger = new UsageLedger(dir);
    ledger.record({
      turnId: "t1",
      sessionId: "s1",
      projectId: "p1",
      driver: "opencode",
      at: new Date(2026, 2, 1),
      usage: [usage({ inputTokens: 42, costUsd: 1.23 })]
    });
    ledger.flush();

    const reloaded = new UsageLedger(dir);
    const rows = reloaded.query({ sessionId: "s1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: "2026-03-01", inputTokens: 42, costUsd: 1.23, driver: "opencode" });
  });

  it("quarantines a corrupt month file instead of destroying it, and treats it as empty", () => {
    const ledger = new UsageLedger(dir);
    ledger.record({
      turnId: "t1",
      sessionId: "s1",
      projectId: "p1",
      driver: "claude",
      at: new Date(2026, 0, 1),
      usage: [usage()]
    });
    ledger.flush();

    writeFileSync(join(dir, "2026-01.json"), "not json", "utf8");

    const reloaded = new UsageLedger(dir);
    expect(() => reloaded.query({ sessionId: "s1" })).not.toThrow();
    expect(reloaded.query({ sessionId: "s1" })).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
    expect(existsSync(join(dir, "2026-01.json"))).toBe(false);
    const quarantined = readdirSync(dir).filter((name) => name.startsWith("2026-01.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
  });

  it("drops malformed rows on read but keeps the valid ones, with a warning", () => {
    writeFileSync(
      join(dir, "2026-01.json"),
      JSON.stringify({
        version: 1,
        rows: [
          {
            day: "2026-01-05",
            sessionId: "s1",
            projectId: "p1",
            driver: "claude",
            model: "claude-sonnet-5",
            inputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 1,
            reasoningTokens: 0,
            turns: 1,
            costUsd: null,
            unpricedTurns: 1
          },
          { day: "2026-01-06", sessionId: "s1", inputTokens: "not-a-number" }
        ]
      }),
      "utf8"
    );

    const ledger = new UsageLedger(dir);
    const rows = ledger.query({ sessionId: "s1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe("2026-01-05");
    expect(console.warn).toHaveBeenCalled();
  });

  it("returns copies from query, so mutating a result never leaks into the ledger's own state", () => {
    const ledger = new UsageLedger(dir);
    ledger.record({
      turnId: "t1",
      sessionId: "s1",
      projectId: "p1",
      driver: "claude",
      at: new Date(2026, 0, 1),
      usage: [usage({ inputTokens: 10 })]
    });
    const rows = ledger.query({ sessionId: "s1" });
    rows[0].inputTokens = 999;
    const rowsAgain = ledger.query({ sessionId: "s1" });
    expect(rowsAgain[0].inputTokens).toBe(10);
  });
});
