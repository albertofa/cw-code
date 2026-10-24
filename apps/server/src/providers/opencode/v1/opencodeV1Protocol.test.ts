import { describe, expect, it } from "bun:test";
import type { OpencodeClient, OpencodeRequestInit } from "../opencodeProtocol.js";
import { opencodeV1Protocol } from "./opencodeV1Protocol.js";

interface Seen {
  path: string;
  method: string;
  body?: unknown;
}

function fakeClient(): { client: OpencodeClient; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    client: {
      cwd: "/proj",
      request: async (path: string, init: OpencodeRequestInit = {}) => {
        seen.push({ path, method: init.method ?? "GET", ...(init.body !== undefined ? { body: init.body } : {}) });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  };
}

const signal = new AbortController().signal;

describe("opencodeV1Protocol.send", () => {
  it("runs the first mentioned skill as a command with the prompt as its arguments", async () => {
    const { client, seen } = fakeClient();
    await opencodeV1Protocol.send(client, "ses_1", { prompt: "ship it with $plan", skills: ["plan"], model: null, files: [], signal });
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toMatch(/^\/session\/ses_1\/command/);
    expect(seen[0].body).toEqual({ command: "plan", arguments: "ship it with /plan" });
  });

  it("sends a plain message when no listed skill is mentioned", async () => {
    const { client, seen } = fakeClient();
    await opencodeV1Protocol.send(client, "ses_1", { prompt: "costs $5", skills: ["plan"], model: null, files: [], signal });
    expect(seen[0].path).toMatch(/^\/session\/ses_1\/message/);
    expect(seen[0].body).toEqual({ parts: [{ type: "text", text: "costs $5" }] });
  });
});
