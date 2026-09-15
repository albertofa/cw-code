import { describe, expect, it } from "vitest";
import { buildThreadNodes, groupTurns, splitTurn } from "./turnGroups.js";
import type { ChatMessage } from "../stores/appStore.js";

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "turnId">): ChatMessage {
  return { text: "", ...partial };
}

describe("groupTurns", () => {
  it("anchors turns at user messages and absorbs trailing fragments", () => {
    const turns = groupTurns([
      msg({ id: "a", role: "user", turnId: "t1" }),
      msg({ id: "b", role: "assistant", turnId: "t1" }),
      msg({ id: "c", role: "user", turnId: "t2" }),
      msg({ id: "d", role: "tool", turnId: "t2" })
    ]);
    expect(turns.map((t) => t.turnId)).toEqual(["t1", "t2"]);
    expect(turns.map((t) => t.messages.map((m) => m.id))).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("merges per-message turn ids from history under the user anchor", () => {
    const turns = groupTurns([
      msg({ id: "u", role: "user", turnId: "u1" }),
      msg({ id: "a1", role: "assistant", turnId: "u1" }),
      msg({ id: "t1", role: "tool", turnId: "m2" }),
      msg({ id: "a2", role: "assistant", turnId: "m3" })
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].turnId).toBe("u1");
    expect(turns[0].messages.map((m) => m.id)).toEqual(["u", "a1", "t1", "a2"]);
  });

  it("keeps a leading fragment without a user anchor as its own slice", () => {
    const turns = groupTurns([
      msg({ id: "t0", role: "tool", turnId: "m0" }),
      msg({ id: "u", role: "user", turnId: "t1" })
    ]);
    expect(turns.map((t) => t.turnId)).toEqual(["m0", "t1"]);
  });

  it("returns no slices for no messages", () => {
    expect(groupTurns([])).toEqual([]);
  });
});

describe("buildThreadNodes", () => {
  it("groups consecutive tools and leaves a lone tool as a message", () => {
    const nodes = buildThreadNodes(
      [
        msg({ id: "t1", role: "tool", turnId: "x", toolName: "read" }),
        msg({ id: "t2", role: "tool", turnId: "x", toolName: "read" }),
        msg({ id: "a", role: "assistant", turnId: "x" }),
        msg({ id: "t3", role: "tool", turnId: "x", toolName: "read" })
      ],
      new Set()
    );
    expect(nodes.map((n) => n.kind)).toEqual(["tools", "msg", "msg"]);
    expect(nodes[0]).toMatchObject({ kind: "tools", key: "t1" });
    if (nodes[0].kind === "tools") expect(nodes[0].items.map((m) => m.id)).toEqual(["t1", "t2"]);
    expect(nodes[2]).toMatchObject({ kind: "msg", msg: { id: "t3" } });
  });

  it("keeps a running tool outside the group until it finishes", () => {
    const done = (id: string): ChatMessage =>
      msg({ id, role: "tool", turnId: "x", toolName: "read", toolInput: {}, toolDone: true, toolOutput: "out" });
    const running = msg({ id: "r", role: "tool", turnId: "x", toolName: "edit", toolInput: { filePath: "a.ts" } });

    const live = buildThreadNodes([done("t1"), done("t2"), running], new Set());
    expect(live.map((n) => n.kind)).toEqual(["tools", "msg"]);
    if (live[0].kind === "tools") expect(live[0].items.map((m) => m.id)).toEqual(["t1", "t2"]);
    expect(live[1]).toMatchObject({ kind: "msg", msg: { id: "r" } });

    const settled = buildThreadNodes([done("t1"), done("t2"), done("r")], new Set());
    expect(settled.map((n) => n.kind)).toEqual(["tools"]);
    if (settled[0].kind === "tools") expect(settled[0].items.map((m) => m.id)).toEqual(["t1", "t2", "r"]);
  });

  it("clusters consecutive subagent calls into one group", () => {
    const nodes = buildThreadNodes(
      [
        msg({ id: "s1", role: "tool", turnId: "x", toolName: "task", toolInput: { description: "One" } }),
        msg({ id: "s2", role: "tool", turnId: "x", toolName: "agent", toolInput: { description: "Two" } }),
        msg({ id: "r", role: "tool", turnId: "x", toolName: "read", toolInput: {} }),
        msg({ id: "s3", role: "tool", turnId: "x", toolName: "task", toolInput: { description: "Three" } })
      ],
      new Set()
    );
    expect(nodes.map((n) => n.kind)).toEqual(["sub", "msg", "sub"]);
    if (nodes[0].kind === "sub") {
      expect(nodes[0].key).toBe("s1");
      expect(nodes[0].group.items.map((i) => i.id)).toEqual(["s1", "s2"]);
    }
  });

  it("skips todo tool messages", () => {
    const nodes = buildThreadNodes(
      [
        msg({ id: "todo1", role: "tool", turnId: "x", toolName: "todowrite" }),
        msg({ id: "a", role: "assistant", turnId: "x" }),
        msg({ id: "todo2", role: "tool", turnId: "x", toolName: "Todo" })
      ],
      new Set()
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "msg", msg: { id: "a" } });
  });

  it("drops messages nested inside a subagent call", () => {
    const nodes = buildThreadNodes(
      [
        msg({ id: "s1", role: "tool", turnId: "x", toolName: "task" }),
        msg({ id: "nested", role: "assistant", turnId: "x", parentToolCallId: "s1" }),
        msg({ id: "direct", role: "assistant", turnId: "x", parentToolCallId: "other" })
      ],
      new Set(["s1"])
    );
    expect(nodes.map((n) => (n.kind === "msg" ? n.msg.id : n.kind))).toEqual(["sub", "direct"]);
  });
});

describe("splitTurn", () => {
  const nestedIds = new Set<string>();

  it("keeps user messages as lead and system messages apart from activity", () => {
    const pieces = splitTurn(
      [
        msg({ id: "u1", role: "user", turnId: "t1" }),
        msg({ id: "sys", role: "system", turnId: "t1", text: "connection lost" }),
        msg({ id: "a1", role: "assistant", turnId: "t1" }),
        msg({ id: "u2", role: "user", turnId: "t1" })
      ],
      nestedIds
    );
    expect(pieces.lead.map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(pieces.system.map((m) => m.id)).toEqual(["sys"]);
    expect(pieces.activity).toEqual([]);
  });

  it("pins the final assistant message, not interim ones or trailing reasoning", () => {
    const pieces = splitTurn(
      [
        msg({ id: "u", role: "user", turnId: "t1" }),
        msg({ id: "a1", role: "assistant", turnId: "t1", text: "interim" }),
        msg({ id: "tool", role: "tool", turnId: "t1", toolName: "read" }),
        msg({ id: "a2", role: "assistant", turnId: "t1", text: "final" }),
        msg({ id: "th", role: "reasoning", turnId: "t1", text: "thinking" })
      ],
      nestedIds
    );
    expect(pieces.pinned?.id).toBe("a2");
    expect(pieces.activity.map((n) => (n.kind === "msg" ? n.msg.id : n.kind))).toEqual(["a1", "tool", "th"]);
    expect(pieces.system).toEqual([]);
  });

  it("omits pinned when the turn has no assistant message", () => {
    const pieces = splitTurn(
      [
        msg({ id: "u", role: "user", turnId: "t1" }),
        msg({ id: "sys", role: "system", turnId: "t1", text: "boom" }),
        msg({ id: "th", role: "reasoning", turnId: "t1" })
      ],
      nestedIds
    );
    expect(pieces.pinned).toBeUndefined();
    expect("pinned" in pieces).toBe(false);
    expect(pieces.activity.map((n) => (n.kind === "msg" ? n.msg.id : n.kind))).toEqual(["th"]);
  });

  it("leaves a trailing tool call in the activity", () => {
    const pieces = splitTurn(
      [
        msg({ id: "u", role: "user", turnId: "t1" }),
        msg({ id: "a1", role: "assistant", turnId: "t1", text: "final" }),
        msg({ id: "tool", role: "tool", turnId: "t1", toolName: "bash" })
      ],
      nestedIds
    );
    expect(pieces.pinned?.id).toBe("a1");
    expect(pieces.activity.map((n) => (n.kind === "msg" ? n.msg.id : n.kind))).toEqual(["tool"]);
  });

  it("never pins an assistant nested inside a subagent call", () => {
    const pieces = splitTurn(
      [
        msg({ id: "u", role: "user", turnId: "t1" }),
        msg({ id: "s1", role: "tool", turnId: "t1", toolName: "task" }),
        msg({ id: "nested", role: "assistant", turnId: "t1", parentToolCallId: "s1" }),
        msg({ id: "a1", role: "assistant", turnId: "t1", text: "final" })
      ],
      new Set(["s1"])
    );
    expect(pieces.pinned?.id).toBe("a1");
    expect(pieces.activity.map((n) => (n.kind === "msg" ? n.msg.id : n.kind))).toEqual(["sub"]);
  });
});
