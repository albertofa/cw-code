import { describe, expect, it } from "bun:test";
import { trackNotificationSounds, type SessionSoundState, type SoundTracker } from "./notificationSoundTriggers.js";

function state(overrides: Partial<SessionSoundState> = {}): SessionSoundState {
  return { status: "working", questionIds: [], latestPrUpdateAt: null, prMuted: false, ...overrides };
}

function track(tracker: SoundTracker | null, sessions: Record<string, SessionSoundState>, now: number, openSessionId: string | null = null) {
  return trackNotificationSounds(tracker, sessions, now, openSessionId);
}

function seeded(sessions: Record<string, SessionSoundState>, now = 1_000): SoundTracker {
  return track(null, sessions, now).tracker;
}

function events(tracker: SoundTracker, sessions: Record<string, SessionSoundState>, now = 2_000) {
  return track(tracker, sessions, now).events;
}

describe("trackNotificationSounds", () => {
  it("stays silent the first time it sees a session, whatever its state", () => {
    const first = track(null, { a: state({ status: "done", questionIds: ["q1"], latestPrUpdateAt: 5_000 }) }, 1_000);
    expect(first.events).toEqual([]);
    const later = track(first.tracker, { b: state({ status: "done", questionIds: ["q2"] }) }, 2_000);
    expect(later.events).toEqual([]);
  });

  it("sounds done only on the transition into done", () => {
    const tracker = seeded({ a: state({ status: "working" }) });
    const done = track(tracker, { a: state({ status: "done" }) }, 2_000);
    expect(done.events).toEqual(["done"]);
    expect(events(done.tracker, { a: state({ status: "done" }) })).toEqual([]);
  });

  it("sounds a question for each new request id, not for approvals or status alone", () => {
    const tracker = seeded({ a: state() });
    expect(events(tracker, { a: state({ status: "input-required" }) })).toEqual([]);
    const asked = track(tracker, { a: state({ status: "input-required", questionIds: ["q1"] }) }, 2_000);
    expect(asked.events).toEqual(["question"]);
    expect(events(asked.tracker, { a: state({ status: "input-required", questionIds: ["q1"] }) })).toEqual([]);
    expect(events(asked.tracker, { a: state({ status: "input-required", questionIds: ["q1", "q2"] }) })).toEqual(["question"]);
  });

  it("sounds a PR update only when it is newer than anything already heard", () => {
    const tracker = seeded({ a: state() }, 1_000);
    expect(events(tracker, { a: state({ latestPrUpdateAt: 900 }) })).toEqual([]);
    const heard = track(tracker, { a: state({ latestPrUpdateAt: 1_500 }) }, 2_000);
    expect(heard.events).toEqual(["prUpdate"]);
    const cleared = track(heard.tracker, { a: state({ latestPrUpdateAt: null }) }, 3_000);
    expect(cleared.events).toEqual([]);
    expect(events(cleared.tracker, { a: state({ latestPrUpdateAt: 1_500 }) })).toEqual([]);
    expect(events(cleared.tracker, { a: state({ latestPrUpdateAt: 1_600 }) })).toEqual(["prUpdate"]);
  });

  it("keeps babysat PR updates silent without replaying them once babysit stops", () => {
    const tracker = seeded({ a: state() }, 1_000);
    const muted = track(tracker, { a: state({ latestPrUpdateAt: 1_500, prMuted: true }) }, 2_000);
    expect(muted.events).toEqual([]);
    expect(events(muted.tracker, { a: state({ latestPrUpdateAt: 1_500 }) })).toEqual([]);
  });

  it("stays silent for the open session without replaying its events later", () => {
    const tracker = seeded({ a: state(), b: state() }, 1_000);
    const next = {
      a: state({ status: "done", questionIds: ["q1"], latestPrUpdateAt: 1_500 }),
      b: state({ status: "done" })
    };
    expect(track(tracker, next, 2_000, "a").events).toEqual(["done"]);
    const opened = track(tracker, { a: next.a, b: state() }, 2_000, "a");
    expect(opened.events).toEqual([]);
    expect(events(opened.tracker, { a: next.a, b: state() })).toEqual([]);
  });

  it("reports each event once across sessions, question first", () => {
    const tracker = seeded({ a: state(), b: state(), c: state() }, 1_000);
    const next = {
      a: state({ status: "done", latestPrUpdateAt: 1_500 }),
      b: state({ status: "done" }),
      c: state({ status: "input-required", questionIds: ["q1"] })
    };
    expect(events(tracker, next)).toEqual(["question", "done", "prUpdate"]);
  });
});
