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
const silentScript = join(tmpDir, "silent.mjs");
writeFileSync(silentScript, 'process.stdin.on("data", () => {}); setInterval(() => {}, 1000);\n', "utf8");
const exitOnEndScript = join(tmpDir, "exit-on-end.mjs");
writeFileSync(exitOnEndScript, 'process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(0));\n', "utf8");

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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

  it("kills a child that never finishes initializing instead of leaving it untracked", async () => {
    const silent = new CodexAppServer({ binary: process.execPath, args: [silentScript], initializeTimeoutMs: 200 });
    try {
      await expect(silent.request("greet")).rejects.toThrow("initialize timed out");
      await waitFor(() => silent.ownedProcessCount() === 0);
    } finally {
      silent.dispose();
    }
  });

  it("reports a timeout while a starting child ignores stdin close and lets dispose kill it", async () => {
    const silent = new CodexAppServer({ binary: process.execPath, args: [silentScript], initializeTimeoutMs: 10_000 });
    const request = silent.request("greet").catch((err: Error) => err.message);
    expect(silent.ownedProcessCount()).toBe(1);
    expect(await silent.shutdown(200)).toEqual({ timedOut: true });
    expect(await request).toContain("shutting down");
    expect(silent.ownedProcessCount()).toBe(1);
    silent.dispose();
    await waitFor(() => silent.ownedProcessCount() === 0);
  });

  it("stops a starting child gracefully when it exits on stdin close", async () => {
    const polite = new CodexAppServer({ binary: process.execPath, args: [exitOnEndScript], initializeTimeoutMs: 10_000 });
    const request = polite.request("greet").catch((err: Error) => err.message);
    expect(polite.ownedProcessCount()).toBe(1);
    expect(await polite.shutdown(5000)).toEqual({ timedOut: false });
    expect(await request).toContain("shutting down");
    expect(polite.ownedProcessCount()).toBe(0);
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
});
