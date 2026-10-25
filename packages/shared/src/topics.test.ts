import { describe, expect, it } from "bun:test";
import {
  filesTopic,
  GITHUB_META_TOPIC,
  gitTopic,
  githubViewTopic,
  isValidTopic,
  parseGithubViewTopic,
  ptyTopic,
  sessionTopic,
  topicId,
  topicSessionId
} from "./topics.js";

describe("isValidTopic", () => {
  it("accepts exact and prefixed topics", () => {
    for (const topic of ["app", "sidebar", "prs", "usage", "session/sess_a", "git/sess_a", "files/sess_a", "pty/sess_a:shell", "github/runs", "github/meta", "github/view:pr:is%3Aopen", "github/view:run:"]) {
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

describe("github topics", () => {
  const queries = ["", "is:open author:@me", "label:#bug", "repo:owner/name path:src/a b", "50% a&b=c?d+e", "ação é ótima", "'quoted' (grouped) *"];

  it("round-trips queries through githubViewTopic and parseGithubViewTopic", () => {
    for (const kind of ["pr", "issue", "run"] as const) {
      for (const query of queries) {
        const topic = githubViewTopic(kind, query);
        expect(isValidTopic(topic)).toBe(true);
        expect(parseGithubViewTopic(topic)).toEqual({ kind, query });
      }
    }
  });

  it("encodes the query so the topic keeps its kind separator", () => {
    expect(githubViewTopic("pr", "is:open #1/2")).toBe("github/view:pr:is%3Aopen%20%231%2F2");
  });

  it("rejects malformed view topics", () => {
    const rejected = [
      "github/view:",
      "github/view:pr",
      "github/view:bogus:q",
      "github/view:constructor:q",
      "github/view::q",
      "github/view:pr:a b",
      "github/view:pr:a:b",
      "github/view:pr:%E0%A4%A",
      "github/view:pr:" + "a".repeat(2001)
    ];
    for (const topic of rejected) {
      expect(parseGithubViewTopic(topic)).toBeNull();
      expect(isValidTopic(topic)).toBe(false);
    }
    expect(parseGithubViewTopic("github/runs")).toBeNull();
    expect(parseGithubViewTopic("github/meta")).toBeNull();
  });

  it("accepts an encoded query at the length cap", () => {
    expect(isValidTopic("github/view:pr:" + "a".repeat(2000))).toBe(true);
  });

  it("exposes the meta topic", () => {
    expect(GITHUB_META_TOPIC).toBe("github/meta");
    expect(isValidTopic(GITHUB_META_TOPIC)).toBe(true);
  });
});

describe("topicSessionId", () => {
  it("extracts the session id for the matching prefix", () => {
    expect(topicSessionId(sessionTopic("s1"), "session/")).toBe("s1");
    expect(topicSessionId(gitTopic("s1"), "git/")).toBe("s1");
    expect(topicSessionId(filesTopic("s1"), "files/")).toBe("s1");
  });

  it("returns null for another prefix or an empty id", () => {
    expect(topicSessionId("git/s1", "session/")).toBeNull();
    expect(topicSessionId("files/", "files/")).toBeNull();
    expect(topicSessionId("app", "session/")).toBeNull();
  });
});
