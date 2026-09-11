import { describe, expect, it } from "vitest";
import {
  attributeClaudeSubagentEvent,
  buildClaudeAllowRule,
  claudeAllowResponse,
  claudeApprovalRequest,
  claudeControlResponse,
  claudeDenyResponse,
  claudeQuestionRequest,
  parseClaudeControlRequest,
  parseStreamLine
} from "./claudeStreamParser.js";

describe("parseStreamLine", () => {
  it("maps text deltas to assistant.delta", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "hello " } }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "assistant.delta", turnId: "t1", text: "hello " }
    ]);
  });

  it("maps assistant tool_use blocks to tool.call", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: { path: "a.ts" } }] }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "tool.call", turnId: "t1", toolCallId: "tu1", name: "Read", input: { path: "a.ts" } }
    ]);
  });

  it("maps user tool results to tool.result", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ tool_use_id: "tu1", content: "file contents" }] }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "tool.result", turnId: "t1", toolCallId: "tu1", output: "file contents", isError: false }
    ]);
  });

  it("emits turn metadata on result", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "sess-1",
      total_cost_usd: 0.02,
      usage: { input_tokens: 100, output_tokens: 20 },
      num_turns: 2,
      is_error: false
    });
    let captured: Parameters<Parameters<typeof parseStreamLine>[3]>[0] | null = null;
    const events = parseStreamLine(line, "t1", "s1", (info) => {
      captured = info;
    });
    expect(events).toEqual([]);
    expect(captured).toEqual({
      resumeCursor: "sess-1",
      resultText: "done",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.02,
      numTurns: 2,
      isError: false
    });
  });

  it("passes through non-JSON lines as text", () => {
    expect(parseStreamLine("plain text", "t1", "s1", () => {})).toEqual([
      { type: "assistant.delta", turnId: "t1", text: "plain text" }
    ]);
  });
});

describe("attributeClaudeSubagentEvent", () => {
  it("links SendMessage calls after a Task launch result", () => {
    const agentByCall = new Map<string, string>();
    attributeClaudeSubagentEvent(
      {
        type: "tool.result",
        turnId: "t1",
        toolCallId: "task-call",
        output: "Async agent launched successfully.\nagentId: a202cd0fd545a319e",
        isError: false
      },
      agentByCall
    );
    expect(
      attributeClaudeSubagentEvent(
        {
          type: "tool.call",
          turnId: "t1",
          toolCallId: "send-call",
          name: "SendMessage",
          input: { to: "a202cd0fd545a319e", message: "Check this" }
        },
        agentByCall
      )
    ).toEqual({
      type: "tool.call",
      turnId: "t1",
      toolCallId: "send-call",
      name: "SendMessage",
      input: { to: "a202cd0fd545a319e", message: "Check this" },
      parentToolCallId: "task-call"
    });
  });

  it("leaves unrelated and unknown-recipient calls unchanged", () => {
    const agentByCall = new Map([["task-call", "a202cd0fd545a319e"]]);
    const read = {
      type: "tool.call" as const,
      turnId: "t1",
      toolCallId: "read-call",
      name: "Read",
      input: { path: "a.ts" }
    };
    const send = {
      type: "tool.call" as const,
      turnId: "t1",
      toolCallId: "send-call",
      name: "SendMessage",
      input: { to: "unknown" }
    };
    expect(attributeClaudeSubagentEvent(read, agentByCall)).toBe(read);
    expect(attributeClaudeSubagentEvent(send, agentByCall)).toBe(send);
  });
});

describe("parseClaudeControlRequest", () => {
  const requestLine = (
    tool_name: string,
    questions: unknown,
    request_id = "req-1"
  ): string =>
    JSON.stringify({
      type: "control_request",
      request_id,
      request: { subtype: "can_use_tool", tool_name, input: { questions }, tool_use_id: "tu-9" }
    });

  it("parses a can_use_tool control request for AskUserQuestion", () => {
    const control = parseClaudeControlRequest(
      requestLine("AskUserQuestion", [
        {
          question: "Preferred color?",
          header: "Color",
          options: [
            { label: "Red", description: "Red" },
            { label: "Blue", description: "Blue" }
          ],
          multiSelect: false
        }
      ])
    );
    expect(control).not.toBeNull();
    expect(control!.requestId).toBe("req-1");
    expect(control!.toolName).toBe("AskUserQuestion");
    expect(control!.toolUseId).toBe("tu-9");
  });

  it("parses control requests from other tools but maps none of them to questions", () => {
    expect(parseClaudeControlRequest(requestLine("Bash", []))).toMatchObject({ requestId: "req-1", toolName: "Bash" });
    expect(parseClaudeControlRequest("not json")).toBeNull();
    expect(
      parseClaudeControlRequest(JSON.stringify({ type: "control_request", request_id: "req-1", request: { subtype: "other", tool_name: "AskUserQuestion" } }))
    ).toBeNull();
    expect(parseClaudeControlRequest(JSON.stringify({ type: "control_request" }))).toBeNull();
  });

  it("maps a control request onto the renderer QuestionRequest", () => {
    const control = parseClaudeControlRequest(
      requestLine("AskUserQuestion", [
        { question: "Preferred color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false },
        { question: "Which extras?", options: [{ label: "Lint" }, { label: "Docs" }], multiSelect: true }
      ])
    );
    expect(control).not.toBeNull();
    const request = claudeQuestionRequest(control!, "t1");
    expect(request).toEqual({
      requestId: "req-1",
      turnId: "t1",
      questions: [
        { question: "Preferred color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false, allowCustom: true },
        { question: "Which extras?", options: [{ label: "Lint" }, { label: "Docs" }], multiSelect: true, allowCustom: true }
      ]
    });
  });

  it("drops entries missing question text, keeps empty option lists", () => {
    const control = parseClaudeControlRequest(
      requestLine("AskUserQuestion", [{ question: "ok?", options: [] }, "junk", { header: "Color", options: [{ label: "Red" }] }])
    );
    expect(control).not.toBeNull();
    const request = claudeQuestionRequest(control!, "t1");
    expect(request?.questions.map((q) => q.question)).toEqual(["ok?"]);
    expect(request?.questions[0].options).toEqual([]);
  });
});

describe("claudeControlResponse", () => {
  it("serializes the answers over the original questions", () => {
    const questions = [{ question: "Preferred color?", options: [{ label: "Red" }, { label: "Blue" }] }];
    const line = claudeControlResponse("req-1", { questions }, { "Preferred color?": "Red" });
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: { questions, answers: { "Preferred color?": "Red" } } }
      }
    });
  });

  it("serializes deny responses", () => {
    const parsed = JSON.parse(claudeDenyResponse("req-2", "denied"));
    expect(parsed.response.request_id).toBe("req-2");
    expect(parsed.response.response).toEqual({ behavior: "deny", message: "denied" });
  });
});

