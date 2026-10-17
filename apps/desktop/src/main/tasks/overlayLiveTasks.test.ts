import { describe, expect, it } from "vitest";
import type { HistoryMessage, TaskSnapshot } from "@cw-code/contracts";
import { overlayLiveTasks } from "./overlayLiveTasks.js";

const replayed: TaskSnapshot = { id: "call-1", kind: "agent", background: true, state: "unknown", runCount: 1 };
const live: TaskSnapshot = { id: "call-1", kind: "agent", background: true, state: "running", runCount: 2, startedAt: 10 };

function toolMessage(id: string, task?: TaskSnapshot): HistoryMessage {
  return { id, role: "tool", text: "", turnId: "t1", toolName: "Agent", ...(task ? { task } : {}) };
}

describe("overlayLiveTasks", () => {
  it("replaces a replayed task with the live snapshot", () => {
    const messages = [toolMessage("call-1", replayed)];

    const result = overlayLiveTasks(messages, [live]);

    expect(result).toEqual([toolMessage("call-1", live)]);
    expect(messages[0].task).toBe(replayed);
  });

  it("attaches the live snapshot to a tool message that carried no task", () => {
    expect(overlayLiveTasks([toolMessage("call-1")], [live])).toEqual([toolMessage("call-1", live)]);
  });

  it("leaves non-tool and unmatched messages alone", () => {
    const user: HistoryMessage = { id: "call-1", role: "user", text: "hi", turnId: "t1" };
    const other = toolMessage("call-2", replayed);
    const matched = toolMessage("call-1", replayed);

    const result = overlayLiveTasks([user, other, matched], [live]);

    expect(result[0]).toBe(user);
    expect(result[1]).toBe(other);
    expect(result[2]).toEqual(toolMessage("call-1", live));
  });

  it("returns the same array when nothing matches", () => {
    const messages = [toolMessage("call-2", replayed), { id: "call-1", role: "assistant", text: "x", turnId: "t1" } as HistoryMessage];

    expect(overlayLiveTasks(messages, [live])).toBe(messages);
  });

  it("returns the same array when there are no live tasks", () => {
    const messages = [toolMessage("call-1", replayed)];

    expect(overlayLiveTasks(messages, [])).toBe(messages);
  });
});
