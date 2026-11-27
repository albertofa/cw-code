import { describe, expect, test } from "bun:test";
import type { ServerApp } from "../app/ServerApp.js";
import { Router, type CallContext } from "../transport/Router.js";
import { registerTurnHandlers } from "./turns.js";

const agent: CallContext = { clientId: "mcp:s1", client: "mcp", auth: { kind: "agent", sessionId: "s1" } };
const owner: CallContext = { clientId: "ui", client: "desktop-ui", auth: { kind: "owner" } };

function buildRouter(calls: string[]): Router {
  const router = new Router();
  const services = {
    sessions: { hasSession: (id: string) => id === "s1" },
    turns: {
      send: async () => {
        calls.push("send");
        return { disposition: "queued", messageId: "m1" };
      },
      unqueue: async () => {
        calls.push("unqueue");
      },
      flushQueue: async () => {
        calls.push("flushQueue");
        return "t1";
      }
    }
  };
  registerTurnHandlers(router, { requireServices: () => services } as unknown as ServerApp);
  return router;
}

describe("mid-turn message handlers", () => {
  const cases: Array<[string, unknown]> = [
    ["turns.send", { sessionId: "s1", prompt: "hi" }],
    ["turns.unqueue", { sessionId: "s1", messageId: "m1" }],
    ["turns.flushQueue", { sessionId: "s1" }]
  ];

  for (const [method, params] of cases) {
    test(`${method} is refused to agents`, async () => {
      const calls: string[] = [];
      await expect(buildRouter(calls).dispatch(method, params, agent)).rejects.toMatchObject({ code: "forbidden" });
      expect(calls).toEqual([]);
    });
  }

  test("owner calls reach the turn service", async () => {
    const calls: string[] = [];
    const router = buildRouter(calls);
    expect(await router.dispatch("turns.send", { sessionId: "s1", prompt: "hi", attachments: ["a.png"] }, owner)).toEqual({
      disposition: "queued",
      messageId: "m1"
    });
    await router.dispatch("turns.unqueue", { sessionId: "s1", messageId: "m1" }, owner);
    expect(await router.dispatch("turns.flushQueue", { sessionId: "s1" }, owner)).toBe("t1");
    expect(calls).toEqual(["send", "unqueue", "flushQueue"]);
  });

  test("rejects unknown sessions and malformed arguments", async () => {
    const router = buildRouter([]);
    await expect(router.dispatch("turns.send", { sessionId: "nope", prompt: "hi" }, owner)).rejects.toThrow("unknown session");
    await expect(router.dispatch("turns.send", { sessionId: "s1", prompt: "hi", attachments: [1] }, owner)).rejects.toThrow("invalid attachments");
    await expect(router.dispatch("turns.send", { sessionId: "s1", prompt: "hi", skills: ["bad name!"] }, owner)).rejects.toThrow("invalid skills");
    await expect(router.dispatch("turns.unqueue", { sessionId: "s1" }, owner)).rejects.toThrow("messageId");
  });
});
