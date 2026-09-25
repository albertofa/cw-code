import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CliDriver, HistoryMessage, ThreadEvent, TurnHandle } from "@cw-code/contracts";
import { initHarnessTrace, resetHarnessTraceForTests } from "./harnessTrace.js";
import { TracingCliDriver } from "./tracingDriver.js";

class FakeDriver implements CliDriver {
  readonly kind = "claude" as const;
  failHistory = false;
  interrupted: string[] = [];
  constructor(private emit: (event: ThreadEvent) => void = () => {}) {}
  async listSessions(): Promise<[]> {
    return [];
  }
  async getHistory(): Promise<HistoryMessage[]> {
    if (this.failHistory) throw new Error("history exploded");
    return [];
  }
  startTurn(request: { sessionId: string; prompt: string }): TurnHandle {
    const turnId = randomUUID();
    this.emit({ type: "assistant.delta", turnId, text: request.prompt });
    return { turnId, events: (async function* () {})() };
  }
  interrupt(turnId: string): void {
    this.interrupted.push(turnId);
  }
  async renameSession(): Promise<void> {}
  async *events(): AsyncIterable<never> {}
}

let filePath = "";

beforeEach(() => {
  resetHarnessTraceForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  filePath = join(mkdtempSync(join(tmpdir(), "cw-tracing-")), "harness-trace.jsonl");
  initHarnessTrace({ filePath });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetHarnessTraceForTests();
});

