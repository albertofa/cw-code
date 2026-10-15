import { describe, expect, it } from "vitest";
import { assertIssueRef } from "./githubRefs.js";

const valid = { host: "github.com", owner: "acme", repo: "widgets", number: 7 };

describe("assertIssueRef", () => {
  it("accepts a valid ref", () => {
    expect(() => assertIssueRef(valid)).not.toThrow();
  });

  it("rejects a bad number with an issue-specific message", () => {
    expect(() => assertIssueRef({ ...valid, number: 0 })).toThrow("issue number");
    expect(() => assertIssueRef({ ...valid, number: 1.5 })).toThrow("issue number");
    expect(() => assertIssueRef({ ...valid, number: "@file" })).toThrow("issue number");
    expect(() => assertIssueRef({ ...valid, number: undefined })).toThrow("issue number");
  });

  it("rejects a bad host, owner, repo or non-object", () => {
    expect(() => assertIssueRef({ ...valid, host: "example.com" })).toThrow();
    expect(() => assertIssueRef({ ...valid, owner: "acme/evil" })).toThrow();
    expect(() => assertIssueRef({ ...valid, repo: ".." })).toThrow();
    expect(() => assertIssueRef(null)).toThrow();
  });
});
