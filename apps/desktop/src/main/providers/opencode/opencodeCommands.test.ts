import { describe, expect, it } from "vitest";
import {
  buildOpencodeCommandBody,
  lastOpencodeUserMessageId,
  mapOpencodeCommands,
  opencodeBuiltinCommandOf,
  opencodeRevertMessageId
} from "./opencodeCommands.js";

describe("mapOpencodeCommands", () => {
  it("lists builtins first, then server commands with hints joined", () => {
    const mapped = mapOpencodeCommands([
      { name: "init", description: "guided AGENTS.md setup", source: "command", template: "x", hints: ["$ARGUMENTS"] },
      { name: "review", description: "review changes", source: "command", hints: ["$1", "$2"] },
      { name: "plan", description: "Use when starting", source: "skill", hints: [] },
      { name: "tag", description: "custom", source: "command", hints: ["$2", "$ARGUMENTS", "{file}"] }
    ]);
    expect(mapped.map((c) => c.name)).toEqual(["compact", "undo", "redo", "init", "review", "plan", "tag"]);
    expect(mapped.every((c) => c.dispatch === "native")).toBe(true);
    expect(mapped.find((c) => c.name === "init")).toEqual({
      name: "init",
      description: "guided AGENTS.md setup",
      dispatch: "native",
      argumentHint: "[arguments]"
    });
    expect(mapped.find((c) => c.name === "review")?.argumentHint).toBe("<arg1> <arg2>");
    expect(mapped.find((c) => c.name === "tag")?.argumentHint).toBe("<arg2> [arguments] {file}");
    expect(mapped.find((c) => c.name === "plan")).not.toHaveProperty("argumentHint");
  });

  it("marks undo and redo as needing confirmation", () => {
    const mapped = mapOpencodeCommands([]);
    expect(mapped.find((c) => c.name === "compact")?.confirm).toBeUndefined();
    expect(mapped.find((c) => c.name === "undo")?.confirm).toBeTruthy();
    expect(mapped.find((c) => c.name === "redo")?.confirm).toBeTruthy();
  });

  it("skips garbage entries and dedupes by name", () => {
    const mapped = mapOpencodeCommands([
      null,
      "init",
      42,
      { description: "no name" },
      { name: "  " },
      { name: "compact", description: "server compact" },
      { name: "init", description: 7, hints: "nope" },
      { name: "init", description: "second" },
      { name: "docs", hints: [1, "", "$ARGUMENTS"] }
    ]);
    expect(mapped.map((c) => c.name)).toEqual(["compact", "undo", "redo", "init", "docs"]);
    expect(mapped.find((c) => c.name === "compact")?.description).toBe("Summarize the session to free context");
    expect(mapped.find((c) => c.name === "init")).toEqual({ name: "init", description: "", dispatch: "native" });
    expect(mapped.find((c) => c.name === "docs")?.argumentHint).toBe("[arguments]");
  });

  it("never offers share", () => {
    const mapped = mapOpencodeCommands([
      { name: "share", description: "share the session", source: "command", hints: [] },
      { name: "init", description: "guided setup", source: "command", hints: [] }
    ]);
    expect(mapped.map((c) => c.name)).toEqual(["compact", "undo", "redo", "init"]);
  });

  it("returns only builtins for a non-array payload", () => {
    expect(mapOpencodeCommands({ data: [] }).map((c) => c.name)).toEqual(["compact", "undo", "redo"]);
    expect(mapOpencodeCommands(undefined).map((c) => c.name)).toEqual(["compact", "undo", "redo"]);
  });
});

describe("opencodeBuiltinCommandOf", () => {
  it("recognizes only the driver-owned commands", () => {
    expect(opencodeBuiltinCommandOf("compact")).toBe("compact");
    expect(opencodeBuiltinCommandOf("undo")).toBe("undo");
    expect(opencodeBuiltinCommandOf("redo")).toBe("redo");
    expect(opencodeBuiltinCommandOf("init")).toBeNull();
    expect(opencodeBuiltinCommandOf("share")).toBeNull();
  });
});

describe("buildOpencodeCommandBody", () => {
  it("joins the model and keeps the variant", () => {
    expect(
      buildOpencodeCommandBody(
        { name: "review", args: "main" },
        { model: { providerID: "anthropic", modelID: "claude-opus-5" }, variant: "high" }
      )
    ).toEqual({ command: "review", arguments: "main", model: "anthropic/claude-opus-5", variant: "high" });
  });

  it("sends attachment files as file parts", () => {
    expect(
      buildOpencodeCommandBody(
        { name: "review", args: "" },
        { files: [{ mime: "image/png", url: "/proj/shot.png" }] }
      )
    ).toEqual({
      command: "review",
      arguments: "",
      parts: [{ type: "file", mime: "image/png", url: "/proj/shot.png" }]
    });
    expect(buildOpencodeCommandBody({ name: "review", args: "" }, { files: [] })).not.toHaveProperty("parts");
  });

  it("omits model and variant when absent and always sends arguments", () => {
    expect(buildOpencodeCommandBody({ name: "init", args: "" }, { model: null })).toEqual({
      command: "init",
      arguments: ""
    });
  });
});

describe("lastOpencodeUserMessageId", () => {
  const messages = [
    { info: { id: "msg_1", role: "user" } },
    { info: { id: "msg_2", role: "assistant" } },
    { info: { id: "msg_3", role: "user" } },
    { info: { id: "msg_4", role: "assistant" } }
  ];

  it("picks the last user message", () => {
    expect(lastOpencodeUserMessageId(messages, null)).toBe("msg_3");
    expect(lastOpencodeUserMessageId({ data: messages }, null)).toBe("msg_3");
  });

  it("steps back past an active revert point", () => {
    expect(lastOpencodeUserMessageId(messages, "msg_3")).toBe("msg_1");
    expect(lastOpencodeUserMessageId(messages, "msg_1")).toBeNull();
  });

  it("ignores a revert point that is no longer listed", () => {
    expect(lastOpencodeUserMessageId(messages, "msg_gone")).toBe("msg_3");
  });

  it("returns null without user messages or on garbage", () => {
    expect(lastOpencodeUserMessageId([{ info: { id: "msg_2", role: "assistant" } }, null], null)).toBeNull();
    expect(lastOpencodeUserMessageId("nope", null)).toBeNull();
  });
});

describe("opencodeRevertMessageId", () => {
  it("reads the revert point from the session", () => {
    expect(opencodeRevertMessageId({ id: "ses_1", revert: { messageID: "msg_3", snapshot: "x" } })).toBe("msg_3");
    expect(opencodeRevertMessageId({ id: "ses_1" })).toBeNull();
    expect(opencodeRevertMessageId({ revert: { messageID: 3 } })).toBeNull();
    expect(opencodeRevertMessageId(null)).toBeNull();
  });
});
