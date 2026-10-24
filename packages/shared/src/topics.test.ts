import { describe, expect, it } from "bun:test";
import { filesTopic, gitTopic, isValidTopic, ptyTopic, sessionTopic, topicId } from "./topics.js";

describe("isValidTopic", () => {
  it("accepts exact and prefixed topics", () => {
    for (const topic of ["app", "sidebar", "prs", "usage", "session/sess_a", "git/sess_a", "files/sess_a", "pty/sess_a:shell", "github/runs"]) {
      expect(isValidTopic(topic)).toBe(true);
    }
  });

  it("rejects malformed topics", () => {
    const rejected = ["", "session/", "git/", "unknown", "unknown/x", "session/a b", "session/" + "a".repeat(201), "github/Runs", "github/" + "a".repeat(65), "github/a_b", "app/x"];
    for (const topic of rejected) expect(isValidTopic(topic)).toBe(false);
  });

  it("rejects non-strings", () => {
    for (const value of [null, undefined, 1, {}, ["app"]]) expect(isValidTopic(value)).toBe(false);
  });

  it("accepts the maximum id length", () => {
    expect(isValidTopic("session/" + "a".repeat(200))).toBe(true);
  });
});

describe("topic builders", () => {
  it("round-trip through topicId", () => {
    expect(topicId(sessionTopic("s1"), "session/")).toBe("s1");
    expect(topicId(gitTopic("s1"), "git/")).toBe("s1");
    expect(topicId(filesTopic("s1"), "files/")).toBe("s1");
    expect(topicId(ptyTopic("s1:shell"), "pty/")).toBe("s1:shell");
  });

  it("topicId returns null for another prefix or an empty id", () => {
    expect(topicId("git/s1", "session/")).toBeNull();
    expect(topicId("session/", "session/")).toBeNull();
  });
});
