import { describe, expect, it } from "vitest";
import type { CommandOption } from "@cw-code/contracts";
import { commandDisplay, filterCommands, mergeCommands, parseSlashInput, rankByQuery } from "./slashCommands.js";

function cmd(name: string, description = "", extra: Partial<CommandOption> = {}): CommandOption {
  return { name, description, dispatch: "prompt", ...extra };
}

const ALL = { newSession: true, rename: true, terminal: true };

describe("mergeCommands", () => {
  it("puts app commands first and lets them win on name collision", () => {
    const merged = mergeCommands("opencode", [cmd("model", "driver model"), cmd("compact")], ALL);
    const model = merged.filter((c) => c.name === "model");
    expect(model).toHaveLength(1);
    expect(model[0].dispatch).toBe("app");
    expect(merged.map((c) => c.name)).toEqual(["new", "model", "effort", "rename", "compact"]);
  });

  it("offers clear only on claude", () => {
    expect(mergeCommands("claude", [], ALL).some((c) => c.name === "clear")).toBe(true);
    expect(mergeCommands("codex", [], ALL).some((c) => c.name === "clear")).toBe(false);
    expect(mergeCommands("opencode", [], ALL).some((c) => c.name === "clear")).toBe(false);
  });

  it("keeps a driver clear on non-claude harnesses where the app clear does not apply", () => {
    const merged = mergeCommands("codex", [cmd("clear", "driver clear")], ALL);
    expect(merged.filter((c) => c.name === "clear")).toEqual([cmd("clear", "driver clear")]);
  });

  it("hides rename and terminal commands when unavailable", () => {
    const merged = mergeCommands("claude", [cmd("doctor", "", { dispatch: "terminal" }), cmd("context")], {
      newSession: true,
      rename: false,
      terminal: false
    });
    const names = merged.map((c) => c.name);
    expect(names).not.toContain("rename");
    expect(names).not.toContain("doctor");
    expect(names).toContain("context");
  });

  it("hides new and clear when a new session is unavailable", () => {
    const names = mergeCommands("claude", [], { newSession: false, rename: true, terminal: true }).map((c) => c.name);
    expect(names).not.toContain("new");
    expect(names).not.toContain("clear");
    expect(names).toContain("model");
  });

  it("dedupes driver entries by name and strips the harness filter", () => {
    const merged = mergeCommands("claude", [cmd("context", "a"), cmd("context", "b")], ALL);
    expect(merged.filter((c) => c.name === "context").map((c) => c.description)).toEqual(["a"]);
    expect(merged.every((c) => !("harnesses" in c))).toBe(true);
  });
});

describe("filterCommands", () => {
  const list = [
    cmd("review", "Review changes"),
    cmd("compact", "Summarize context"),
    cmd("ndk:plan", "Plan a feature"),
    cmd("plan", "Toggle plan mode"),
    cmd("context", "Show context usage")
  ];

  it("returns everything for an empty query", () => {
    expect(filterCommands(list, "")).toEqual(list);
    expect(filterCommands(list, "/")).toEqual(list);
  });

  it("orders name prefix, then name substring, then description", () => {
    expect(filterCommands(list, "plan").map((c) => c.name)).toEqual(["plan", "ndk:plan"]);
    expect(filterCommands(list, "/con").map((c) => c.name)).toEqual(["context", "compact"]);
  });

  it("puts an exact name match before prefix matches", () => {
    const withLonger = [cmd("planner", "Plan things"), cmd("plan", "Toggle plan mode"), cmd("ndk:plan")];
    expect(filterCommands(withLonger, "plan").map((c) => c.name)).toEqual(["plan", "planner", "ndk:plan"]);
  });

  it("matches case-insensitively", () => {
    expect(filterCommands(list, "REV").map((c) => c.name)).toEqual(["review"]);
  });
});

describe("parseSlashInput", () => {
  const list = [cmd("compact"), cmd("review", "", { argumentHint: "[instructions]" })];

  it("resolves a known command and trims args", () => {
    expect(parseSlashInput("  /review   focus on tests  ", list)).toEqual({ command: list[1], args: "focus on tests" });
    expect(parseSlashInput("/compact", list)).toEqual({ command: list[0], args: "" });
  });

  it("keeps multi-line args", () => {
    expect(parseSlashInput("/review a\nb", list)?.args).toBe("a\nb");
  });

  it("returns null for unknown commands, a bare slash, and plain text", () => {
    expect(parseSlashInput("/nope", list)).toBeNull();
    expect(parseSlashInput("/", list)).toBeNull();
    expect(parseSlashInput("compact", list)).toBeNull();
  });
});

describe("rankByQuery", () => {
  it("orders exact, then prefix, then substring across any of the texts", () => {
    const models = [
      { id: "anthropic/claude-sonnet", label: "Sonnet" },
      { id: "sonnet-large", label: "Large" },
      { id: "sonnet", label: "Sonnet 4" }
    ];
    expect(rankByQuery(models, "sonnet", (m) => [m.id, m.label]).map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet",
      "sonnet",
      "sonnet-large"
    ]);
    expect(rankByQuery(models, "zzz", (m) => [m.id])).toEqual([]);
  });
});

describe("commandDisplay", () => {
  it("joins name and args", () => {
    expect(commandDisplay("review", "")).toBe("/review");
    expect(commandDisplay("review", "tests")).toBe("/review tests");
  });
});
