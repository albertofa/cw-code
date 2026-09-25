import { describe, expect, it, vi } from "vitest";
import {
  approvalResultFor,
  buildCodexSkillInput,
  buildCodexUserInput,
  buildCommandApproval,
  buildFileChangeApproval,
  buildPermissionsApproval,
  buildUserInputQuestionRequest,
  codexReviewTarget,
  codexUserInputResult,
  accumulateCodexTurnUsage,
  mapCodexHistory,
  mapCodexModel,
  mapCodexPlan,
  mapCodexSkillCommands,
  mapCodexThread,
  mapPermissionMode,
  type CodexThread,
  type CodexTokenUsage,
  type CodexTurnUsageAcc
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

  it("treats the retired plan mode as supervised read-only", () => {
    expect(mapPermissionMode("plan" as never)).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
      planMode: false
    });
  });

  it("defaults to supervised read-only", () => {
    expect(mapPermissionMode(undefined)).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
      planMode: false
    });
    expect(mapPermissionMode("manual")).toMatchObject({ approvalPolicy: "on-request", sandbox: "read-only" });
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

  it("maps exitedReviewMode as assistant text when the turn has no agentMessage item", () => {
    const thread: CodexThread = {
      id: "thr_1",
      turns: [
        {
          id: "turn_1",
          startedAt: 5,
          items: [{ type: "exitedReviewMode", id: "r1", review: "Looks fine overall." }]
        }
      ]
    };
    expect(mapCodexHistory(thread)).toEqual([
      { id: "r1", role: "assistant", text: "Looks fine overall.", turnId: "turn_1", timestamp: 5000 }
    ]);
  });

  it("drops exitedReviewMode text when the turn already has an agentMessage item", () => {
    const thread: CodexThread = {
      id: "thr_1",
      turns: [
        {
          id: "turn_1",
          startedAt: 5,
          items: [
            { type: "agentMessage", id: "i1", text: "Looks fine overall." },
            { type: "exitedReviewMode", id: "r1", review: "Looks fine overall." }
          ]
        }
      ]
    };
    expect(mapCodexHistory(thread)).toEqual([
      { id: "i1", role: "assistant", text: "Looks fine overall.", turnId: "turn_1", timestamp: 5000 }
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

describe("accumulateCodexTurnUsage", () => {
  function emptyAcc(): CodexTurnUsageAcc {
    return { counts: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 } };
  }

  it("does not double count cached input tokens", () => {
    const acc = emptyAcc();
    const usage: CodexTokenUsage = {
      total: {
        totalTokens: 39934,
        inputTokens: 39846,
        cachedInputTokens: 39424,
        cacheWriteInputTokens: 0,
        outputTokens: 88,
        reasoningOutputTokens: 0
      },
      last: {
        totalTokens: 39934,
        inputTokens: 39846,
        cachedInputTokens: 39424,
        cacheWriteInputTokens: 0,
        outputTokens: 88,
        reasoningOutputTokens: 0
      },
      modelContextWindow: null
    };
    accumulateCodexTurnUsage(acc, usage);
    expect(acc.counts).toEqual({
      inputTokens: 422,
      cacheReadTokens: 39424,
      cacheWriteTokens: 0,
      outputTokens: 88,
      reasoningTokens: 0
    });
  });

  it("ignores a notification whose total is unchanged for the thread", () => {
    const acc = emptyAcc();
    const usage: CodexTokenUsage = {
      total: { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
      last: { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
      modelContextWindow: null
    };
    accumulateCodexTurnUsage(acc, usage);
    accumulateCodexTurnUsage(acc, usage);
    expect(acc.counts).toEqual({ inputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0 });
  });

  it("omits context when the model context window is null", () => {
    const acc = emptyAcc();
    accumulateCodexTurnUsage(acc, {
      total: { totalTokens: 500, inputTokens: 400, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
      last: { totalTokens: 500, inputTokens: 400, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
      modelContextWindow: null
    });
    expect(acc.context).toBeUndefined();
  });

  it("sets context from the last breakdown's total and the model context window", () => {
    const acc = emptyAcc();
    accumulateCodexTurnUsage(acc, {
      total: { totalTokens: 500, inputTokens: 400, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
      last: { totalTokens: 500, inputTokens: 400, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
      modelContextWindow: 128_000
    });
    expect(acc.context).toEqual({ usedTokens: 500, windowTokens: 128_000 });
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

describe("mapCodexSkillCommands", () => {
  it("maps enabled skills and skips disabled ones", () => {
    const res = {
      data: [
        {
          cwd: "C:\\proj",
          skills: [
            { name: "plan", description: "Plan the work", path: "/skills/plan", enabled: true },
            { name: "disabled-skill", description: "Nope", path: "/skills/nope", enabled: false }
          ],
          errors: []
        }
      ]
    };
    const { commands, paths } = mapCodexSkillCommands(res);
    expect(commands).toEqual([
      { name: "plan", description: "Plan the work", dispatch: "native" }
    ]);
    expect(paths.get("plan")).toBe("/skills/plan");
    expect(paths.has("disabled-skill")).toBe(false);
  });

  it("prefers interface.shortDescription, then shortDescription, then description", () => {
    const res = {
      data: [
        {
          cwd: "C:\\proj",
          skills: [
            {
              name: "a",
              description: "Long description",
              shortDescription: "Short a",
              interface: { shortDescription: "Interface a" },
              path: "/skills/a",
              enabled: true
            },
            {
              name: "b",
              description: "Long description",
              shortDescription: "Short b",
              path: "/skills/b",
              enabled: true
            },
            { name: "c", description: "Long description", path: "/skills/c", enabled: true }
          ],
          errors: []
        }
      ]
    };
    const { commands } = mapCodexSkillCommands(res);
    expect(commands.map((c) => c.description)).toEqual(["Interface a", "Short b", "Long description"]);
  });

  it("tolerates missing or garbage fields", () => {
    expect(mapCodexSkillCommands(null)).toEqual({ commands: [], paths: new Map() });
    expect(mapCodexSkillCommands({})).toEqual({ commands: [], paths: new Map() });
    expect(mapCodexSkillCommands({ data: "nope" })).toEqual({ commands: [], paths: new Map() });
    const res = { data: [{ skills: [null, "junk", { name: "", path: "/x", enabled: true }, { name: "x", enabled: true }] }] };
    expect(mapCodexSkillCommands(res)).toEqual({ commands: [], paths: new Map() });
  });

  it("skips skills whose name collides with a built-in command", () => {
    const res = {
      data: [
        {
          cwd: "C:\\proj",
          skills: [
            { name: "compact", description: "Custom compact", path: "/skills/compact", enabled: true },
            { name: "review", description: "Custom review", path: "/skills/review", enabled: true },
            { name: "plan", description: "Plan the work", path: "/skills/plan", enabled: true }
          ],
          errors: []
        }
      ]
    };
    const { commands, paths } = mapCodexSkillCommands(res);
    expect(commands.map((c) => c.name)).toEqual(["plan"]);
    expect(paths.has("compact")).toBe(false);
    expect(paths.has("review")).toBe(false);
  });

  it("warns for each reported skill error without dropping the working skills", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = {
      data: [
        {
          cwd: "C:\\proj",
          skills: [{ name: "plan", description: "Plan the work", path: "/skills/plan", enabled: true }],
          errors: [{ path: "/skills/broken", message: "invalid frontmatter" }]
        }
      ]
    };
    const { commands } = mapCodexSkillCommands(res);
    expect(commands.map((c) => c.name)).toEqual(["plan"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/skills/broken"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid frontmatter"));
    warn.mockRestore();
  });
});

describe("codexReviewTarget", () => {
  it("targets uncommitted changes when args are empty", () => {
    expect(codexReviewTarget("")).toEqual({ type: "uncommittedChanges" });
    expect(codexReviewTarget("   ")).toEqual({ type: "uncommittedChanges" });
  });

  it("targets custom instructions when args are given", () => {
    expect(codexReviewTarget("  check for race conditions  ")).toEqual({
      type: "custom",
      instructions: "check for race conditions"
    });
  });
});

describe("buildCodexSkillInput", () => {
  it("builds a mention-prefixed text item plus a skill item, trimming args", () => {
    expect(buildCodexSkillInput("plan", "/skills/plan", "  the migration  ")).toEqual([
      { type: "text", text: "$plan the migration" },
      { type: "skill", name: "plan", path: "/skills/plan" }
    ]);
  });

  it("omits args from the text when none are given", () => {
    expect(buildCodexSkillInput("plan", "/skills/plan", "")).toEqual([
      { type: "text", text: "$plan" },
      { type: "skill", name: "plan", path: "/skills/plan" }
    ]);
  });
});
