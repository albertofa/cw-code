import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerReady } from "@cw-code/contracts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpointFilePath, readLiveEndpoint, removeEndpoint, writeEndpoint } from "./endpointFile.js";

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
