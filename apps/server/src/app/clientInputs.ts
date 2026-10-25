export class ClientInputs {
  private readonly paths = new Map<string, Map<string, string[]>>();

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
    this.paths.delete(clientId);
  }
}
