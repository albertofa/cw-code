import { describe, expect, it } from "bun:test";
import { PendingRequests, RequestNotPendingError, type PendingRequest } from "./PendingRequests.js";

function approval(requestId: string, sessionId = "s1", turnId = "t1"): PendingRequest {
  return { kind: "approval", sessionId, turnId, request: { requestId, kind: "command", title: "run?", decisions: ["accept", "decline"] } };
}

function question(requestId: string, sessionId = "s1", turnId = "t1"): PendingRequest {
  return { kind: "question", sessionId, turnId, request: { requestId, turnId, questions: [] } };
}

function ids(entries: PendingRequest[]): string[] {
  return entries.map((entry) => entry.request.requestId);
}

describe("PendingRequests", () => {
  it("lists a session's requests in arrival order", () => {
    const pending = new PendingRequests();
    pending.add(approval("a"));
    pending.add(question("b", "s2"));
    pending.add(question("c"));

    expect(ids(pending.list("s1"))).toEqual(["a", "c"]);
    expect(ids(pending.list("s2"))).toEqual(["b"]);
    expect(pending.list("s3")).toEqual([]);
  });

  it("resolve removes the entry and returns it once", () => {
    const pending = new PendingRequests();
    pending.add(approval("a"));

    expect(pending.resolve("a")?.request.requestId).toBe("a");
    expect(pending.resolve("a")).toBeNull();
    expect(pending.list("s1")).toEqual([]);
  });

  it("lets only the first claim win and hides claimed requests from the list", () => {
    const pending = new PendingRequests();
    pending.add(approval("a"));

    expect(pending.claim("a", "approval").request.requestId).toBe("a");
    expect(() => pending.claim("a", "approval")).toThrow(RequestNotPendingError);
    expect(pending.list("s1")).toEqual([]);
  });

  it("rejects claims for unknown requests or the wrong kind with request-not-pending", () => {
    const pending = new PendingRequests();
    pending.add(approval("a"));

    for (const attempt of [() => pending.claim("missing", "approval"), () => pending.claim("a", "question")]) {
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RequestNotPendingError);
      expect((caught as RequestNotPendingError).code).toBe("request-not-pending");
    }
  });

  it("release makes a claimed request answerable and listed again", () => {
    const pending = new PendingRequests();
    pending.add(approval("a"));
    const claimed = pending.claim("a", "approval");
    expect(pending.release(claimed)).toBe(true);

    expect(ids(pending.list("s1"))).toEqual(["a"]);
    expect(pending.claim("a", "approval").request.requestId).toBe("a");
  });

  it("ignores a stale release after the request was replaced and claimed again", () => {
    const pending = new PendingRequests();
    pending.add(approval("a"));
    const stale = pending.claim("a", "approval");
    pending.add(approval("a"));
    pending.claim("a", "approval");

    expect(pending.release(stale)).toBe(false);
    expect(pending.list("s1")).toEqual([]);
  });

  it("re-adding a request replaces it and drops its claim", () => {
    const pending = new PendingRequests();
    pending.add(approval("a"));
    pending.claim("a", "approval");
    pending.add(approval("a"));

    expect(ids(pending.list("s1"))).toEqual(["a"]);
  });

  it("clearTurn removes only that turn's requests, claimed or not", () => {
    const pending = new PendingRequests();
    pending.add(approval("a", "s1", "t1"));
    pending.add(question("b", "s1", "t1"));
    pending.add(approval("c", "s1", "t2"));
    pending.claim("a", "approval");

    expect(ids(pending.clearTurn("t1"))).toEqual(["a", "b"]);
    expect(ids(pending.list("s1"))).toEqual(["c"]);
    expect(pending.resolve("a")).toBeNull();
  });

  it("clearSession removes only that session's requests", () => {
    const pending = new PendingRequests();
    pending.add(approval("a", "s1"));
    pending.add(approval("b", "s2"));

    expect(ids(pending.clearSession("s1"))).toEqual(["a"]);
    expect(pending.list("s1")).toEqual([]);
    expect(ids(pending.list("s2"))).toEqual(["b"]);
  });
});
