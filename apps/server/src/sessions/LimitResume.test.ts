import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { LimitResume as LimitResumeMeta, SessionMeta, ThreadEvent } from "@cw-code/contracts";
import { SHUTDOWN_RESERVED_MESSAGE } from "../shutdown/shutdownReservation.js";
import { HARNESS_UPDATE_BUSY_DETAIL, SessionBusyError } from "./SessionBusyError.js";
import type { ThreadNotice } from "../threads/ThreadService.js";
import {
  LIMIT_RESUME_MARGIN_MS,
  LIMIT_RESUME_MAX_ATTEMPTS,
  LIMIT_RESUME_PROMPT,
  LIMIT_RESUME_STALE_MS,
  LimitResume
} from "./LimitResume.js";

const HOUR = 60 * 60_000;

function session(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { id, projectId: "p1", driver: "claude", title: id, status: "done", resumeCursor: "c", createdAt: 0, updatedAt: 0, ...extra };
}

function done(turnId: string, resetsAt?: number): Extract<ThreadEvent, { type: "turn.done" }> {
  return {
    type: "turn.done",
    turnId,
    sessionId: "s1",
    resumeCursor: "c",
    resultText: "",
    usage: [],
    numTurns: 1,
    isError: resetsAt !== undefined,
    backgroundTasks: 0,
    ...(resetsAt !== undefined ? { usageLimit: { resetsAt, window: "five_hour" } } : {})
  };
}

function harness(initial: SessionMeta[] = [session("s1")]) {
  const sessions = new Map(initial.map((entry) => [entry.id, entry]));
  const started: Array<{ sessionId: string; prompt: string }> = [];
  const notices: Array<{ sessionId: string; notice: ThreadNotice }> = [];
  const refreshed: string[] = [];
  const state = { enabled: true, busy: false, waiting: false, reserved: false, startError: null as unknown, turns: 0 };
  const engine: LimitResume = new LimitResume({
    sessions: () => [...sessions.values()],
    settings: () => ({ limitAutoResume: state.enabled }),
    runtime: () => ({ busy: state.busy, approvals: [], questions: [] }),
    waitingOnSubagents: () => state.waiting,
    startTurn: async (sessionId, prompt) => {
      if (state.startError) throw state.startError;
      started.push({ sessionId, prompt });
      const turnId = `resume-${++state.turns}`;
      engine.turnStarted(sessionId, { turnId, origin: "limit-resume" });
      return turnId;
    },
    setLimitResume: (sessionId, next: LimitResumeMeta | undefined) => {
      const current = sessions.get(sessionId);
      if (!current) return;
      const updated = { ...current };
      if (next) updated.limitResume = next;
      else delete updated.limitResume;
      sessions.set(sessionId, updated);
      engine.sessionChanged(updated);
    },
    refresh: (sessionId) => refreshed.push(sessionId),
    postNotice: (sessionId, notice) => notices.push({ sessionId, notice }),
    shutdownReserved: () => state.reserved
  });
  const pending = (id = "s1") => sessions.get(id)?.limitResume;
  const advance = async (ms: number) => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { engine, sessions, started, notices, refreshed, state, pending, advance };
}

