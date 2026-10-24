import type { RunRef } from "@cw-code/contracts";
import { runKey } from "../github/RunWatcher.js";

export class ClientInputs {
  private readonly runRefs = new Map<string, RunRef[]>();
  private readonly paths = new Map<string, Map<string, string[]>>();

  setRunRefs(clientId: string, refs: RunRef[]): void {
    this.runRefs.set(clientId, refs);
  }

  clearRunRefs(clientId: string): void {
    this.runRefs.delete(clientId);
  }

  runRefsUnion(clientIds: readonly string[], max: number): RunRef[] {
    const queues = clientIds.map((clientId) => this.runRefs.get(clientId) ?? []);
    const picked = new Map<string, RunRef>();
    const depth = Math.max(0, ...queues.map((queue) => queue.length));
    for (let index = 0; index < depth && picked.size < max; index += 1) {
      for (const queue of queues) {
        const ref = queue[index];
        if (!ref || picked.size >= max) continue;
        const key = runKey(ref);
        if (!picked.has(key)) picked.set(key, ref);
      }
    }
    return [...picked.values()];
  }

  setPaths(clientId: string, sessionId: string, paths: string[]): void {
    const bySession = this.paths.get(clientId) ?? new Map<string, string[]>();
    bySession.set(sessionId, paths);
    this.paths.set(clientId, bySession);
  }

  clearPaths(clientId: string, sessionId: string): void {
    const bySession = this.paths.get(clientId);
    if (!bySession) return;
    bySession.delete(sessionId);
    if (bySession.size === 0) this.paths.delete(clientId);
  }

  pathsUnion(sessionId: string, clientIds: readonly string[]): string[] {
    const union = new Set<string>();
    for (const clientId of clientIds) {
      for (const path of this.paths.get(clientId)?.get(sessionId) ?? []) union.add(path);
    }
    return [...union].sort();
  }

  dropClient(clientId: string): void {
    this.runRefs.delete(clientId);
    this.paths.delete(clientId);
  }
}
