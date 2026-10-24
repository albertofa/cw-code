import type { ServerReady } from "@cw-code/contracts";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../storage/atomicFile.js";

const ENDPOINT_FILE = "server.json";

export function endpointFilePath(dir: string): string {
  return join(dir, ENDPOINT_FILE);
}

function isServerReady(value: unknown): value is ServerReady {
  if (typeof value !== "object" || value === null) return false;
  const ready = value as Record<string, unknown>;
  return (
    typeof ready.url === "string" &&
    typeof ready.port === "number" &&
    typeof ready.pid === "number" &&
    typeof ready.protocol === "number" &&
    typeof ready.version === "string"
  );
}

function readEndpointFile(dir: string): ServerReady | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(endpointFilePath(dir), "utf8"));
    return isServerReady(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLiveEndpoint(dir: string, isAlive: (pid: number) => boolean = isProcessAlive): ServerReady | null {
  const ready = readEndpointFile(dir);
  if (!ready || ready.pid === process.pid || !isAlive(ready.pid)) return null;
  return ready;
}

export function writeEndpoint(dir: string, ready: ServerReady): void {
  writeFileAtomic(endpointFilePath(dir), JSON.stringify(ready));
}

export function removeEndpoint(dir: string, pid: number): void {
  if (readEndpointFile(dir)?.pid !== pid) return;
  try {
    rmSync(endpointFilePath(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
