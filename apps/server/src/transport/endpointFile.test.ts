import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerReady } from "@cw-code/contracts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLiveEndpoint, endpointFilePath, readLiveEndpoint, removeEndpoint, writeEndpoint } from "./endpointFile.js";
import { Router } from "./Router.js";
import { WsServer } from "./WsServer.js";

const OTHER_PID = process.pid + 100_000;
const UNUSED_PID = 2_147_483_000;
let root: string;

function ready(pid: number): ServerReady {
  return { url: "ws://127.0.0.1:4000/ws", port: 4000, pid, protocol: 1, version: "1.2.3" };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cw-endpoint-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("endpoint file", () => {
  test("places the file in the directory", () => {
    expect(endpointFilePath(root)).toBe(join(root, "server.json"));
  });

  test("round-trips a live endpoint", () => {
    writeEndpoint(root, ready(OTHER_PID));
    expect(readLiveEndpoint(root, () => true)).toEqual(ready(OTHER_PID));
  });

  test("returns null when the file is missing", () => {
    expect(readLiveEndpoint(root, () => true)).toBeNull();
  });

  test("returns null for a stale pid", () => {
    writeEndpoint(root, ready(OTHER_PID));
    expect(readLiveEndpoint(root, () => false)).toBeNull();
  });

  test("passes the recorded pid to isAlive", () => {
    writeEndpoint(root, ready(OTHER_PID));
    const seen: number[] = [];
    readLiveEndpoint(root, (pid) => {
      seen.push(pid);
      return true;
    });
    expect(seen).toEqual([OTHER_PID]);
  });

  test("returns null for the current process", () => {
    writeEndpoint(root, ready(process.pid));
    expect(readLiveEndpoint(root, () => true)).toBeNull();
  });

  test("returns null for unparseable and shape-invalid files", () => {
    writeFileSync(endpointFilePath(root), "{not json");
    expect(readLiveEndpoint(root, () => true)).toBeNull();
    writeFileSync(endpointFilePath(root), JSON.stringify({ url: "ws://x", port: "4000", pid: OTHER_PID }));
    expect(readLiveEndpoint(root, () => true)).toBeNull();
    writeFileSync(endpointFilePath(root), "null");
    expect(readLiveEndpoint(root, () => true)).toBeNull();
  });

  test("default liveness check reports an unused pid as dead", () => {
    writeEndpoint(root, ready(UNUSED_PID));
    expect(readLiveEndpoint(root)).toBeNull();
  });

  test("default liveness check reports the parent process as alive", () => {
    writeEndpoint(root, ready(process.ppid));
    expect(readLiveEndpoint(root)).toEqual(ready(process.ppid));
  });

  test("removeEndpoint only removes the file owned by the pid", () => {
    writeEndpoint(root, ready(OTHER_PID));
    removeEndpoint(root, OTHER_PID + 1);
    expect(existsSync(endpointFilePath(root))).toBe(true);
    removeEndpoint(root, OTHER_PID);
    expect(existsSync(endpointFilePath(root))).toBe(false);
  });

  test("removeEndpoint tolerates a missing file", () => {
    expect(() => removeEndpoint(root, OTHER_PID)).not.toThrow();
  });
});

describe("confirmLiveEndpoint", () => {
  test("passes the recorded url to the probe and returns its answer", async () => {
    const seen: string[] = [];
    const probe = async (url: string) => {
      seen.push(url);
      return true;
    };
    expect(await confirmLiveEndpoint(ready(OTHER_PID), probe)).toBe(true);
    expect(seen).toEqual([ready(OTHER_PID).url]);
  });

  test("treats a live foreign pid that fails the probe as stale", async () => {
    writeEndpoint(root, ready(process.ppid));
    const candidate = readLiveEndpoint(root);
    expect(candidate).not.toBeNull();
    expect(await confirmLiveEndpoint(candidate!, async () => false)).toBe(false);
    removeEndpoint(root, candidate!.pid);
    expect(existsSync(endpointFilePath(root))).toBe(false);
  });

  test("treats a throwing probe as stale", async () => {
    const probe = async () => {
      throw new Error("boom");
    };
    expect(await confirmLiveEndpoint(ready(OTHER_PID), probe)).toBe(false);
  });

  test("confirms a real websocket server", async () => {
    const server = new WsServer({ host: "127.0.0.1", port: 0, authorize: () => null, version: "1.0.0", router: new Router() });
    try {
      const { url, port } = server.start();
      expect(await confirmLiveEndpoint({ ...ready(OTHER_PID), url, port })).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("rejects a closed port", async () => {
    const server = new WsServer({ host: "127.0.0.1", port: 0, authorize: () => null, version: "1.0.0", router: new Router() });
    const { url, port } = server.start();
    await server.stop();
    expect(await confirmLiveEndpoint({ ...ready(OTHER_PID), url, port })).toBe(false);
  });

  test("rejects a foreign http server", async () => {
    const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hi") });
    try {
      const url = `ws://127.0.0.1:${foreign.port}/ws`;
      expect(await confirmLiveEndpoint({ ...ready(OTHER_PID), url, port: foreign.port! })).toBe(false);
    } finally {
      await foreign.stop(true);
    }
  });
});