describe("LimitResume", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-11-03T12:00:00Z"));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("continues the session after the limit resets, not before", async () => {
    const h = harness();
    const resetsAt = Date.now() + 2 * HOUR;
    h.engine.turnSettled("s1", "t1", done("t1", resetsAt));
    expect(h.pending()).toEqual({ resetsAt, window: "five_hour", attempts: 0 });
    expect(h.engine.extras("s1")).toEqual({ limitResume: { resetsAt, window: "five_hour" } });
    expect(h.refreshed).toEqual(["s1"]);
    await h.advance(2 * HOUR);
    expect(h.started).toEqual([]);
    await h.advance(LIMIT_RESUME_MARGIN_MS);
    expect(h.started).toEqual([{ sessionId: "s1", prompt: LIMIT_RESUME_PROMPT }]);
    expect(h.pending()).toBeUndefined();
    expect(h.engine.extras("s1")).toEqual({ limitResume: null });
  });

  it("ignores turns that did not end on a plan limit", () => {
    const h = harness();
    h.engine.turnSettled("s1", "t1", done("t1"));
    h.engine.turnSettled("s1", "t2", { type: "turn.error", turnId: "t2", message: "boom" });
    expect(h.pending()).toBeUndefined();
  });

  it("schedules nothing when the setting is off, for subagents or for closed sessions", () => {
    const off = harness();
    off.state.enabled = false;
    off.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    expect(off.pending()).toBeUndefined();
    const child = harness([session("s1", { subagent: { parentSessionId: "p", isolation: "shared" } })]);
    child.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    expect(child.pending()).toBeUndefined();
    const closed = harness([session("s1", { status: "archived" })]);
    closed.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    expect(closed.pending()).toBeUndefined();
  });

  it("drops the continuation when the user sends a turn, stops, or cancels", async () => {
    for (const act of [
      (h: ReturnType<typeof harness>) => h.engine.turnStarted("s1", { turnId: "user" }),
      (h: ReturnType<typeof harness>) => h.engine.turnStopped("s1"),
      (h: ReturnType<typeof harness>) => expect(h.engine.cancel("s1")).toBe(true)
    ]) {
      const h = harness();
      h.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
      act(h);
      expect(h.pending()).toBeUndefined();
      await h.advance(2 * HOUR);
      expect(h.started).toEqual([]);
    }
    expect(harness().engine.cancel("s1")).toBe(false);
  });

  it("drops every pending continuation when the setting is turned off", async () => {
    const h = harness();
    h.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    h.state.enabled = false;
    h.engine.settingsChanged();
    expect(h.pending()).toBeUndefined();
    await h.advance(2 * HOUR);
    expect(h.started).toEqual([]);
  });

  it("drops the continuation when the session is closed or busy at reset time", async () => {
    const closed = harness();
    closed.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    const archived = { ...closed.sessions.get("s1")!, status: "archived" as const };
    closed.sessions.set("s1", archived);
    closed.engine.sessionChanged(archived);
    expect(closed.pending()).toBeUndefined();
    const busy = harness();
    busy.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    busy.state.waiting = true;
    await busy.advance(2 * HOUR);
    expect(busy.started).toEqual([]);
    expect(busy.pending()).toBeUndefined();
  });

  it("reschedules a continuation that hits the limit again and gives up after the cap", async () => {
    const h = harness();
    h.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    for (let attempt = 1; attempt <= LIMIT_RESUME_MAX_ATTEMPTS; attempt += 1) {
      await h.advance(HOUR + LIMIT_RESUME_MARGIN_MS);
      expect(h.started).toHaveLength(attempt);
      h.engine.turnSettled("s1", `resume-${attempt}`, done(`resume-${attempt}`, Date.now() + HOUR));
      if (attempt < LIMIT_RESUME_MAX_ATTEMPTS) expect(h.pending()?.attempts).toBe(attempt);
    }
    expect(h.pending()).toBeUndefined();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].notice.severity).toBe("warning");
    await h.advance(3 * HOUR);
    expect(h.started).toHaveLength(LIMIT_RESUME_MAX_ATTEMPTS);
  });

  it("starts the attempt count over after a turn the user sent", async () => {
    const h = harness();
    h.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    await h.advance(HOUR + LIMIT_RESUME_MARGIN_MS);
    h.engine.turnSettled("s1", "resume-1", done("resume-1"));
    h.engine.turnStarted("s1", { turnId: "user" });
    h.engine.turnSettled("s1", "user", done("user", Date.now() + HOUR));
    expect(h.pending()?.attempts).toBe(0);
  });

  it("re-arms persisted continuations after a restart and drops stale ones", async () => {
    const fresh = harness([session("s1", { limitResume: { resetsAt: Date.now() - HOUR, attempts: 0 } })]);
    fresh.engine.reactivate();
    await fresh.advance(LIMIT_RESUME_MARGIN_MS);
    expect(fresh.started).toHaveLength(1);
    const stale = harness([session("s1", { limitResume: { resetsAt: Date.now() - LIMIT_RESUME_STALE_MS - HOUR, attempts: 0 } })]);
    stale.engine.reactivate();
    await stale.advance(LIMIT_RESUME_MARGIN_MS);
    expect(stale.started).toEqual([]);
    expect(stale.pending()).toBeUndefined();
  });

  it("keeps the continuation across a shutdown and resumes it on recovery", async () => {
    const h = harness();
    h.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    h.engine.dispose();
    await h.advance(2 * HOUR);
    expect(h.started).toEqual([]);
    expect(h.pending()).toBeDefined();
    h.state.startError = new Error(SHUTDOWN_RESERVED_MESSAGE);
    h.engine.reactivate();
    await h.advance(LIMIT_RESUME_MARGIN_MS);
    expect(h.pending()).toBeDefined();
    h.state.startError = null;
    h.engine.reactivate();
    await h.advance(LIMIT_RESUME_MARGIN_MS);
    expect(h.started).toHaveLength(1);
  });

  it("keeps the streak when a continuation settles twice on a limit", async () => {
    const h = harness();
    h.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    for (let attempt = 1; attempt < LIMIT_RESUME_MAX_ATTEMPTS; attempt += 1) {
      await h.advance(HOUR + LIMIT_RESUME_MARGIN_MS);
      const turnId = `resume-${attempt}`;
      h.engine.turnSettled("s1", turnId, done(turnId, Date.now() + HOUR));
      h.engine.turnSettled("s1", turnId, done(turnId, Date.now() + HOUR));
      expect(h.pending()?.attempts).toBe(attempt);
    }
    await h.advance(HOUR + LIMIT_RESUME_MARGIN_MS);
    h.engine.turnSettled("s1", `resume-${LIMIT_RESUME_MAX_ATTEMPTS}`, done("x", Date.now() + HOUR));
    expect(h.pending()).toBeUndefined();
    expect(h.notices).toHaveLength(1);
  });

  it("does not start a fourth continuation when the capped one settles twice", async () => {
    const h = harness();
    h.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    for (let attempt = 1; attempt <= LIMIT_RESUME_MAX_ATTEMPTS; attempt += 1) {
      await h.advance(HOUR + LIMIT_RESUME_MARGIN_MS);
      const turnId = `resume-${attempt}`;
      h.engine.turnSettled("s1", turnId, done(turnId, Date.now() + HOUR));
      h.engine.turnSettled("s1", turnId, done(turnId, Date.now() + HOUR));
    }
    expect(h.pending()).toBeUndefined();
    await h.advance(3 * HOUR);
    expect(h.started).toHaveLength(LIMIT_RESUME_MAX_ATTEMPTS);
    expect(new Set(h.notices.map((entry) => entry.notice.noticeId)).size).toBe(1);
  });

  it("retries after a harness update instead of dropping the continuation", async () => {
    const h = harness();
    h.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    h.state.startError = new SessionBusyError(HARNESS_UPDATE_BUSY_DETAIL, "Claude is updating. Try again when the update finishes.");
    await h.advance(HOUR + LIMIT_RESUME_MARGIN_MS);
    expect(h.pending()).toBeDefined();
    expect(h.notices).toEqual([]);
    h.state.startError = null;
    await h.advance(LIMIT_RESUME_MARGIN_MS);
    expect(h.started).toEqual([{ sessionId: "s1", prompt: LIMIT_RESUME_PROMPT }]);
    expect(h.pending()).toBeUndefined();
  });

  it("drops the continuation quietly when another turn is already running", async () => {
    const h = harness();
    h.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    h.state.startError = new SessionBusyError("turn pending");
    await h.advance(HOUR + LIMIT_RESUME_MARGIN_MS);
    expect(h.pending()).toBeUndefined();
    expect(h.notices).toEqual([]);
  });

  it("tells the user when the continuation could not start", async () => {
    const h = harness();
    h.engine.turnSettled("s1", "t1", done("t1", Date.now() + HOUR));
    h.state.startError = new Error("claude is updating");
    await h.advance(HOUR + LIMIT_RESUME_MARGIN_MS);
    expect(h.pending()).toBeUndefined();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].notice).toMatchObject({ severity: "error" });
    expect(h.notices[0].notice.text).toContain("claude is updating");
  });
});
