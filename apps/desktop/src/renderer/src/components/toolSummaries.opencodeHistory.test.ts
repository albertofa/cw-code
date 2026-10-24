import { describe, expect, it } from "bun:test";
import { mapOpencodeMessages } from "@cw-code/server/providers/opencode/opencodeHistory";
import { mergeToolPairs } from "./toolSummaries.js";
import type { ChatMessage } from "../stores/appStore.js";

describe("mergeToolPairs over opencode history", () => {
  it("tool call cards merge their paired results so they resolve to done", () => {
    const history = mapOpencodeMessages([
      {
        info: { id: "m3", role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "webfetch",
            callID: "call_mix",
            state: { status: "completed", input: { url: "https://example.com" }, output: "page body" }
          }
        ]
      }
    ]) as unknown as ChatMessage[];
    const merged = mergeToolPairs(history);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "call_mix",
      toolName: "webfetch",
      toolDone: true,
      toolOutput: "page body"
    });
  });
});
