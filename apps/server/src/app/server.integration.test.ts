import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ServerClient, TopicCache } from "@cw-code/client";
import type {
  AppNotice,
  AppSettings,
  ClientKind,
  DeviceCreateResult,
  DeviceInfo,
  Project,
  ServerReady,
  SessionMeta,
  ShutdownPrepareResult,
  ShutdownStatus,
  StartupState
} from "@cw-code/contracts";
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

function spawnServer(serverHome = home, extraArgs: string[] = []): ServerProcess {
  const proc = Bun.spawn([process.execPath, ENTRY, "--port", "0", ...extraArgs], {
    env: { ...process.env, CW_CODE_HOME: serverHome },
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

async function connect(clientToken = token, kind: ClientKind = "desktop-ui", url = ready.url): Promise<ServerClient> {
  const client = new ServerClient({ endpoint: { url, token: clientToken }, client: kind });
  clients.push(client);
  await client.connect();
  return client;
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await Bun.sleep(25);
  }
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
    type SidebarSnapshot = { sidebar: { rev: number; data: Record<string, unknown> } };
    const first = await client.call<SidebarSnapshot>("topics.subscribe", { topics: ["sidebar"] });
    expect(first.sidebar.data.layout).toEqual({ needsYou: [], workingSet: [], main: [], resolved: [], quickCounts: { pr: 0 } });
    expect(first.sidebar.data.defaults).toMatchObject({ restoreSessionId: null });
    expect(await client.call("topics.subscribe", { topics: ["sidebar"] })).toEqual(first);
    await expect(client.call("topics.subscribe", { topics: ["app", "github/nope"] })).rejects.toMatchObject({ code: "unknown-topic" });
    await expect(client.call("topics.subscribe", { topics: ["pty/x:shell"] })).rejects.toMatchObject({ code: "invalid-topic" });
    await expect(client.call("topics.unsubscribe", { topics: ["pty/x:shell"] })).rejects.toMatchObject({ code: "invalid-topic" });
    expect(await client.call("topics.unsubscribe", { topics: ["sidebar", "app"] })).toBeNull();
  });

  it("serves the prs topic and still broadcasts settings", async () => {
    const subscriber = await connect();
    const bystander = await connect();
    await subscriber.call("settings.set", { githubCliBinaryPath: join(home, "no-gh") });
    type PrsSnapshot = Record<string, { data: { inbox?: { error: string | null } } & Record<string, unknown> }>;
    const snapshot = await subscriber.call<PrsSnapshot>("topics.subscribe", { topics: ["prs"] });
    expect(Object.keys(snapshot.prs.data).sort()).toEqual(["context", "inbox"]);
    await subscriber.call("prs.refresh", { force: true });
    const refreshed = await subscriber.call<PrsSnapshot>("topics.subscribe", { topics: ["prs"] });
    expect(refreshed.prs.data.inbox?.error).not.toBeNull();

    const settingsSeen = (client: ServerClient) =>
      new Promise<AppSettings>((resolve) => {
        client.on("settings.changed", (payload) => resolve(payload as AppSettings));
      });
    const both = Promise.all([settingsSeen(subscriber), settingsSeen(bystander)]);
    const current = await subscriber.call<AppSettings>("settings.get");
    await subscriber.call("settings.set", { claudeReasoningExpanded: !current.claudeReasoningExpanded });
    for (const seen of await both) expect(seen.claudeReasoningExpanded).toBe(!current.claudeReasoningExpanded);
  });

  it("sends project and session mutations only to sidebar subscribers", async () => {
    const watcher = await connect();
    const bystander = await connect();
    const projectsSeen: Project[] = [];
    const rowPatches: string[] = [];
    const leaked: unknown[] = [];
    watcher.on("projects.changed", (payload) => projectsSeen.push(payload as Project));
    watcher.onPatch((patch) => {
      if (patch.topic !== "sidebar") return;
      for (const op of patch.ops) if (op.op === "upsert" && op.key.startsWith("row/")) rowPatches.push(op.key);
    });
    bystander.on("projects.changed", (payload) => leaked.push(payload));
    bystander.onPatch((patch) => leaked.push(patch));
    await watcher.call("topics.subscribe", { topics: ["sidebar"] });

    const project = await bystander.call<Project>("projects.add", mkdtempSync(join(home, "sidebar-")));
    const session = await bystander.call<SessionMeta>("sessions.create", { projectId: project.id, driver: "claude" });
    await until(() => rowPatches.includes(`row/${session.id}`));
    expect(projectsSeen.map((seen) => seen.id)).toEqual([project.id]);
    expect(leaked).toEqual([]);
  });

  it("returns a fresh snapshot when a subscribed client subscribes again", async () => {
    const client = await connect();
    const writer = await connect();
    type Snapshot = Record<string, { rev: number; data: Record<string, unknown> }>;
    const first = await client.call<Snapshot>("topics.subscribe", { topics: ["sidebar"] });
    const project = await writer.call<Project>("projects.add", mkdtempSync(join(home, "resubscribe-")));
    let again = first;
    await until(async () => {
      again = await client.call<Snapshot>("topics.subscribe", { topics: ["sidebar"] });
      return again.sidebar.data[`project/${project.id}`] !== undefined;
    });
    expect(first.sidebar.data[`project/${project.id}`]).toBeUndefined();
    expect(again.sidebar.rev).toBeGreaterThan(first.sidebar.rev);
  });

  it("resyncs topic data after a forced socket drop without a reload", async () => {
    const client = new ServerClient({ endpoint: { url: ready.url, token }, client: "desktop-ui", reconnect: true });
    clients.push(client);
    await client.connect();
    const cache = new TopicCache(client);
    const release = cache.acquire("sidebar");
    try {
      await until(() => cache.state("sidebar")?.status === "ready");
      const epoch = cache.epoch;
      const writer = await connect();
      const dropped = new Promise<void>((resolve) => {
        const off = client.onState((state) => {
          if (state !== "reconnecting") return;
          off();
          resolve();
        });
      });
      const resynced = new Promise<number>((resolve) => {
        const off = cache.onEpoch((next) => {
          off();
          resolve(next);
        });
      });
      (client as unknown as { socket: WebSocket | null }).socket?.close();
      await dropped;
      const project = await writer.call<Project>("projects.add", mkdtempSync(join(home, "reconnect-")));
      expect(await resynced).toBe(epoch + 1);
      await until(() => cache.state("sidebar")?.data[`project/${project.id}`] !== undefined);
      expect(cache.state("sidebar")?.status).toBe("ready");
    } finally {
      release();
      cache.dispose();
    }
  });

  it("rejects the methods removed with the topic protocol as unknown", async () => {
    const client = await connect();
    const removed = [
      "sessions.expireHolding",
      "sessions.activeTurns",
      "sessions.history",
      "git.status",
      "prs.inbox",
      "prs.tracked",
      "prs.projectRepos",
      "usage.ledger",
      "usage.account",
      "os.homeDir",
      "turns.interrupt",
      "github.search",
      "github.runs",
      "github.counts",
      "github.watchRuns",
      "github.issueDetail",
      "github.runLog",
      "github.clone",
      "fs.gitDecorations"
    ];
    const results = await Promise.allSettled(removed.map((method) => client.call(method, {})));
    expect(results.map((result) => (result.status === "rejected" ? (result.reason as { code?: string }).code : "resolved"))).toEqual(
      removed.map(() => "unknown-method")
    );
  });

  it("lets only the owner manage device tokens and closes a revoked device with 4401", async () => {
    const owner = await connect();
    const created = await owner.call<DeviceCreateResult>("devices.create", { name: "Phone" });
    expect(created.device).toMatchObject({ name: "Phone", connected: false });
    expect(readFileSync(join(home, "userdata", "devices.json"), "utf8")).not.toContain(created.token);

    await owner.call("topics.subscribe", { topics: ["app"] });
    const deviceSeen = new Promise<DeviceInfo[]>((resolve) => {
      const off = owner.on("devices.changed", (payload) => {
        const infos = payload as DeviceInfo[];
        if (!infos.some((info) => info.id === created.device.id && info.connected)) return;
        off();
        resolve(infos);
      });
    });
    const device = await connect(created.token, "web");
    expect((await deviceSeen).find((info) => info.id === created.device.id)?.lastSeenAt).not.toBeNull();
    await expect(device.call("settings.set", { serverBindHost: "0.0.0.0" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(device.call("devices.create", { name: "Rogue" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(device.call("devices.revoke", { id: created.device.id })).rejects.toMatchObject({ code: "forbidden" });
    expect((await device.call<DeviceInfo[]>("devices.list")).map((info) => info.id)).toContain(created.device.id);

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

describe("bind host policy", () => {
  const homes: string[] = [];

  function freshHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "cw-server-bind-"));
    homes.push(dir);
    return dir;
  }

  afterAll(async () => {
    await Bun.sleep(200);
    for (const dir of homes) rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 when the --host flag asks for a non-loopback host without device tokens", async () => {
    const proc = spawnServer(freshHome(), ["--host", "0.0.0.0"]);
    expect(await exitWithin(proc, STARTUP_TIMEOUT_MS)).toBe(1);
  }, STARTUP_TIMEOUT_MS + 5_000);

  it("falls back to loopback and notifies the shell when the setting asks for a non-loopback host without device tokens", async () => {
    const dir = freshHome();
    const first = spawnServer(dir);
    const firstReady = JSON.parse(await readTaggedLine(first, "CW_SERVER_READY")) as ServerReady;
    const ownerToken = readFileSync(join(dir, "userdata", "server-token"), "utf8").trim();
    const owner = await connect(ownerToken, "desktop-ui", firstReady.url);
    expect((await owner.call<AppSettings>("settings.set", { serverBindHost: "0.0.0.0" })).serverBindHost).toBe("0.0.0.0");
    await owner.call("server.stop");
    expect(await exitWithin(first, 15_000)).toBe(0);

    const second = spawnServer(dir);
    const secondReady = JSON.parse(await readTaggedLine(second, "CW_SERVER_READY")) as ServerReady;
    expect(secondReady.url).toBe(`ws://127.0.0.1:${secondReady.port}/ws`);
    const shell = new ServerClient({ endpoint: { url: secondReady.url, token: ownerToken }, client: "desktop-shell" });
    clients.push(shell);
    const notice = new Promise<AppNotice>((resolve) => {
      shell.on("app.notice", (payload) => resolve(payload as AppNotice));
    });
    await shell.connect();
    expect(await notice).toMatchObject({ level: "warning", message: "cw-code is listening on 127.0.0.1 only" });
    expect(readFileSync(join(dir, "logs", "crash.log"), "utf8")).toContain("ignoring the serverBindHost setting 0.0.0.0");
    await shell.call("server.stop");
    expect(await exitWithin(second, 15_000)).toBe(0);
  }, 3 * STARTUP_TIMEOUT_MS);
});

describe("abandoned shutdown recovery", () => {
  let dir = "";

  afterAll(async () => {
    await Bun.sleep(200);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function shutdownStatusEventually(client: ServerClient, idle: boolean): Promise<ShutdownStatus> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await client.call<ShutdownStatus>("shutdown.status");
      if (status.idle === idle) return status;
      await Bun.sleep(100);
    }
    return client.call<ShutdownStatus>("shutdown.status");
  }

  it("keeps a prepared shutdown while another desktop window is connected and recovers when the last one leaves", async () => {
    dir = mkdtempSync(join(tmpdir(), "cw-server-shutdown-"));
    const proc = spawnServer(dir);
    const procReady = JSON.parse(await readTaggedLine(proc, "CW_SERVER_READY")) as ServerReady;
    const ownerToken = readFileSync(join(dir, "userdata", "server-token"), "utf8").trim();
    const first = await connect(ownerToken, "desktop-ui", procReady.url);
    const second = await connect(ownerToken, "desktop-ui", procReady.url);
    const shell = await connect(ownerToken, "desktop-shell", procReady.url);
    const prepared = await first.call<ShutdownPrepareResult>("shutdown.prepare", { reason: "quit", stopActiveTurns: true, timeoutMs: 10_000 });
    expect(prepared.ok).toBe(true);

    second.close();
    await Bun.sleep(300);
    expect((await shell.call<ShutdownStatus>("shutdown.status")).idle).toBe(false);

    first.close();
    expect((await shutdownStatusEventually(shell, true)).idle).toBe(true);
    await shell.call("server.stop");
    expect(await exitWithin(proc, 15_000)).toBe(0);
  }, 2 * STARTUP_TIMEOUT_MS);
});
