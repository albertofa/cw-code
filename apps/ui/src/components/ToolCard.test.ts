import { describe, expect, it } from "bun:test";
import {
  countShellCommands,
  describeToolCall,
  describeWaitingTools,
  extractCommandFragment,
  extractFileDiff,
  extractFileDiffFromText,
  extractFileFragment,
  extractPatchFiles,
  formatDuration,
  formatToolDuration,
  orderToolsForDisplay,
  pendingToolsForTurn,
  recoverToolInput,
  relativizeInText,
  relativizeToBase,
  stripToolNamePrefix,
  summarizeToolGroup,
  toolSpanMs
} from "./toolSummaries.js";
import type { ChatMessage } from "../stores/appStore.js";

function msg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: "tool", text: "", turnId: "t1", seq: 0, ...partial };
}

describe("describeToolCall", () => {
  it("summarizes Write with line counts", () => {
    const s = describeToolCall("Write", { file_path: "a/b.ts", content: "one\ntwo\nthree" });
    expect(s?.verb).toBe("Write");
    expect(s?.subject).toBe("a/b.ts");
    expect(s?.stat).toEqual({ added: 3, removed: 0 });
  });

  it("summarizes Edit with added/removed lines across naming conventions", () => {
    const claude = describeToolCall("Edit", { file_path: "x.ts", old_string: "a\nb", new_string: "c" });
    expect(claude?.stat).toEqual({ added: 1, removed: 2 });
    const oc = describeToolCall("edit", { filePath: "x.ts", oldString: "a", newString: "b\nc\nd" });
    expect(oc?.verb).toBe("Edit");
    expect(oc?.stat).toEqual({ added: 3, removed: 1 });
  });

  it("uses the full Bash command and counts compound statements", () => {
    const cmd = `git grep -n "a;b" -- .; git checkout -q --detach origin/master && dotnet test`;
    const s = describeToolCall("Bash", { command: cmd, description: "run it" });
    expect(s?.verb).toBe("Bash");
    expect(s?.subject).toBe(cmd);
    expect(s?.fullSubject).toBe(cmd);
    expect(s?.commandCount).toBe(3);
    expect(s?.meta).toBeUndefined();
  });

  it("counts multi-line shell commands and keeps the original for details", () => {
    const cmd = "git status\ngit log";
    const s = describeToolCall("shell", { command: cmd, description: "inspect" });
    expect(s?.subject).toBe("git status git log");
    expect(s?.fullSubject).toBe(cmd);
    expect(s?.commandCount).toBe(2);
    expect(s?.meta).toBeUndefined();
  });

  it("does not badge a single shell command", () => {
    const s = describeToolCall("Bash", { command: "pnpm test", description: "run tests" });
    expect(s?.subject).toBe("pnpm test");
    expect(s?.fullSubject).toBe("pnpm test");
    expect(s?.commandCount).toBeUndefined();
    expect(s?.meta).toBeUndefined();
  });

  it("summarizes Skill, Task and Todos", () => {
    expect(describeToolCall("Skill", { skill: "writing-skills" })?.subject).toBe("writing-skills");
    expect(describeToolCall("task", { description: "Verify skill" })?.verb).toBe("Task");
    const todos = describeToolCall("TodoWrite", {
      todos: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }]
    });
    expect(todos?.subject).toBe("1/3 done");
  });

  it("returns null for unknown tools", () => {
    expect(describeToolCall("MysteryTool", { foo: 1 })).toBe(null);
    expect(describeToolCall("MysteryTool", null)).toBe(null);
  });

  it("renders Bash and Shell under their own names with the same icon", () => {
    const bash = describeToolCall("Bash", null);
    const shell = describeToolCall("shell", "not-an-object");
    expect(bash?.verb).toBe("Bash");
    expect(shell?.verb).toBe("Shell");
    expect(shell?.Icon).toBe(bash?.Icon);
  });

  it("summarizes Glob with pattern and path", () => {
    expect(describeToolCall("glob", { pattern: "**/*.ts" })?.subject).toBe("**/*.ts");
    const both = describeToolCall("glob", { pattern: "**/*.ts", path: "src" });
    expect(both?.subject).toBe("**/*.ts");
    expect(both?.meta).toEqual(["in src"]);
    expect(describeToolCall("glob", { path: "src" })?.subject).toBe("src");
  });

  it("summarizes Grep with pattern, path and include", () => {
    const s = describeToolCall("grep", { pattern: "foo.*", path: "src", include: "*.ts" });
    expect(s?.subject).toBe("foo.*");
    expect(s?.meta).toEqual(["in src", "*.ts"]);
    expect(describeToolCall("grep", { regex: "bar" })?.subject).toBe("bar");
  });

  it("summarizes Skill by name", () => {
    expect(describeToolCall("skill", { name: "plan" })?.subject).toBe("plan");
    expect(describeToolCall("skill", { skill: "writing-skills" })?.subject).toBe("writing-skills");
  });

  it("unwraps legacy wrapped state input", () => {
    const wrapped = { status: "completed", input: { pattern: "**/*.ts" }, output: "x" };
    expect(describeToolCall("glob", wrapped)?.subject).toBe("**/*.ts");
    const grepWrapped = { status: "running", input: { pattern: "foo", path: "src" } };
    expect(describeToolCall("grep", grepWrapped)?.subject).toBe("foo");
    const skillWrapped = { status: "completed", input: { name: "plan" }, output: "y" };
    expect(describeToolCall("skill", skillWrapped)?.subject).toBe("plan");
  });
  it("summarizes opencode apply_patch with the first file", () => {
    const patch = "*** Begin Patch\n*** Update File: C:\\Projects\\app\\a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n@@\n+z\n";
    expect(extractPatchFiles(patch)).toEqual(["C:\\Projects\\app\\a.ts", "src/b.ts"]);
    const s = describeToolCall("apply_patch", { patchText: patch });
    expect(s?.verb).toBe("Patch");
    expect(s?.subject).toBe("C:\\Projects\\app\\a.ts");
    expect(s?.subjectKind).toBe("file");
    expect(s?.meta).toEqual(["2 files"]);
    expect(relativizeToBase("C:\\Projects\\app", s?.subject ?? "")).toBe("a.ts");
  });

  it("summarizes opencode question tools", () => {
    const s = describeToolCall("question", {
      questions: [
        { header: "Scope", question: "Include the release notes?", options: [] },
        { header: "Other", question: "Second?", options: [] }
      ]
    });
    expect(s?.verb).toBe("Question");
    expect(s?.subject).toBe("Asked 2 questions");
  });
});