describe("claudeApprovalRequest", () => {
  it("maps Bash to a command approval with first-line title and full command details", () => {
    const request = claudeApprovalRequest(
      { requestId: "req-bash", toolName: "Bash", input: { command: "npm run test\nnpm run lint" } },
      "t1",
      "/repo"
    );
    expect(request).toMatchObject({
      requestId: "req-bash",
      kind: "command",
      title: "npm run test",
      toolName: "Bash",
      cwd: "/repo",
      decisions: ["accept", "acceptForSession", "acceptGlobal", "decline", "cancel"]
    });
    expect(request.details).toContain("npm run test\nnpm run lint");
    expect(request.details).toContain("cwd: /repo");
  });

  it("maps PowerShell case-insensitively to a command approval", () => {
    const request = claudeApprovalRequest(
      { requestId: "req-ps", toolName: "powershell", input: { command: "Get-ChildItem" } },
      "t1"
    );
    expect(request.kind).toBe("command");
    expect(request.title).toBe("Get-ChildItem");
  });

  it("maps Edit/Write/MultiEdit to fileChange approvals naming the file", () => {
    for (const toolName of ["Edit", "Write", "MultiEdit"]) {
      const request = claudeApprovalRequest(
        { requestId: `req-${toolName}`, toolName, input: { file_path: "src/a.ts" } },
        "t1"
      );
      expect(request.kind).toBe("fileChange");
      expect(request.title).toContain("src/a.ts");
      expect(request.decisions).toEqual(["accept", "acceptForSession", "acceptGlobal", "decline", "cancel"]);
    }
  });

  it("maps unknown tools to permissions approvals with truncated JSON details", () => {
    const request = claudeApprovalRequest(
      { requestId: "req-web", toolName: "WebFetch", input: { url: "https://example.com", prompt: "summarize" } },
      "t1"
    );
    expect(request.kind).toBe("permissions");
    expect(request.title).toBe("WebFetch");
    expect(request.details).toContain("https://example.com");
  });

  it("tolerates missing input and unknown tools without crashing", () => {
    expect(claudeApprovalRequest({ requestId: "r1", toolName: "Bash", input: null }, "t1").kind).toBe("command");
    expect(claudeApprovalRequest({ requestId: "r2", toolName: "Bash", input: null }, "t1").title).toBe("Bash");
    expect(
      claudeApprovalRequest({ requestId: "r3", toolName: "SomeFutureTool", input: null }, "t1")
    ).toMatchObject({ kind: "permissions", title: "SomeFutureTool" });
    expect(
      claudeApprovalRequest({ requestId: "r4", toolName: "Edit", input: { nonsense: true } }, "t1").title
    ).toBe("Edit");
  });

  it("truncates very long details", () => {
    const request = claudeApprovalRequest(
      { requestId: "r5", toolName: "Bash", input: { command: `echo hi\n${"x".repeat(5000)}` } },
      "t1"
    );
    expect(request.details!.length).toBeLessThan(5000);
    expect(request.details).toContain("[len=");
  });
});

describe("claudeAllowResponse", () => {
  it("serializes an allow carrying the original input", () => {
    const input = { command: "npm run test" };
    const parsed = JSON.parse(claudeAllowResponse("req-1", input));
    expect(parsed).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: input }
      }
    });
  });

  it("falls back to an empty object for missing input", () => {
    const parsed = JSON.parse(claudeAllowResponse("req-1", null));
    expect(parsed.response.response).toEqual({ behavior: "allow", updatedInput: {} });
  });
});

describe("buildClaudeAllowRule", () => {
  it("returns the bare tool name regardless of input", () => {
    expect(buildClaudeAllowRule("Bash", { command: "rm -rf /" })).toBe("Bash");
    expect(buildClaudeAllowRule("Edit", { file_path: "src/a.ts" })).toBe("Edit");
    expect(buildClaudeAllowRule("  Read  ", null)).toBe("Read");
  });
});
