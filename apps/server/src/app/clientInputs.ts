import type { PrRef } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";

export const MAX_WATCHED_PRS_PER_CLIENT = 20;

export class ClientInputs {
  private readonly paths = new Map<string, Map<string, string[]>>();
  private readonly prs = new Map<string, Map<string, PrRef>>();

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

  watchPr(clientId: string, ref: PrRef): boolean {
    const key = prKey(ref);
    const byKey = this.prs.get(clientId) ?? new Map<string, PrRef>();
    if (byKey.has(key)) return false;
    if (byKey.size >= MAX_WATCHED_PRS_PER_CLIENT) throw new Error(`a client can watch at most ${MAX_WATCHED_PRS_PER_CLIENT} pull requests`);
    byKey.set(key, ref);
    this.prs.set(clientId, byKey);
    return true;
  }

  unwatchPr(clientId: string, ref: PrRef): boolean {
    const byKey = this.prs.get(clientId);
    if (!byKey?.delete(prKey(ref))) return false;
    if (byKey.size === 0) this.prs.delete(clientId);
    return true;
  }

  watchedPrs(): Map<string, PrRef> {
    const union = new Map<string, PrRef>();
    for (const byKey of this.prs.values()) {
      for (const [key, ref] of byKey) if (!union.has(key)) union.set(key, ref);
    }
    return union;
  }

  dropClient(clientId: string): { prsChanged: boolean } {
    this.paths.delete(clientId);
    return { prsChanged: this.prs.delete(clientId) };
  }
}