describe("countShellCommands", () => {
  it("ignores separators inside quotes and counts top-level operators", () => {
    expect(countShellCommands('git grep "a;b" -- .')).toBe(1);
    expect(countShellCommands("a && b || c")).toBe(3);
    expect(countShellCommands("a; b\nc")).toBe(3);
    expect(countShellCommands("a\\;b")).toBe(1);
    expect(countShellCommands("echo $(git status; git log)")).toBe(1);
    expect(countShellCommands("echo `git status; git log`")).toBe(1);
  });

  it("counts the review test-merge chain as six commands", () => {
    const command =
      "git grep x; git checkout y && git merge z && git status | head && dotnet build a && dotnet test b";
    expect(countShellCommands(command)).toBe(6);
  });
});

describe("extractFileDiff", () => {
  it("maps Write content to added lines", () => {
    expect(extractFileDiff("Write", { file_path: "a.ts", content: "one\ntwo\nthree" })).toEqual([
      { type: "add", text: "one" },
      { type: "add", text: "two" },
      { type: "add", text: "three" }
    ]);
  });

  it("maps Edit old/new strings to removed then added lines", () => {
    expect(extractFileDiff("Edit", { file_path: "x.ts", old_string: "a\nb", new_string: "c" })).toEqual([
      { type: "del", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "c" }
    ]);
    expect(extractFileDiff("edit", { filePath: "x.ts", oldString: "a", newString: "b\nc" })).toEqual([
      { type: "del", text: "a" },
      { type: "add", text: "b" },
      { type: "add", text: "c" }
    ]);
  });

  it("flattens MultiEdit edits arrays", () => {
    expect(
      extractFileDiff("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { oldString: "c", newString: "d\ne" }] })
    ).toEqual([
      { type: "del", text: "a" },
      { type: "add", text: "b" },
      { type: "del", text: "c" },
      { type: "add", text: "d" },
      { type: "add", text: "e" }
    ]);
  });

  it("returns null for other tools and empty inputs", () => {
    expect(extractFileDiff("Bash", { command: "ls" })).toBeNull();
    expect(extractFileDiff("Write", { file_path: "a.ts" })).toBeNull();
    expect(extractFileDiff("Edit", { file_path: "a.ts" })).toBeNull();
    expect(extractFileDiff("Write", null)).toBeNull();
  });

  it("recovers diff lines from truncated history text", () => {
    expect(extractFileDiffFromText("Write", 'Write {"file_path":"a.ts","content":"one\\ntwo"}')).toEqual([
      { type: "add", text: "one" },
      { type: "add", text: "two" }
    ]);
    expect(
      extractFileDiffFromText("Edit", 'Edit {"file_path":"x.ts","old_string":"a\\nb","new_string":"c"}')
    ).toEqual([
      { type: "del", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "c" }
    ]);
    expect(extractFileDiffFromText("Bash", 'Bash {"command":"ls"}')).toBeNull();
  });
});

describe("recoverToolInput / stripToolNamePrefix", () => {
  it("recovers structured input from Name {json} text", () => {
    expect(recoverToolInput("Bash", 'Bash {"command":"cd /x && ls"}')).toEqual({ command: "cd /x && ls" });
  });

  it("returns undefined for truncated or non-JSON text", () => {
    expect(recoverToolInput("Bash", 'Bash {"command":"cd /x')).toBeUndefined();
    expect(recoverToolInput("Bash", "just some output")).toBeUndefined();
  });

  it("strips a duplicated leading tool name", () => {
    expect(stripToolNamePrefix("Bash", 'Bash {"command":"ls"}')).toBe('{"command":"ls"}');
    expect(stripToolNamePrefix("Bash", "Bashful output")).toBe("Bashful output");
  });

  it("extracts commands from truncated JSON", () => {
    expect(extractCommandFragment('Bash {"command":"cd /x && ls')).toBe("cd /x && ls");
    expect(extractCommandFragment('Bash {"command":"echo \\"hi\\" && pwd')).toBe('echo "hi" && pwd');
    expect(extractCommandFragment("Bash no json here")).toBeUndefined();
  });

  it("extracts file paths from truncated JSON", () => {
    expect(extractFileFragment('Write {"file_path":"C:\\a\\b.ts","content":"x')).toBe("C:\\a\\b.ts");
    expect(extractFileFragment('Edit {"filePath":"src/a.ts"')).toBe("src/a.ts");
    expect(extractFileFragment("Write no json here")).toBeUndefined();
  });
});

describe("relativizeToBase", () => {
  it("strips the project base path", () => {
    expect(relativizeToBase("C:\\Projects\\app", "C:\\Projects\\app\\src\\a.ts")).toBe("src/a.ts");
    expect(relativizeToBase("C:/Projects/app/", "C:/Projects/app/src/a.ts")).toBe("src/a.ts");
    expect(relativizeToBase("C:\\Projects\\app", "C:\\Projects\\APP\\src\\a.ts")).toBe("src/a.ts");
  });

  it("leaves outside paths untouched", () => {
    expect(relativizeToBase("C:\\Projects\\app", "C:\\Other\\a.ts")).toBe("C:\\Other\\a.ts");
    expect(relativizeToBase("C:\\Projects\\app", "C:\\Projects\\app2\\a.ts")).toBe("C:\\Projects\\app2\\a.ts");
  });
});

describe("relativizeInText", () => {
  it("replaces base path occurrences with a dot", () => {
    expect(relativizeInText("C:\\Projects\\app", "cd C:\\Projects\\app && ls")).toBe("cd . && ls");
    expect(relativizeInText("C:/Projects/app", "cd C:\\Projects\\app\\src && ls")).toBe("cd ./src && ls");
    expect(relativizeInText("C:\\Projects\\app", "cd C:\\PROJECTS\\APP && ls")).toBe("cd . && ls");
  });

  it("respects word boundaries and leaves other text untouched", () => {
    expect(relativizeInText("C:\\Projects\\app", "cd C:\\Projects\\app2 && ls")).toBe("cd C:/Projects/app2 && ls");
    expect(relativizeInText("C:\\Projects\\app", "echo hi")).toBe("echo hi");
  });
});

describe("orderToolsForDisplay", () => {
  const tool = (id: string, state: "done" | "running" | "unknown"): ChatMessage =>
    msg({
      id,
      toolName: "Bash",
      text: id,
      ...(state === "done"
        ? { toolInput: { command: id }, toolOutput: "out" }
        : state === "running"
          ? { toolInput: { command: id } }
          : {})
    });

  it("moves running cards after completed ones within a consecutive run", () => {
    const user = msg({ id: "u", role: "user", text: "hi" });
    const ordered = orderToolsForDisplay([
      tool("first", "done"),
      tool("second", "running"),
      tool("third", "done"),
      tool("fourth", "running"),
      user
    ]);
    expect(ordered.map((m) => m.id)).toEqual(["first", "third", "second", "fourth", "u"]);
  });

  it("does not reorder across text messages", () => {
    const ordered = orderToolsForDisplay([
      tool("a", "running"),
      msg({ id: "t", role: "assistant", text: "text" }),
      tool("b", "done")
    ]);
    expect(ordered.map((m) => m.id)).toEqual(["a", "t", "b"]);
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(3000)).toBe("3s");
    expect(formatDuration(806000)).toBe("13m 26s");
    expect(formatDuration(3723000)).toBe("1h 2m 3s");
  });
});

