import { describe, expect, it } from "bun:test";
import { parseHarnessRequest, parsePreviewRequest } from "./workflows.js";

const ref = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };

describe("workflow request parsing", () => {
  it("normalizes a preview request", () => {
    expect(
      parsePreviewRequest({
        workflowId: "review",
        subject: { kind: "pr", ref: { ...ref, extra: true } },
        composerDriver: "codex",
        pendingPrefs: { effort: "high", permissionMode: "nope", model: "gpt" }
      })
    ).toEqual({
      workflowId: "review",
      subject: { kind: "pr", ref },
      continueSessionId: null,
      workspace: null,
      promptOverride: null,
      composerDriver: "codex",
      pendingPrefs: { effort: "high", model: "gpt" }
    });
  });

  it("rejects unknown subjects, drivers and workspaces", () => {
    const base = { workflowId: "review", subject: { kind: "pr", ref }, composerDriver: "claude" };
    expect(() => parsePreviewRequest({ ...base, subject: { kind: "repo", ref } })).toThrow("subject kind");
    expect(() => parsePreviewRequest({ ...base, composerDriver: "gemini" })).toThrow("composerDriver");
    expect(() => parsePreviewRequest({ ...base, workspace: "elsewhere" })).toThrow("workspace");
  });

  it("sanitizes the harness config", () => {
    expect(parseHarnessRequest({ config: { driver: "claude", model: " opus ", effort: "huge" }, composerDriver: "claude" })).toEqual({
      config: { driver: "claude", model: "opus", effort: null, permissionMode: null },
      composerDriver: "claude",
      pendingPrefs: {},
      projectId: null
    });
  });
});
