import { describe, expect, it } from "vitest";
import {
  describeToolCall,
  extractCommandFragment,
  extractFileFragment,
  formatDuration,
  mergeToolPairs,
  orderToolsForDisplay,
  recoverToolInput,
  relativizeInText,
  relativizeToBase,
  stripToolNamePrefix
} from "./toolSummaries.js";
import type { ChatMessage } from "../stores/appStore.js";

function msg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: "tool", text: "", turnId: "t1", ...partial };
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

  it("abbreviates Bash commands and keeps the full command for details", () => {
    const cmd = `cd C:/x && ${"y".repeat(200)}`;
    const s = describeToolCall("Bash", { command: cmd, description: "run it" });
    expect(s?.verb).toBe("Bash");
    expect(s?.subject?.length).toBeLessThanOrEqual(90);
    expect(s?.fullSubject).toBe(cmd);
    expect(s?.meta).toEqual(["run it"]);
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
});

describe("mergeToolPairs", () => {
  it("folds -r result messages into their call", () => {
    const merged = mergeToolPairs([
      msg({ id: "c1", toolName: "Read", text: "call" }),
      msg({ id: "c1-r", toolName: "Read", text: "file contents" }),
      msg({ id: "c2", toolName: "Bash", text: "call" })
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].toolOutput).toBe("file contents");
    expect(merged[0].toolDone).toBe(true);
    expect(merged[1].toolOutput).toBeUndefined();
  });

  it("propagates history timestamps into tool start and completion times", () => {
    const merged = mergeToolPairs([
      msg({ id: "c1", toolName: "Task", text: "call", timestamp: 1000 }),
      msg({ id: "c1-r", toolName: "Task", text: "done", timestamp: 46000 })
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].toolStartedAt).toBe(1000);
    expect(merged[0].toolCompletedAt).toBe(46000);
    expect(merged[0].toolDone).toBe(true);
  });

  it("keeps live-stamped times over history timestamps", () => {
    const merged = mergeToolPairs([
      msg({ id: "c1", toolName: "Task", text: "call", toolStartedAt: 5000, timestamp: 1000 }),
      msg({ id: "c1-r", toolName: "Task", text: "done", timestamp: 46000 })
    ]);
    expect(merged[0].toolStartedAt).toBe(5000);
    expect(merged[0].toolCompletedAt).toBe(46000);
  });

  it("keeps orphan results", () => {
    const merged = mergeToolPairs([msg({ id: "zzz-r", toolName: "result", text: "out" })]);
    expect(merged).toHaveLength(1);
  });

  it("pairs results to their calls even with interleaved calls", () => {
    const merged = mergeToolPairs([
      msg({ id: "tu1", toolName: "Bash", text: 'Bash {"command":"a"}' }),
      msg({ id: "tu2", toolName: "Task", text: 'Task {"description":"b"}' }),
      msg({ id: "tu1-r", toolName: "result", text: "out-a" }),
      msg({ id: "tu2-r", toolName: "result", text: "out-b" })
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].toolOutput).toBe("out-a");
    expect(merged[1].toolOutput).toBe("out-b");
  });

  it("folds history-shaped results into the preceding pending call", () => {
    const merged = mergeToolPairs([
      msg({ id: "toolu_1", toolName: "Bash", text: 'Bash {"command":"ls"}' }),
      msg({ id: "uuid-t0", toolName: "result", text: "out" }),
      msg({ id: "toolu_2", toolName: "Bash", text: 'Bash {"command":"pwd"}' }),
      msg({ id: "uuid-t1", toolName: "result", text: "out2" })
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].toolOutput).toBe("out");
    expect(merged[0].toolDone).toBe(true);
    expect(merged[1].toolOutput).toBe("out2");
  });

  it("does not attach history results to live calls with structured input", () => {
    const merged = mergeToolPairs([
      msg({ id: "live", toolName: "Bash", text: "call", toolInput: { command: "ls" } }),
      msg({ id: "uuid-t0", toolName: "result", text: "out" })
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].toolOutput).toBeUndefined();
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