describe("formatToolDuration", () => {
  it("shows tenths under ten seconds and falls back to formatDuration above", () => {
    expect(formatToolDuration(20)).toBe("0.1s");
    expect(formatToolDuration(340)).toBe("0.3s");
    expect(formatToolDuration(3800)).toBe("3.8s");
    expect(formatToolDuration(806000)).toBe("13m 26s");
  });
});

describe("toolSpanMs", () => {
  it("spans the earliest start to the latest completion", () => {
    expect(
      toolSpanMs([
        { toolStartedAt: 1000, toolCompletedAt: 1500 },
        { toolStartedAt: 1200, toolCompletedAt: 4000 }
      ])
    ).toBe(3000);
  });

  it("ignores tools without both timestamps or with inverted ones", () => {
    expect(toolSpanMs([{ toolStartedAt: 1000 }, { toolStartedAt: 5000, toolCompletedAt: 4000 }])).toBeUndefined();
    expect(toolSpanMs([{ toolStartedAt: 1000 }, { toolStartedAt: 2000, toolCompletedAt: 2300 }])).toBe(300);
  });
});

describe("summarizeToolGroup", () => {
  const done = (toolName: string): ChatMessage =>
    msg({ id: `${toolName}-${Math.random()}`, toolName, text: toolName, toolInput: {}, toolOutput: "out", toolDone: true });

  it("counts commands with Ran prefix", () => {
    const s = summarizeToolGroup([done("Bash"), done("shell")]);
    expect(s?.text).toBe("Ran 2 commands");
    expect(s?.status).toBe("complete");
    expect(s?.hasRunning).toBe(false);
  });

  it("combines reads and commands in first-appearance order", () => {
    const s = summarizeToolGroup([done("Read"), done("Read"), done("Bash")]);
    expect(s?.text).toBe("Read 2 files, ran 1 command");
  });

  it("uses present tense while running", () => {
    const running = msg({ id: "r1", toolName: "Bash", text: "x", toolInput: { command: "ls" } });
    const s = summarizeToolGroup([done("Read"), running]);
    expect(s?.text).toBe("Reading 1 file, running 1 command");
    expect(s?.status).toBe("running");
    expect(s?.hasRunning).toBe(true);
  });

  it("reports errors", () => {
    const err = msg({ id: "e1", toolName: "Bash", text: "x", toolInput: {}, toolOutput: "nope", toolDone: true, isError: true });
    const s = summarizeToolGroup([done("Read"), err]);
    expect(s?.status).toBe("error");
  });

  it("returns null for empty groups", () => {
    expect(summarizeToolGroup([])).toBe(null);
  });
});

