import type { ServerReady } from "@cw-code/contracts";
import { isProcessAlive } from "@cw-code/server/transport/endpointFile";
import { STOP_PATH } from "@cw-code/shared/protocol";

const STOP_REQUEST_TIMEOUT_MS = 3_000;
const PID_POLL_MS = 100;

export type StartDecision =
  | { kind: "spawn" }
  | { kind: "attach"; ready: ServerReady }
  | { kind: "replace"; ready: ServerReady }
  | { kind: "foreign"; ready: ServerReady };

export interface LauncherIdentity {
  installId: string;
  version: string;
  protocol: number;
}

export function decideServerStart(existing: ServerReady | null, me: LauncherIdentity): StartDecision {
  if (!existing) return { kind: "spawn" };
  if (!existing.launcherId || existing.launcherId !== me.installId) return { kind: "foreign", ready: existing };
  if (existing.version === me.version && existing.protocol === me.protocol) return { kind: "attach", ready: existing };
  return { kind: "replace", ready: existing };
}

export function stopUrl(ready: ServerReady): string {
  return new URL(STOP_PATH, ready.url.replace(/^ws/i, "http")).href;
}

export async function requestServerStop(ready: ServerReady, token: string): Promise<void> {
  const response = await fetch(stopUrl(ready), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(STOP_REQUEST_TIMEOUT_MS)
  });
  if (response.status !== 202) throw new Error(`the running cw-code server refused to stop (HTTP ${response.status})`);
}

export async function waitForPidExit(pid: number, timeoutMs: number, isAlive: (pid: number) => boolean = isProcessAlive): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, PID_POLL_MS));
  }
}