function readRecords(): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("TracingCliDriver", () => {
  it("delegates startTurn and logs the dispatch", () => {
    const tracing = new TracingCliDriver(new FakeDriver());
    const handle = tracing.startTurn({ sessionId: "s1", prompt: "hello there", cwd: "C:\\proj" });
    expect(typeof handle.turnId).toBe("string");
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      harness: "claude",
      operation: "claude.startTurn",
      sessionId: "s1",
      turnId: handle.turnId,
      promptPreview: "hello there",
      promptLength: 11,
      ok: true
    });
  });

  it("logs getHistory failures with ok:false", async () => {
    const inner = new FakeDriver();
    inner.failHistory = true;
    const tracing = new TracingCliDriver(inner);
    await expect(tracing.getHistory("C:\\proj", "cursor1")).rejects.toThrow("history exploded");
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      harness: "claude",
      operation: "claude.getHistory",
      ok: false
    });
    expect(String(records[0]["error"])).toContain("history exploded");
  });

  it("logs listSessions with duration and count", async () => {
    const tracing = new TracingCliDriver(new FakeDriver());
    await tracing.listSessions("C:\\proj");
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ operation: "claude.listSessions", ok: true });
    expect(typeof records[0]["durationMs"]).toBe("number");
    expect((records[0]["extra"] as { count: number }).count).toBe(0);
  });

  it("forwards listModels to drivers that support it", async () => {
    const tracing = new TracingCliDriver(new FakeDriver());
    await expect(tracing.listModels("C:\\proj")).resolves.toEqual([]);
    const withModels = new TracingCliDriver({
      kind: "opencode",
      listModels: async () => [{ id: "m", label: "m", source: "live" as const }]
    } as unknown as CliDriver);
    await expect(withModels.listModels("C:\\proj")).resolves.toEqual([
      { id: "m", label: "m", source: "live" }
    ]);
  });

  it("forwards listCommands to drivers that support it", async () => {
    const tracing = new TracingCliDriver(new FakeDriver());
    await expect(tracing.listCommands("C:\\proj")).resolves.toEqual([]);
    const withCommands = new TracingCliDriver({
      kind: "opencode",
      listCommands: async () => [{ name: "compact", description: "Compact", dispatch: "native" as const }]
    } as unknown as CliDriver);
    await expect(withCommands.listCommands("C:\\proj")).resolves.toEqual([
      { name: "compact", description: "Compact", dispatch: "native" }
    ]);
    const failing = new TracingCliDriver({
      kind: "claude",
      listCommands: async () => {
        throw new Error("probe failed");
      }
    } as unknown as CliDriver);
    await expect(failing.listCommands("C:\\proj")).rejects.toThrow("probe failed");
  });

  it("forwards approval responses and logs the decision", async () => {
    const seen: Array<{ requestId: string; decision: string }> = [];
    const withApprovals = new TracingCliDriver({
      kind: "codex",
      respondToApproval: async (requestId: string, decision: "accept") => {
        seen.push({ requestId, decision });
      }
    } as unknown as CliDriver);
    await withApprovals.respondToApproval("req-1", "accept");
    expect(seen).toEqual([{ requestId: "req-1", decision: "accept" }]);
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      harness: "codex",
      operation: "codex.respondToApproval",
      ok: true,
      extra: { decision: "accept" }
    });
  });

  it("resolves to no-op for drivers without approval support", async () => {
    const tracing = new TracingCliDriver(new FakeDriver());
    await expect(tracing.respondToApproval("req-1", "decline")).resolves.toBeUndefined();
  });

  it("forwards stopSession and logs the call", () => {
    const seen: string[] = [];
    const withStop = new TracingCliDriver({
      kind: "claude",
      stopSession: (sessionId: string) => {
        seen.push(sessionId);
      }
    } as unknown as CliDriver);
    withStop.stopSession("s1");
    expect(seen).toEqual(["s1"]);
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      harness: "claude",
      operation: "claude.stopSession",
      sessionId: "s1",
      ok: true
    });
    expect(typeof records[0]["durationMs"]).toBe("number");
  });

  it("writes no trace for drivers without stopSession support", () => {
    const tracing = new TracingCliDriver(new FakeDriver());
    tracing.interrupt("t0");
    tracing.stopSession("s1");
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ operation: "claude.interrupt" });
  });

  it("leaves getAccountUsage undefined for drivers without support", () => {
    const tracing = new TracingCliDriver(new FakeDriver());
    expect(tracing.getAccountUsage).toBeUndefined();
  });

  it("forwards getAccountUsage and traces status without the payload", async () => {
    const state = { status: "ok" as const, windows: [], balances: [], notes: [] };
    const withUsage = new TracingCliDriver({
      kind: "claude",
      getAccountUsage: async () => state
    } as unknown as CliDriver);
    await expect(withUsage.getAccountUsage?.()).resolves.toEqual(state);
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      harness: "claude",
      operation: "claude.getAccountUsage",
      ok: true,
      extra: { status: "ok" }
    });
    expect(records[0]).not.toHaveProperty("windows");
    expect(records[0]).not.toHaveProperty("balances");
  });

  it("includes a truncated error when getAccountUsage resolves to a non-ok state", async () => {
    const state = { status: "unavailable" as const, reason: "not-installed" as const, message: "Claude isn't installed." };
    const withUsage = new TracingCliDriver({
      kind: "claude",
      getAccountUsage: async () => state
    } as unknown as CliDriver);
    await expect(withUsage.getAccountUsage?.()).resolves.toEqual(state);
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      harness: "claude",
      operation: "claude.getAccountUsage",
      ok: true,
      extra: { status: "unavailable" },
      error: "Claude isn't installed."
    });
  });

  it("logs getAccountUsage failures with ok:false", async () => {
    const withUsage = new TracingCliDriver({
      kind: "codex",
      getAccountUsage: async () => {
        throw new Error("probe timed out");
      }
    } as unknown as CliDriver);
    await expect(withUsage.getAccountUsage?.()).rejects.toThrow("probe timed out");
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      harness: "codex",
      operation: "codex.getAccountUsage",
      ok: false
    });
    expect(String(records[0]["error"])).toContain("probe timed out");
  });

  it("logs getAccountUsage failures for non-Error throws using String(err)", async () => {
    const withUsage = new TracingCliDriver({
      kind: "codex",
      getAccountUsage: async () => {
        throw "boom";
      }
    } as unknown as CliDriver);
    await expect(withUsage.getAccountUsage?.()).rejects.toBe("boom");
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ harness: "codex", operation: "codex.getAccountUsage", ok: false });
    expect(String(records[0]["error"])).toContain("boom");
  });
});
