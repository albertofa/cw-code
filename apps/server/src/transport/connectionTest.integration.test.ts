import { afterEach, describe, expect, it } from "bun:test";
import { ServerClient, testConnection } from "@cw-code/client";
import type { ServerInfo } from "@cw-code/contracts";
import { Router, type ClientAuth } from "./Router.js";
import { WsServer } from "./WsServer.js";
import { PROTOCOL_VERSION } from "@cw-code/shared/protocol";

const OWNER_TOKEN = "o".repeat(64);
const DEVICE_TOKEN = "d".repeat(43);
const INFO: ServerInfo = { app: "cw-code", version: "9.9.9", protocol: PROTOCOL_VERSION };

const servers: WsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function startServer(): string {
  const router = new Router();
  router.handle("whoami", (_params, ctx) => ({ client: ctx.client, auth: ctx.auth }));
  const authorize = (token: string): ClientAuth | null =>
    token === OWNER_TOKEN ? { kind: "owner" } : token === DEVICE_TOKEN ? { kind: "device", deviceId: "dev_1" } : null;
  const server = new WsServer({
    host: "127.0.0.1",
    port: 0,
    authorize,
    version: INFO.version,
    router,
    http: { uiDir: null, info: INFO, ownerToken: OWNER_TOKEN, stop: () => undefined }
  });
  servers.push(server);
  return server.start().url;
}

describe("remote connections against a real server", () => {
  it("lets a device token say hello as web and rejects it as a desktop kind", async () => {
    const url = startServer();
    const web = new ServerClient({ endpoint: { url, token: DEVICE_TOKEN }, client: "web" });
    await web.connect();
    expect(await web.call("whoami")).toEqual({ client: "web", auth: { kind: "device", deviceId: "dev_1" } });
    web.close();

    const shell = new ServerClient({ endpoint: { url, token: DEVICE_TOKEN }, client: "desktop-shell" });
    let code: string | undefined;
    try {
      await shell.connect();
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    shell.close();
    expect(code).toBe("unauthorized");
  });

  it("passes the connection test with a device token and fails it with a wrong one", async () => {
    const httpUrl = startServer().replace(/^ws/, "http").replace(/\/ws$/, "");
    expect(await testConnection(httpUrl, DEVICE_TOKEN)).toEqual({ ok: true, info: INFO });
    expect(await testConnection(`${httpUrl}/#token=${DEVICE_TOKEN}`, null)).toEqual({ ok: true, info: INFO });
    expect(await testConnection(httpUrl, "wrong")).toMatchObject({ ok: false, code: "unauthorized", info: INFO });
  });
});
