import { describe, expect, it } from "bun:test";
import { parseHarnessRequest, parsePreviewRequest, parseRunRequest } from "./workflows.js";

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

  it("passes an explicit retry through and rejects a non-boolean one", () => {
    const base = { workflowId: "review", subject: { kind: "pr", ref }, composerDriver: "claude" };
    expect(parsePreviewRequest({ ...base, retry: true }).retry).toBe(true);
    expect("retry" in parsePreviewRequest({ ...base, retry: false })).toBe(false);
    expect(() => parsePreviewRequest({ ...base, retry: "yes" })).toThrow("retry");
  });

  it("parses a run request with its resume state", () => {
    const base = { workflowId: "review", subject: { kind: "pr", ref }, composerDriver: "claude", prompt: "go", runId: "run_1" };
    expect(parseRunRequest(base)).toMatchObject({ runId: "run_1", prompt: "go", expectedRevision: null, resume: null, continueSessionId: null });
    expect(parseRunRequest({ ...base, expectedRevision: "abc" }).expectedRevision).toBe("abc");
    expect(() => parseRunRequest({ ...base, runId: "" })).toThrow("runId");
    expect(() => parseRunRequest({ ...base, runId: undefined })).toThrow("runId");
    expect(parseRunRequest({ ...base, resume: { sessionId: "sess_1", linked: true, sent: false, note: null } }).resume).toEqual({
      sessionId: "sess_1",
      linked: true,
      sent: false,
      note: null
    });
    expect(() => parseRunRequest({ ...base, prompt: "  " })).toThrow("prompt");
    expect(() => parseRunRequest({ ...base, resume: { sessionId: "sess_1", linked: "yes", sent: false } })).toThrow("resume.linked");
  });
});
