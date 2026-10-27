import { afterEach, describe, expect, it } from "bun:test";
import type { ServerEndpoint, ServerInfo } from "@cw-code/contracts";
import { CLOSE_PROTOCOL_MISMATCH, PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import { fetchServerInfo, helloAsWeb, infoUrl, NETWORK_PROBE, testConnection, type ConnectionProbe } from "./connectionTest.js";
import { ServerCallError } from "./ServerClient.js";

const INFO: ServerInfo = { app: "cw-code", version: "1.2.3", protocol: PROTOCOL_VERSION };

function probe(overrides: Partial<ConnectionProbe> & { seen?: string[] } = {}): ConnectionProbe {
  return {
    fetchInfo:
      overrides.fetchInfo ??
      (async (url) => {
        overrides.seen?.push(url);
        return INFO;
      }),
    hello: overrides.hello ?? (async () => undefined)
  };
}

function rejecting(error: Error): () => Promise<never> {
  return async () => {
    throw error;
  };
}

describe("testConnection", () => {
  it("joins the info path below a base path", () => {
    expect(infoUrl("http://host:4317")).toBe("http://host:4317/api/info");
    expect(infoUrl("https://host/cw")).toBe("https://host/cw/api/info");
    expect(infoUrl("https://host/cw/")).toBe("https://host/cw/api/info");
  });

  it("succeeds after the info check and the hello", async () => {
    const seen: string[] = [];
    let endpoint: ServerEndpoint | null = null;
    const result = await testConnection(
      "http://host:4317",
      "tok",
      probe({
        seen,
        hello: async (target) => {
          endpoint = target;
        }
      })
    );
    expect(result).toEqual({ ok: true, info: INFO });
    expect(seen).toEqual(["http://host:4317/api/info"]);
    expect(endpoint).toEqual<ServerEndpoint | null>({ url: "ws://host:4317/ws", token: "tok" });
  });

  it("classifies failures", async () => {
    expect(await testConnection("nope", "tok", probe())).toMatchObject({ ok: false, code: "invalid-url" });
    expect(await testConnection("http://host", "tok", probe({ fetchInfo: rejecting(new Error("ECONNREFUSED")) }))).toMatchObject({
      ok: false,
      code: "unreachable"
    });
    expect(await testConnection("http://host", "tok", probe({ fetchInfo: async () => ({ hello: "world" }) }))).toMatchObject({
      ok: false,
      code: "unreachable"
    });
    expect(await testConnection("http://host", "tok", probe({ fetchInfo: async () => ({ ...INFO, protocol: PROTOCOL_VERSION + 1 }) }))).toMatchObject({
      ok: false,
      code: "protocol-mismatch",
      info: { protocol: PROTOCOL_VERSION + 1 }
    });
    expect(await testConnection("http://host", null, probe())).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await testConnection("http://host", "bad", probe({ hello: rejecting(new ServerCallError("x", "unauthorized")) }))).toMatchObject({
      ok: false,
      code: "unauthorized",
      info: INFO
    });
    expect(await testConnection("http://host", "tok", probe({ hello: rejecting(new ServerCallError("x", "protocol-mismatch")) }))).toMatchObject({
      ok: false,
      code: "protocol-mismatch",
      info: INFO
    });
  });

  it("never echoes the token in a failure message", async () => {
    const result = await testConnection("http://host/#token=hash-secret", null, probe({ hello: rejecting(new Error("closed")) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("hash-secret");
  });
});

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the promise to reject");
}

describe("network probe", () => {
  const servers: Array<{ stop(force?: boolean): void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  function serve(options: Parameters<typeof Bun.serve>[0]): string {
    const server = Bun.serve(options);
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  it("reports a non-2xx info response without the token", async () => {
    const base = serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("nope", { status: 503 }) });
    const result = await testConnection(`${base}/#token=hash-secret`, null);
    expect(result).toMatchObject({ ok: false, code: "unreachable" });
    if (!result.ok) {
      expect(result.message).toContain("HTTP 503");
      expect(result.message).not.toContain("hash-secret");
    }
    expect(await rejectionOf(fetchServerInfo(`${base}/api/info`, 1_000))).toContain("HTTP 503");
  });

  it("times out an info request that never answers", async () => {
    const base = serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => undefined) });
    const result = await testConnection(base, "tok", NETWORK_PROBE, 150);
    expect(result).toMatchObject({ ok: false, code: "unreachable" });
    if (!result.ok) expect(result.message).toContain("no answer within");
  });

  it("maps a protocol-mismatch close to protocol-mismatch and a silent socket to a timeout", async () => {
    const answer = { mode: "mismatch" as "mismatch" | "silent" };
    const base = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, server) => {
        if (new URL(req.url).pathname === "/api/info") return Response.json(INFO);
        return server.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message: (ws) => {
          if (answer.mode === "mismatch") ws.close(CLOSE_PROTOCOL_MISMATCH, "protocol mismatch");
        }
      }
    });
    expect(await testConnection(base, "tok", NETWORK_PROBE, 2_000)).toMatchObject({ ok: false, code: "protocol-mismatch", info: INFO });
    answer.mode = "silent";
    expect(await rejectionOf(helloAsWeb({ url: `${base.replace("http", "ws")}/ws`, token: "tok" }, 150))).toContain("did not answer");
  });
});
