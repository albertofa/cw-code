import type { ServerReady } from "@cw-code/contracts";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../storage/atomicFile.js";

const ENDPOINT_FILE = "server.json";
const PROBE_TIMEOUT_MS = 1000;
const UPGRADE_REQUIRED = 426;

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

async function probeServer(url: string): Promise<boolean> {
  try {
    const response = await fetch(url.replace(/^ws/, "http"), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "manual" });
    return response.status === UPGRADE_REQUIRED;
  } catch {
    return false;
  }
}

export function confirmLiveEndpoint(ready: ServerReady, probe: (url: string) => Promise<boolean> = probeServer): Promise<boolean> {
  return probe(ready.url).catch(() => false);
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
