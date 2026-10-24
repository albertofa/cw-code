import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ServerClient } from "@cw-code/client";
import type { AppSettings, ClientKind, DeviceCreateResult, DeviceInfo, PrSummary, ServerReady, StartupState } from "@cw-code/contracts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));
const STARTUP_TIMEOUT_MS = 30_000;

type ServerProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

const processes: ServerProcess[] = [];
const clients: ServerClient[] = [];
let home = "";
let server: ServerProcess;
let ready: ServerReady;
let token = "";

function spawnServer(): ServerProcess {
  const proc = Bun.spawn([process.execPath, ENTRY, "--port", "0"], {
    env: { ...process.env, CW_CODE_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  processes.push(proc);
  void new Response(proc.stderr).text();
  return proc;
}

async function readTaggedLine(proc: ServerProcess, tag: string): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no ${tag} line within ${STARTUP_TIMEOUT_MS}ms; stdout so far: ${buffered}`)), STARTUP_TIMEOUT_MS);
  });
  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffered += decoder.decode(value, { stream: true });
      const line = buffered.split(/\r?\n/).find((candidate) => candidate.startsWith(`${tag} `));
      if (line) return line.slice(tag.length + 1);
      if (done) throw new Error(`server exited before printing ${tag}; stdout: ${buffered}`);
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}

async function connect(clientToken = token, kind: ClientKind = "desktop-ui"): Promise<ServerClient> {
  const client = new ServerClient({ endpoint: { url: ready.url, token: clientToken }, client: kind });
  clients.push(client);
  await client.connect();
  return client;
}

function exitWithin(proc: ServerProcess, ms: number): Promise<number> {
  return Promise.race([
    proc.exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`process did not exit within ${ms}ms`)), ms))
  ]);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "cw-server-it-"));
  server = spawnServer();
  ready = JSON.parse(await readTaggedLine(server, "CW_SERVER_READY")) as ServerReady;
  token = readFileSync(join(home, "userdata", "server-token"), "utf8").trim();
}, STARTUP_TIMEOUT_MS + 5_000);

afterAll(async () => {
  for (const client of clients) client.close();
  for (const proc of processes) {
    if (proc.exitCode === null) proc.kill();
  }
  await Promise.allSettled(processes.map((proc) => exitWithin(proc, 10_000)));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(home, { recursive: true, force: true });
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
});

describe("server process", () => {
  it("prints a ready line that matches the endpoint file", () => {
    expect(ready.pid).toBe(server.pid);
    expect(ready.url).toBe(`ws://127.0.0.1:${ready.port}/ws`);
    expect(JSON.parse(readFileSync(join(home, "userdata", "server.json"), "utf8"))).toEqual(ready);
  });

  it("serves the app over the websocket", async () => {
    const client = await connect();
    expect(await client.call<StartupState>("startup.state")).toEqual({ mode: "ready" });
    const settings = await client.call<AppSettings>("settings.get");
    expect(typeof settings).toBe("object");
    expect(Array.isArray(await client.call("projects.list"))).toBe(true);
    expect(await client.call("shutdown.status")).toEqual({ idle: true, committed: false, reason: null });
  });

  it("broadcasts settings changes to other clients", async () => {
    const writer = await connect();
    const watcher = await connect();
    const current = await writer.call<AppSettings>("settings.get");
    const next = !current.claudeReasoningExpanded;
    const changed = new Promise<AppSettings>((resolve) => {
      watcher.on("settings.changed", (payload) => resolve(payload as AppSettings));
    });
    const saved = await writer.call<AppSettings>("settings.set", { claudeReasoningExpanded: next });
    expect(saved.claudeReasoningExpanded).toBe(next);
    expect((await changed).claudeReasoningExpanded).toBe(next);
  });

  it("accepts topic subscriptions and rejects pty topics", async () => {
    const client = await connect();
    expect(await client.call("topics.subscribe", { topics: ["sidebar"] })).toEqual({});
    await expect(client.call("topics.subscribe", { topics: ["pty/x:shell"] })).rejects.toMatchObject({ code: "invalid-topic" });
    expect(await client.call("topics.unsubscribe", { topics: ["sidebar", "app"] })).toBeNull();
  });

  it("pushes tracked PRs only to the subscriber and still broadcasts settings", async () => {
    const subscriber = await connect();
    const bystander = await connect();
    const pushed: PrSummary[][] = [];
    const leaked: unknown[] = [];
    subscriber.on("prs.tracked", (payload) => pushed.push(payload as PrSummary[]));
    bystander.on("prs.tracked", (payload) => leaked.push(payload));
    expect(await subscriber.call("topics.subscribe", { topics: ["prs"] })).toEqual({});
    expect(pushed).toEqual([[]]);

    const settingsSeen = (client: ServerClient) =>
      new Promise<AppSettings>((resolve) => {
        client.on("settings.changed", (payload) => resolve(payload as AppSettings));
      });
    const both = Promise.all([settingsSeen(subscriber), settingsSeen(bystander)]);
    const current = await subscriber.call<AppSettings>("settings.get");
    await subscriber.call("settings.set", { claudeReasoningExpanded: !current.claudeReasoningExpanded });
    for (const seen of await both) expect(seen.claudeReasoningExpanded).toBe(!current.claudeReasoningExpanded);
    expect(leaked).toEqual([]);
  });

  it("lets only the owner manage device tokens and closes a revoked device with 4401", async () => {
    const owner = await connect();
    const created = await owner.call<DeviceCreateResult>("devices.create", { name: "Phone" });
    expect(created.device).toMatchObject({ name: "Phone", connected: false });
    expect(readFileSync(join(home, "userdata", "devices.json"), "utf8")).not.toContain(created.token);

    const device = await connect(created.token, "web");
    await expect(device.call("devices.create", { name: "Rogue" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(device.call("devices.revoke", { id: created.device.id })).rejects.toMatchObject({ code: "forbidden" });
    expect((await device.call<DeviceInfo[]>("devices.list")).map((info) => info.id)).toContain(created.device.id);

    await owner.call("topics.subscribe", { topics: ["app"] });
    const changed = new Promise<DeviceInfo[]>((resolve) => {
      owner.on("devices.changed", (payload) => resolve(payload as DeviceInfo[]));
    });
    const closed = new Promise<void>((resolve) => {
      device.onState((state) => {
        if (state === "closed") resolve();
      });
    });
    await owner.call("devices.revoke", { id: created.device.id });
    await closed;
    expect(device.lastError?.code).toBe("unauthorized");
    expect((await changed).some((info) => info.id === created.device.id)).toBe(false);
    await expect(connect(created.token, "web")).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("refuses to start a second server on the same home", async () => {
    const second = spawnServer();
    const running = JSON.parse(await readTaggedLine(second, "CW_SERVER_RUNNING")) as ServerReady;
    expect(running).toEqual(ready);
    expect(await exitWithin(second, STARTUP_TIMEOUT_MS)).toBe(3);
  }, STARTUP_TIMEOUT_MS + 5_000);

  it("stops on server.stop and removes the endpoint file", async () => {
    const client = await connect();
    expect(await client.call("server.stop")).toBeNull();
    expect(await exitWithin(server, 15_000)).toBe(0);
    expect(existsSync(join(home, "userdata", "server.json"))).toBe(false);
  }, 20_000);
});
