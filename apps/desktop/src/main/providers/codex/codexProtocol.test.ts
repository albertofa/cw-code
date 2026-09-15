import { describe, expect, it } from "vitest";
import {
  approvalResultFor,
  buildCodexUserInput,
  buildCommandApproval,
  buildFileChangeApproval,
  buildPermissionsApproval,
  buildUserInputQuestionRequest,
  codexUserInputResult,
  accumulateCodexUsage,
  mapCodexHistory,
  mapCodexModel,
  mapCodexPlan,
  mapCodexThread,
  mapPermissionMode,
  type CodexThread,
  type CodexTokenUsage
} from "./codexProtocol.js";

describe("mapPermissionMode", () => {
  it("maps bypassPermissions to never approvals with full access", () => {
    expect(mapPermissionMode("bypassPermissions")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      planMode: false
    });
  });

  it("routes auto through the auto reviewer", () => {
    expect(mapPermissionMode("auto")).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write"
    });
  });

  it("maps acceptEdits to supervised workspace-write", () => {
    expect(mapPermissionMode("acceptEdits")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      planMode: false
    });
  });

  it("treats the retired plan mode as untrusted read-only", () => {
    expect(mapPermissionMode("plan" as never)).toMatchObject({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      planMode: false
    });
  });

  it("defaults to untrusted read-only", () => {
    expect(mapPermissionMode(undefined)).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      planMode: false
    });
    expect(mapPermissionMode("manual")).toMatchObject({ approvalPolicy: "untrusted", sandbox: "read-only" });
  });
});

describe("mapCodexThread", () => {
  it("prefers the thread name over the preview and converts timestamps to ms", () => {
    const meta = mapCodexThread(
      { id: "thr_abc", name: "Fix login bug", preview: "first message", createdAt: 10, updatedAt: 20, model: "gpt-6-astra" },
      "p1"
    );
    expect(meta).toMatchObject({
      id: "codex:thr_abc",
      projectId: "p1",
      driver: "codex",
      title: "Fix login bug",
      resumeCursor: "thr_abc",
      createdAt: 10_000,
      updatedAt: 20_000,
      model: "gpt-6-astra"
    });
  });

  it("falls back to the preview then the id", () => {
    expect(mapCodexThread({ id: "thr_1", preview: "hello there" }, "p").title).toBe("hello there");
    expect(mapCodexThread({ id: "thr_12345678" }, "p").title).toBe("thr_1234");
  });
});

describe("mapCodexModel", () => {
  it("uses the display name when present", () => {
    expect(mapCodexModel({ id: "gpt-6-astra", displayName: "GPT-6-Astra" })).toEqual({
      id: "gpt-6-astra",
      label: "GPT-6-Astra",
      source: "live"
    });
    expect(mapCodexModel({ id: "m" }).label).toBe("m");
  });
});

