import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_SCHEMA_VERSION, SessionStore } from "../sessions/SessionStore.js";
import {
  getSessionStatusTracePath,
  initSessionStatusTrace,
  resetSessionStatusTraceForTests,
  type SessionStatusTransition
} from "./sessionStatusTrace.js";

beforeEach(() => {
  resetSessionStatusTraceForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionStatusTraceForTests();
});

function initTmp(): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "cw-status-"));
  const filePath = join(dir, "session-status.jsonl");
  initSessionStatusTrace({ filePath });
  expect(getSessionStatusTracePath()).toBe(filePath);
  return { dir, filePath };
}

function readLines(filePath: string): SessionStatusTransition[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionStatusTransition);
}

function makeStore(): SessionStore {
  return new SessionStore(join(mkdtempSync(join(tmpdir(), "cw-status-store-")), "test.db"));
}

describe("session status trace", () => {
  it("records creation, every status change with its reason, and holding expiry", () => {
    const { filePath } = initTmp();
    const store = makeStore();
    const session = store.createSession("p1", "claude", "Session");

    store.updateSession(session.id, { status: "working" }, "turn-start");
    store.updateSession(session.id, { status: "done" }, "turn-done");
    store.updateSession(session.id, { status: "idle" }, "pr-finished");

    const lines = readLines(filePath);
    expect(lines.map((l) => [l.from, l.to, l.reason])).toEqual([
      [null, "idle", "session-created"],
      ["idle", "working", "turn-start"],
      ["working", "done", "turn-done"],
      ["done", "idle", "pr-finished"]
    ]);
    expect(lines.every((l) => l.sessionId === session.id && l.driver === "claude")).toBe(true);
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2, 3]);
  });

  it("skips no-op transitions and non-status patches", () => {
    const { filePath } = initTmp();
    const store = makeStore();
    const session = store.createSession("p1", "claude", "Session");

    store.updateSession(session.id, { title: "Renamed" });
    store.updateSession(session.id, { status: "idle" }, "turn-start");

    expect(readLines(filePath).map((l) => l.reason)).toEqual(["session-created"]);
  });

  it("labels a holding session that expired back to idle", () => {
    const { filePath } = initTmp();
    const store = makeStore();
    const session = store.createSession("p1", "claude", "Session");
    store.updateSession(session.id, { status: "holding" }, "turn-error");

    expect(store.expireHolding(session.id)?.status).toBe("idle");

    const last = readLines(filePath).at(-1);
    expect(last).toMatchObject({ from: "holding", to: "idle", reason: "holding-expired" });
  });

  it("does nothing until the trace is initialised", () => {
    const store = makeStore();
    expect(() => store.createSession("p1", "claude", "Session")).not.toThrow();
    expect(getSessionStatusTracePath()).toBeNull();
  });

  it("migrates a session left working by a previous run", () => {
    const { filePath } = initTmp();
    const dir = mkdtempSync(join(tmpdir(), "cw-status-boot-"));
    const dbPath = join(dir, "test.db");
    writeFileSync(
      `${dbPath}.json`,
      JSON.stringify({
        schemaVersion: SESSION_SCHEMA_VERSION,
        projects: [{ id: "p1", rootPath: "C:\\proj", name: "proj" }],
        sessions: [
          { id: "s1", projectId: "p1", driver: "claude", title: "A", status: "working", resumeCursor: "", createdAt: 0, updatedAt: 0 },
          { id: "s2", projectId: "p1", driver: "claude", title: "B", resumeCursor: "", createdAt: 0, updatedAt: 0 }
        ]
      })
    );

    new SessionStore(dbPath);

    expect(readLines(filePath).map((l) => [l.sessionId, l.from, l.to, l.reason])).toEqual([
      ["s1", "working", "holding", "app-restart-holding"],
      ["s2", null, "idle", "app-restart-idle"]
    ]);
  });
});
