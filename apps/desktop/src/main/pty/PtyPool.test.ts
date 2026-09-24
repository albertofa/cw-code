import { describe, expect, it } from "vitest";
import { buildResumeArgs } from "./PtyPool.js";

describe("buildResumeArgs", () => {
  it("resumes claude sessions with --resume", () => {
    expect(buildResumeArgs("claude", "sess-1")).toEqual(["--resume", "sess-1"]);
  });

  it("resumes opencode sessions with --session", () => {
    expect(buildResumeArgs("opencode", "ses_1")).toEqual(["--session", "ses_1"]);
  });

  it("resumes codex sessions with the resume subcommand", () => {
    expect(buildResumeArgs("codex", "thread-1")).toEqual(["resume", "thread-1"]);
  });

  it("never resumes shell sessions", () => {
    expect(buildResumeArgs("shell", "sess-1")).toEqual([]);
  });

  it("adds no args when there is no cursor", () => {
    expect(buildResumeArgs("claude", "")).toEqual([]);
    expect(buildResumeArgs("opencode", "")).toEqual([]);
    expect(buildResumeArgs("codex", "")).toEqual([]);
  });
});