describe("pendingToolsForTurn", () => {
  it("lists running tools for the turn with their start times", () => {
    const messages = [
      msg({ id: "c1", turnId: "t1", toolName: "Bash", toolInput: { command: "sleep 600" }, toolStartedAt: 1000 }),
      msg({ id: "c2", turnId: "t1", toolName: "Read", toolInput: { path: "a.ts" }, timestamp: 2000 }),
      msg({ id: "c3", turnId: "t2", toolName: "Bash", toolInput: { command: "ls" }, toolStartedAt: 3000 })
    ];
    expect(pendingToolsForTurn(messages, "t1")).toEqual([
      { id: "c1", name: "Bash", startedAt: 1000 },
      { id: "c2", name: "Read", startedAt: 2000 }
    ]);
  });

  it("excludes completed tools and calls without input", () => {
    const messages = [
      msg({ id: "done", toolName: "Bash", toolInput: { command: "ls" }, toolOutput: "out" }),
      msg({ id: "flag", toolName: "Bash", toolInput: { command: "ls" }, toolDone: true }),
      msg({ id: "noinput", toolName: "Bash", toolStartedAt: 1000 }),
      msg({ id: "unnamed", toolInput: { command: "ls" }, toolStartedAt: 1000 })
    ];
    expect(pendingToolsForTurn(messages, "t1")).toEqual([{ id: "unnamed", name: "tool", startedAt: 1000 }]);
  });
});

describe("describeWaitingTools", () => {
  it("returns undefined when nothing is pending", () => {
    expect(describeWaitingTools([], 90000)).toBeUndefined();
  });

  it("names pending tools with elapsed times and caps the list", () => {
    const tools = [
      { id: "a", name: "Bash", startedAt: 1000 },
      { id: "b", name: "Bash", startedAt: 2000 },
      { id: "c", name: "Read", startedAt: 3000 },
      { id: "d", name: "Grep", startedAt: 4000 }
    ];
    expect(describeWaitingTools(tools, 301000)).toBe("waiting on Bash (5m 0s), Bash (4m 59s), Read (4m 58s) +1 more");
  });

  it("falls back to the turn start and then to bare names", () => {
    expect(describeWaitingTools([{ id: "a", name: "Bash" }], 61000, 1000)).toBe("waiting on Bash (1m 0s)");
    expect(describeWaitingTools([{ id: "a", name: "Bash" }], 61000)).toBe("waiting on Bash");
  });
});
