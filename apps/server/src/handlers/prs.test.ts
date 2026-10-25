import { describe, expect, it } from "bun:test";
import { parseUpdateKeys } from "./prs.js";

const sessions = { hasSession: (id: string) => id === "s1" };

describe("parseUpdateKeys", () => {
  it("accepts a known session with string keys", () => {
    expect(parseUpdateKeys({ sessionId: "s1", keys: ["a", "b"] }, "prs.sendUpdates", sessions)).toEqual({ sessionId: "s1", keys: ["a", "b"] });
  });

  it("rejects missing arguments", () => {
    expect(() => parseUpdateKeys(undefined, "prs.sendUpdates", sessions)).toThrow("prs.sendUpdates requires an argument object");
  });

  it("rejects an empty key list", () => {
    expect(() => parseUpdateKeys({ sessionId: "s1", keys: [] }, "prs.sendUpdates", sessions)).toThrow("at least one pull request key");
  });

  it("rejects a key list that is not an array", () => {
    expect(() => parseUpdateKeys({ sessionId: "s1", keys: "a" }, "prs.sendUpdates", sessions)).toThrow("keys must be an array");
  });

  it("rejects more than 100 keys", () => {
    const keys = Array.from({ length: 101 }, (_, index) => `k${index}`);
    expect(() => parseUpdateKeys({ sessionId: "s1", keys }, "prs.dismissUpdates", sessions)).toThrow("at most 100");
  });

  it("rejects non-string keys", () => {
    expect(() => parseUpdateKeys({ sessionId: "s1", keys: ["a", 1] }, "prs.sendUpdates", sessions)).toThrow("expected a string");
  });

  it("rejects an unknown or non-string session id", () => {
    expect(() => parseUpdateKeys({ sessionId: "nope", keys: ["a"] }, "prs.sendUpdates", sessions)).toThrow("unknown session nope");
    expect(() => parseUpdateKeys({ sessionId: 7, keys: ["a"] }, "prs.sendUpdates", sessions)).toThrow("sessionId must be a string");
  });
});