describe("buildCodexUserInput", () => {
  it("wraps the prompt as text and images as local inputs", () => {
    const input = buildCodexUserInput("describe this", "C:\\proj", ["img.png", "notes.md"]);
    expect(input).toEqual([
      { type: "text", text: "describe this" },
      { type: "localImage", path: "C:\\proj\\img.png" }
    ]);
  });

  it("keeps absolute image paths untouched and skips empty prompts", () => {
    const input = buildCodexUserInput("  ", "/tmp/proj", ["/abs/pic.jpg"]);
    expect(input).toEqual([{ type: "localImage", path: "/abs/pic.jpg" }]);
  });

  it("returns an empty list for a bare prompt with no attachments", () => {
    expect(buildCodexUserInput("hi", "C:\\proj", [])).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("mapCodexPlan", () => {
  it("maps step and status, defaulting unknown statuses to pending", () => {
    expect(
      mapCodexPlan([
        { step: "Inspect the repo", status: "completed" },
        { step: "Write the fix", status: "in_progress" },
        { step: "Add tests", status: "queued" },
        { step: "Ship it" }
      ])
    ).toEqual([
      { content: "Inspect the repo", status: "completed" },
      { content: "Write the fix", status: "in_progress" },
      { content: "Add tests", status: "pending" },
      { content: "Ship it", status: "pending" }
    ]);
  });

  it("accepts a { plan: [...] } wrapper", () => {
    expect(mapCodexPlan({ plan: [{ step: "One", status: "pending" }] })).toEqual([
      { content: "One", status: "pending" }
    ]);
  });

  it("returns an empty list for an empty plan", () => {
    expect(mapCodexPlan([])).toEqual([]);
  });

  it("returns null for garbage input", () => {
    expect(mapCodexPlan("nope")).toBeNull();
    expect(mapCodexPlan(null)).toBeNull();
    expect(mapCodexPlan({ plan: "nope" })).toBeNull();
  });
});

describe("mapCodexHistory", () => {
  it("maps user, assistant, command, file change, and MCP items", () => {
    const thread: CodexThread = {
      id: "thr_1",
      turns: [
        {
          id: "turn_1",
          startedAt: 5,
          items: [
            { type: "userMessage", id: "i1", content: [{ type: "text", text: "run the tests" }] },
            {
              type: "commandExecution",
              id: "i2",
              command: "npm test",
              aggregatedOutput: "all passing\n",
              exitCode: 0,
              status: "completed"
            },
            {
              type: "fileChange",
              id: "i3",
              status: "completed",
              changes: [{ path: "src/a.ts", kind: "update", diff: "-old\n+new" }]
            },
            { type: "agentMessage", id: "i4", text: "done" },
            { type: "reasoning", id: "i5" }
          ]
        }
      ]
    };
    const messages = mapCodexHistory(thread);
    expect(messages.map((m) => m.role)).toEqual(["user", "tool", "tool", "tool", "tool", "assistant"]);
    expect(messages[0]).toMatchObject({ text: "run the tests", turnId: "turn_1", timestamp: 5000 });
    expect(messages[1]).toMatchObject({ toolName: "shell", text: "npm test" });
    expect(messages[2]).toMatchObject({ toolName: "shell", text: "all passing", isError: false });
    expect(messages[3]).toMatchObject({ toolName: "edit", text: "edit src/a.ts" });
    expect(messages[4]).toMatchObject({ toolName: "edit", text: "-old\n+new" });
    expect(messages[5]).toMatchObject({ text: "done" });
  });

  it("stamps the last turn item with completedAt so history keeps the duration", () => {
    const thread: CodexThread = {
      id: "thr_1",
      turns: [
        {
          id: "turn_1",
          startedAt: 5,
          completedAt: 65,
          items: [
            { type: "userMessage", id: "i1", content: [{ type: "text", text: "hi" }] },
            { type: "agentMessage", id: "i2", text: "done" }
          ]
        }
      ]
    };
    const messages = mapCodexHistory(thread);
    expect(messages[0].timestamp).toBe(5000);
    expect(messages[1].timestamp).toBe(65_000);
  });

  it("flags failed commands and skips empty outputs", () => {
    const thread: CodexThread = {
      id: "thr_1",
      turns: [
        {
          id: "turn_1",
          items: [
            { type: "commandExecution", id: "c1", command: "oops", aggregatedOutput: "boom", exitCode: 2, status: "completed" },
            { type: "commandExecution", id: "c2", command: "silent", aggregatedOutput: "", exitCode: 0, status: "completed" }
          ]
        }
      ]
    };
    const messages = mapCodexHistory(thread);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({ isError: true, text: "boom" });
  });

  it("maps reasoning items from summary and content without repeating text", () => {
    const thread: CodexThread = {
      id: "thr_1",
      turns: [
        {
          id: "turn_1",
          startedAt: 7,
          items: [
            {
              type: "reasoning",
              id: "i6",
              summary: [{ type: "summary_text", text: "**Planning**" }],
              content: [{ type: "reasoning_text", text: "**Planning**" }]
            },
            {
              type: "reasoning",
              id: "i7",
              summary: [{ type: "summary_text", text: "checking" }],
              content: [{ type: "reasoning_text", text: "reading files" }]
            }
          ]
        }
      ]
    };
    expect(mapCodexHistory(thread)).toEqual([
      { id: "i6", role: "reasoning", text: "**Planning**", turnId: "turn_1", timestamp: 7000 },
      { id: "i7", role: "reasoning", text: "checking\n\nreading files", turnId: "turn_1", timestamp: 7000 }
    ]);
  });
});

describe("approval builders", () => {
  it("builds a command approval from the params", () => {
    const req = buildCommandApproval("r1", {
      threadId: "t",
      turnId: "tn",
      itemId: "i",
      command: "rm -rf /tmp/x",
      cwd: "C:\\proj",
      reason: "needs write access"
    });
    expect(req).toMatchObject({
      requestId: "r1",
      kind: "command",
      title: "rm -rf /tmp/x",
      reason: "needs write access",
      decisions: ["accept", "acceptForSession", "acceptGlobal", "decline", "cancel"]
    });
    expect(req.details).toContain("rm -rf /tmp/x");
  });

  it("builds file change and permissions approvals", () => {
    const file = buildFileChangeApproval("r2", { threadId: "t", turnId: "tn", itemId: "i" });
    expect(file.kind).toBe("fileChange");
    expect(file.title).toBe("Apply file changes");
    expect(file.decisions).toEqual(["accept", "acceptForSession", "acceptGlobal", "decline", "cancel"]);
    const perms = buildPermissionsApproval("r3", {
      threadId: "t",
      turnId: "tn",
      itemId: "i",
      permissions: { network: {} }
    });
    expect(perms.kind).toBe("permissions");
    expect(perms.details).toBe(JSON.stringify({ network: {} }));
    expect(perms.decisions).toEqual(["accept", "acceptForSession", "acceptGlobal", "decline", "cancel"]);
  });
});

describe("approvalResultFor", () => {
  it("echoes the requested permissions with the chosen scope", () => {
    const requested = { network: {} };
    expect(approvalResultFor("permissions", "accept", requested)).toEqual({
      permissions: requested,
      scope: "turn"
    });
    expect(approvalResultFor("permissions", "acceptForSession", requested)).toEqual({
      permissions: requested,
      scope: "session"
    });
    expect(approvalResultFor("permissions", "decline", requested)).toEqual({
      permissions: {},
      scope: "turn"
    });
  });

  it("passes decisions through for command and file changes", () => {
    expect(approvalResultFor("command", "acceptForSession")).toEqual({ decision: "acceptForSession" });
    expect(approvalResultFor("fileChange", "cancel")).toEqual({ decision: "cancel" });
  });

  it("maps acceptGlobal to session semantics on all three kinds", () => {
    const requested = { network: {} };
    expect(approvalResultFor("permissions", "acceptGlobal", requested)).toEqual({
      permissions: requested,
      scope: "session"
    });
    expect(approvalResultFor("command", "acceptGlobal")).toEqual({ decision: "acceptForSession" });
    expect(approvalResultFor("fileChange", "acceptGlobal")).toEqual({ decision: "acceptForSession" });
  });
});

describe("accumulateCodexUsage", () => {
  it("sums input and output across updates", () => {
    const usage = (input: number, cached: number, output: number, reasoning: number): CodexTokenUsage => ({
      total: {
        totalTokens: 0,
        inputTokens: input,
        cachedInputTokens: cached,
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: reasoning
      },
      last: {
        totalTokens: 0,
        inputTokens: input,
        cachedInputTokens: cached,
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: reasoning
      },
      modelContextWindow: null
    });
    const acc = { inputTokens: 0, outputTokens: 0 };
    accumulateCodexUsage(acc, usage(100, 50, 10, 5));
    accumulateCodexUsage(acc, usage(200, 0, 20, 0));
    expect(acc).toEqual({ inputTokens: 350, outputTokens: 35 });
  });
});

describe("codex user input questions", () => {
  const params = {
    questions: [
      { question: "Preferred color?", header: "Color", options: [{ label: "Red", description: "Red" }, { label: "Blue" }], multiSelect: false },
      { question: "Which extras?", options: [{ label: "Lint" }], multiSelect: true },
      "junk",
      { header: "Color", options: [{ label: "Red" }] }
    ]
  };

  it("maps usable questions and drops the rest", () => {
    const request = buildUserInputQuestionRequest("t1:42", "t1", params);
    expect(request).toMatchObject({ requestId: "t1:42", turnId: "t1" });
    expect(request!.questions).toEqual([
      { question: "Preferred color?", header: "Color", options: [{ label: "Red", description: "Red" }, { label: "Blue" }], multiSelect: false, allowCustom: true },
      { question: "Which extras?", options: [{ label: "Lint" }], multiSelect: true, allowCustom: true }
    ]);
  });

  it("returns null when no usable questions exist", () => {
    expect(buildUserInputQuestionRequest("t1:42", "t1", { questions: [] })).toBeNull();
    expect(buildUserInputQuestionRequest("t1:42", "t1", {})).toBeNull();
  });

  it("serializes answers in submission order", () => {
    expect(codexUserInputResult({ "Preferred color?": "Red", "Which extras?": "Lint" })).toEqual({
      answers: ["Red", "Lint"]
    });
  });
});
