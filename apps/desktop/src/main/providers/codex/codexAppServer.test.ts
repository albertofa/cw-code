import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "./codexAppServer.js";

const FAKE_SERVER = `
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: "fake" } }) + "\\n");
    } else if (msg.method === "initialized") {
      process.stdout.write(JSON.stringify({ method: "ready", params: {} }) + "\\n");
    } else if (msg.method === "ping/serverRequest") {
      process.stdout.write(JSON.stringify({ method: msg.method, id: "srv-1", params: msg.params }) + "\\n");
      process.stdout.write(JSON.stringify({ id: msg.id, result: { routed: true } }) + "\\n");
    } else if (msg.method === "boom") {
      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: 777, message: "kaboom" } }) + "\\n");
    } else if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { echo: msg.method, params: msg.params } }) + "\\n");
    } else if (msg.method) {
      process.stdout.write(JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
    }
  }
});
`;

const tmpDir = mkdtempSync(join(tmpdir(), "cw-codex-client-"));
const scriptPath = join(tmpDir, "fake-app-server.mjs");
writeFileSync(scriptPath, FAKE_SERVER, "utf8");

let client: CodexAppServer | null = null;

afterAll(() => {
  client?.dispose();
});

describe("CodexAppServer", () => {
  it("handshakes, correlates requests, and streams notifications", async () => {
    client = new CodexAppServer({ binary: process.execPath, args: [scriptPath] });
    const notifications: Array<{ method: string; params: unknown }> = [];
    client.onNotification((method, params) => notifications.push({ method, params }));

    const result = await client.request<{ echo: string }>("greet", { name: "cw" });
    expect(result.echo).toBe("greet");
    await new Promise((r) => setTimeout(r, 50));
    expect(notifications.some((n) => n.method === "ready")).toBe(true);
  });

  it("rejects requests that answer with an error envelope", async () => {
    client = client ?? new CodexAppServer({ binary: process.execPath, args: [scriptPath] });
    await expect(client.request("boom", {})).rejects.toMatchObject({ message: "kaboom", code: 777 });
  });

  it("routes server-initiated requests and delivers the response", async () => {
    client = client ?? new CodexAppServer({ binary: process.execPath, args: [scriptPath] });
    const received: Array<{ method: string; params: unknown; id: string | number }> = [];
    client.onServerRequest((method, params, id) => {
      received.push({ method, params, id });
      client?.respond(id, { decided: true });
    });
    await client.request("ping/serverRequest", { prompt: "approve?" });
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: "srv-1", params: { prompt: "approve?" } });
  });

  it("rejects pending requests when the process exits", async () => {
    const killScript = join(tmpDir, "killer.mjs");
    writeFileSync(
      killScript,
      'process.stdin.on("data", () => {}); setTimeout(() => process.exit(3), 50);\n',
      "utf8"
    );
    const dying = new CodexAppServer({ binary: process.execPath, args: [killScript] });
    dying.onNotification(() => {});
    dying.onServerRequest(() => {});
    await expect(
      Promise.all([
        dying.request("never", {}, 10_000),
        dying.request("never2", {}, 10_000)
      ])
    ).rejects.toThrow(/exited \(code 3\)/);
    dying.dispose();
  });

  it("rejects pending requests after dispose", async () => {
    const disposed = new CodexAppServer({ binary: process.execPath, args: [scriptPath] });
    disposed.onNotification(() => {});
    disposed.onServerRequest(() => {});
    disposed.dispose();
    await expect(disposed.request("greet")).rejects.toThrow("disposed");
  });

  it("passes spawn env to the app-server process", async () => {
    const envEchoPath = join(tmpDir, "env-echo.mjs");
    writeFileSync(
      envEchoPath,
      `
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
    } else if (msg.method === "initialized") {
      process.stdout.write(JSON.stringify({ method: "ready", params: {} }) + "\\n");
    } else if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { mark: process.env.CW_TEST_MARK ?? null } }) + "\\n");
    }
  }
});
`,
      "utf8"
    );
    const envClient = new CodexAppServer({
      binary: process.execPath,
      args: [envEchoPath],
      env: { ...process.env, CW_TEST_MARK: "present" }
    });
    try {
      const result = await envClient.request<{ mark: string | null }>("check", {});
      expect(result.mark).toBe("present");
    } finally {
      envClient.dispose();
    }
  });

  it("waits for a starting app-server to finish initializing before stopping it gracefully", async () => {
    const starting = new CodexAppServer({ binary: process.execPath, args: [scriptPath] });
    starting.onNotification(() => {});
    starting.onServerRequest(() => {});
    const request = starting.request("greet", {}).catch((err: Error) => err);
    expect(starting.ownedProcessCount()).toBe(1);
    try {
      expect(await starting.shutdown(10_000)).toEqual({ timedOut: false });
      expect(starting.ownedProcessCount()).toBe(0);
      await request;
    } finally {
      starting.dispose();
    }
  });

  it("reports a timeout when the app-server does not finish starting in time", async () => {
    const stuckScript = join(tmpDir, "stuck.mjs");
    writeFileSync(stuckScript, 'process.stdin.on("data", () => {});\n', "utf8");
    const stuck = new CodexAppServer({ binary: process.execPath, args: [stuckScript] });
    stuck.onNotification(() => {});
    stuck.onServerRequest(() => {});
    const request = stuck.request("greet", {}).catch((err: Error) => err);
    try {
      expect(await stuck.shutdown(200)).toEqual({ timedOut: true });
    } finally {
      stuck.dispose();
    }
    expect(await request).toBeInstanceOf(Error);
  });
});
