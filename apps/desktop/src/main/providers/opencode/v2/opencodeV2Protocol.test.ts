import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import type { OpencodeClient, OpencodeRequestInit } from "../opencodeProtocol.js";
import { opencodeV2Protocol } from "./opencodeV2Protocol.js";

const CWD = process.platform === "win32" ? "C:\\proj\\wt" : "/proj/wt";

interface Seen {
  path: string;
  method: string;
  body?: unknown;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function fakeClient(route: (seen: Seen) => Response | undefined): { client: OpencodeClient; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    client: {
      cwd: CWD,
      request: async (path: string, init: OpencodeRequestInit = {}) => {
        const entry = { path, method: init.method ?? "GET", ...(init.body !== undefined ? { body: init.body } : {}) };
        seen.push(entry);
        return route(entry) ?? new Response(null, { status: 204 });
      }
    }
  };
}

const signal = new AbortController().signal;

describe("opencodeV2Protocol requests", () => {
  it("creates sessions in the request directory through the body, not the query", async () => {
    const { client, seen } = fakeClient(() => json({ data: { id: "ses_1", location: { directory: CWD } } }));
    await expect(opencodeV2Protocol.createSession(client)).resolves.toBe("ses_1");
    expect(seen).toEqual([{ path: "/api/session", method: "POST", body: { location: { directory: CWD } } }]);
  });

  it("rejects a created session placed in another directory", async () => {
    const { client } = fakeClient(() => json({ data: { id: "ses_1", location: { directory: "/elsewhere" } } }));
    await expect(opencodeV2Protocol.createSession(client)).rejects.toThrow("ignored the session directory");
  });

  it("switches model and variant before an idle prompt and sends files as file URIs", async () => {
    const { client, seen } = fakeClient((s) => (s.path === "/api/session/active" ? json({ data: {} }) : s.path.endsWith("/prompt") ? json({ data: { id: "msg_1" } }) : undefined));
    const file = process.platform === "win32" ? "C:\\proj\\wt\\shot.png" : "/proj/wt/shot.png";
    const result = await opencodeV2Protocol.send(client, "ses_1", {
      prompt: "hello",
      model: { providerID: "opencode", modelID: "big-pickle" },
      variant: "high",
      files: [{ mime: "image/png", path: file }],
      signal
    });
    expect(result.settled).toBe(false);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /api/session/active", "POST /api/session/ses_1/model", "POST /api/session/ses_1/prompt"]);
    expect(seen[1].body).toEqual({ model: { providerID: "opencode", id: "big-pickle", variant: "high" } });
    expect(seen[2].body).toEqual({ text: "hello", files: [{ uri: pathToFileURL(file).href, name: "shot.png" }] });
  });

  it("keeps the running model when the session is still busy", async () => {
    const { client, seen } = fakeClient((s) => (s.path === "/api/session/active" ? json({ data: { ses_1: {} } }) : undefined));
    await opencodeV2Protocol.send(client, "ses_1", { prompt: "hi", model: { providerID: "a", modelID: "b" }, files: [], signal });
    expect(seen.map((s) => s.path)).toEqual(["/api/session/active", "/api/session/ses_1/prompt"]);
  });

  it("fails the send with the server's reason when the model switch is rejected", async () => {
    const { client } = fakeClient((s) =>
      s.path === "/api/session/active" ? json({ data: {} }) : s.path.endsWith("/model") ? json({ message: "unknown model" }, 400) : undefined
    );
    await expect(
      opencodeV2Protocol.send(client, "ses_1", { prompt: "hi", model: { providerID: "a", modelID: "nope" }, files: [], signal })
    ).rejects.toThrow("opencode model switch failed: 400");
  });

  it("sends commands with their arguments as text and skills as prompt attachments", async () => {
    const route = (s: Seen): Response | undefined => {
      if (s.path === "/api/command") return json({ data: [{ name: "review" }] });
      if (s.path === "/api/skill") return json({ data: [{ id: "opencode", name: "OpenCode" }] });
      return undefined;
    };
    const command = fakeClient(route);
    await opencodeV2Protocol.send(command.client, "ses_1", { prompt: "", command: { name: "review", args: "branch" }, model: null, files: [], signal });
    expect(command.seen.at(-1)).toEqual({ path: "/api/session/ses_1/command", method: "POST", body: { name: "review", text: "branch" } });
    const skill = fakeClient(route);
    await opencodeV2Protocol.send(skill.client, "ses_1", { prompt: "", command: { name: "opencode", args: "how do I x" }, model: null, files: [], signal });
    expect(skill.seen.at(-1)).toEqual({ path: "/api/session/ses_1/prompt", method: "POST", body: { text: "how do I x", skills: [{ id: "opencode" }] } });
  });

  it("attaches mentioned skills by id and keeps the prompt text", async () => {
    const { client, seen } = fakeClient((s) =>
      s.path === "/api/skill" ? json({ data: [{ id: "plan-dir", name: "plan" }, { id: "debug" }] }) : undefined
    );
    await opencodeV2Protocol.send(client, "ses_1", { prompt: "do $plan then $debug", skills: ["plan", "debug", "gone"], model: null, files: [], signal });
    expect(seen.at(-1)).toEqual({
      path: "/api/session/ses_1/prompt",
      method: "POST",
      body: { text: "do $plan then $debug", skills: [{ id: "plan-dir" }, { id: "debug" }] }
    });
  });

  it("resends as plain text when the server rejects the skill attachment", async () => {
    const { client, seen } = fakeClient((s) => {
      if (s.path === "/api/skill") return json({ data: [{ id: "plan" }] });
      if (s.path.endsWith("/prompt") && (s.body as { skills?: unknown }).skills) return json({ message: "Skill not found" }, 400);
      return undefined;
    });
    await opencodeV2Protocol.send(client, "ses_1", { prompt: "$plan", skills: ["plan"], model: null, files: [], signal });
    expect(seen.filter((s) => s.path.endsWith("/prompt")).map((s) => s.body)).toEqual([
      { text: "$plan", skills: [{ id: "plan" }] },
      { text: "$plan" }
    ]);
  });

  it("leaves other 400s to the caller instead of resending without skills", async () => {
    const { client, seen } = fakeClient((s) => {
      if (s.path === "/api/skill") return json({ data: [{ id: "plan" }] });
      if (s.path.endsWith("/prompt")) return json({ message: "unsupported file" }, 400);
      return undefined;
    });
    const result = await opencodeV2Protocol.send(client, "ses_1", { prompt: "$plan", skills: ["plan"], model: null, files: [], signal });
    expect(result.response.status).toBe(400);
    expect(seen.filter((s) => s.path.endsWith("/prompt"))).toHaveLength(1);
  });

  it("sends the prompt as text when the skill list is unavailable", async () => {
    const { client, seen } = fakeClient((s) => (s.path === "/api/skill" ? json({ message: "boom" }, 500) : undefined));
    await opencodeV2Protocol.send(client, "ses_1", { prompt: "$plan", skills: ["plan"], model: null, files: [], signal });
    expect(seen.at(-1)).toEqual({ path: "/api/session/ses_1/prompt", method: "POST", body: { text: "$plan" } });
  });

  it("replies to permissions with decision and to forms with field answers", async () => {
    const { client, seen } = fakeClient(() => undefined);
    await expect(opencodeV2Protocol.replyPermission(client, "ses_1", "per_1", "always")).resolves.toBe("replied");
    await expect(
      opencodeV2Protocol.replyQuestion(
        client,
        { requestId: "frm_1", sessionID: "ses_1", questions: [{ question: "Color?", options: [], multiSelect: false, allowCustom: true }], fields: [{ key: "q0", type: "string" }] },
        { "Color?": "Red" }
      )
    ).resolves.toBe(true);
    expect(seen).toEqual([
      { path: "/api/session/ses_1/permission/per_1/reply", method: "POST", body: { decision: "always" } },
      { path: "/api/session/ses_1/form/frm_1/reply", method: "POST", body: { answer: { q0: "Red" } } }
    ]);
  });

  it("treats a reply to a request the server no longer has as missing", async () => {
    const { client } = fakeClient(() => new Response(null, { status: 404 }));
    await expect(opencodeV2Protocol.replyPermission(client, "ses_1", "per_1", "once")).resolves.toBe("missing");
  });

  it("waits for the v1 migration before calling a resumed session gone", async () => {
    let probes = 0;
    const { client } = fakeClient((s) => {
      if (s.path === "/api/session/ses_old") {
        probes += 1;
        return probes < 2 ? new Response(null, { status: 404 }) : json({ data: { id: "ses_old" } });
      }
      if (s.path === "/api/experimental/migration/v1") return json({ status: "running", progress: { label: "sessions" } });
      return undefined;
    });
    await expect(opencodeV2Protocol.sessionExists(client, "ses_old")).resolves.toBe(true);
    expect(probes).toBe(2);
  });

  it("calls a session gone once the migration is finished", async () => {
    const { client } = fakeClient((s) =>
      s.path === "/api/experimental/migration/v1" ? json({ status: "completed" }) : new Response(null, { status: 404 })
    );
    await expect(opencodeV2Protocol.sessionExists(client, "ses_gone")).resolves.toBe(false);
  });

  it("waits for the v1 migration before failing a history read", async () => {
    let reads = 0;
    const { client } = fakeClient((s) => {
      if (s.path.startsWith("/api/session/ses_old/message")) {
        reads += 1;
        return reads < 2 ? new Response(null, { status: 404 }) : json({ data: [{ id: "msg_1", type: "user", text: "hi", time: { created: 1 } }], cursor: {} });
      }
      if (s.path === "/api/experimental/migration/v1") return json({ status: "running", progress: { label: "sessions" } });
      return undefined;
    });
    await expect(opencodeV2Protocol.messages(client, "ses_old", { label: "history" })).resolves.toHaveLength(1);
    expect(reads).toBe(2);
  });

  it("reattaches only to a session this server is still executing", async () => {
    const running = [{ info: { id: "msg_1", role: "user" }, parts: [] }];
    const idle = fakeClient((s) => (s.path === "/api/session/active" ? json({ data: {} }) : undefined));
    await expect(opencodeV2Protocol.reattachState(idle.client, "ses_1", running)).resolves.toEqual({ running: false });
    const busy = fakeClient((s) => (s.path === "/api/session/active" ? json({ data: { ses_1: {} } }) : undefined));
    await expect(opencodeV2Protocol.reattachState(busy.client, "ses_1", running)).resolves.toEqual({ running: true, runIds: ["msg_1"] });
    const finished = [...running, { info: { id: "msg_2", role: "idle" }, parts: [] }];
    await expect(opencodeV2Protocol.reattachState(busy.client, "ses_1", finished)).resolves.toEqual({ running: false });
  });

  it("pages history oldest first and maps it", async () => {
    const page = (ids: string[], next: string): Response =>
      json({ data: ids.map((id) => ({ id, type: "user", text: id, time: { created: 1 } })), cursor: { next } });
    const first = Array.from({ length: 200 }, (_, i) => `msg_${i}`);
    const { client, seen } = fakeClient((s) => (s.path.includes("cursor=") ? page(["msg_last"], "c2") : page(first, "c1")));
    const messages = await opencodeV2Protocol.messages(client, "ses_1", { label: "history" });
    expect(messages).toHaveLength(201);
    expect(seen.map((s) => s.path)).toEqual([
      "/api/session/ses_1/message?order=asc&limit=200",
      "/api/session/ses_1/message?order=asc&limit=200&cursor=c1"
    ]);
  });

  it("lists root sessions in the directory only", async () => {
    const { client } = fakeClient(() =>
      json({
        data: [
          { id: "ses_a", title: "A", location: { directory: CWD }, time: { created: 1, updated: 2 } },
          { id: "ses_b", parentID: "ses_a", location: { directory: CWD }, time: { created: 1, updated: 2 } },
          { id: "ses_c", location: { directory: "/other" }, time: { created: 1, updated: 2 } }
        ],
        cursor: {}
      })
    );
    await expect(opencodeV2Protocol.listSessions(client)).resolves.toEqual([{ id: "ses_a", title: "A", created: 1, updated: 2 }]);
  });

  it("lists root sessions across directories, following the cursor", async () => {
    const { client, seen } = fakeClient((s) =>
      s.path.includes("cursor=")
        ? json({ data: [{ id: "ses_c", title: "", location: { directory: "/other" }, time: { created: 5 } }], cursor: {} })
        : json({
            data: [
              { id: "ses_a", title: "A", location: { directory: CWD }, time: { created: 1, updated: 2 } },
              { id: "ses_b", parentID: "ses_a", location: { directory: CWD }, time: { created: 1, updated: 2 } },
              { id: "ses_x", title: "Archived", location: { directory: CWD }, time: { created: 1, archived: 3 } }
            ],
            cursor: { next: "c1" }
          })
    );
    await expect(opencodeV2Protocol.listNativeSessions(client)).resolves.toEqual([
      { driver: "opencode", resumeCursor: "ses_a", title: "A", cwd: CWD, createdAt: 1, updatedAt: 2 },
      { driver: "opencode", resumeCursor: "ses_c", title: "ses_c", cwd: "/other", createdAt: 5, updatedAt: 5 }
    ]);
    expect(seen.map((s) => s.path)).toEqual(["/api/session?parentID=null&limit=200", "/api/session?parentID=null&limit=200&cursor=c1"]);
  });
});
