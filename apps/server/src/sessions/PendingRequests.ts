import type { ApprovalRequest, QuestionRequest } from "@cw-code/contracts";

export type PendingRequest =
  | { kind: "approval"; sessionId: string; turnId: string; request: ApprovalRequest }
  | { kind: "question"; sessionId: string; turnId: string; request: QuestionRequest };

export class RequestNotPendingError extends Error {
  readonly code = "request-not-pending";

  constructor(requestId: string) {
    super(`request ${requestId} is no longer pending`);
    this.name = "RequestNotPendingError";
  }
}

export class PendingRequests {
  private readonly entries = new Map<string, PendingRequest>();
  private readonly claimed = new Set<string>();

  add(entry: PendingRequest): void {
    const requestId = entry.request.requestId;
    this.entries.set(requestId, entry);
    this.claimed.delete(requestId);
  }

  resolve(requestId: string): PendingRequest | null {
    const entry = this.entries.get(requestId);
    if (!entry) return null;
    this.remove(requestId);
    return entry;
  }

  claim(requestId: string, kind: PendingRequest["kind"]): PendingRequest {
    const entry = this.entries.get(requestId);
    if (!entry || entry.kind !== kind || this.claimed.has(requestId)) throw new RequestNotPendingError(requestId);
    this.claimed.add(requestId);
    return entry;
  }

  release(entry: PendingRequest): boolean {
    const requestId = entry.request.requestId;
    if (this.entries.get(requestId) !== entry) return false;
    return this.claimed.delete(requestId);
  }

  list(sessionId: string): PendingRequest[] {
    return [...this.entries].filter(([requestId, entry]) => entry.sessionId === sessionId && !this.claimed.has(requestId)).map(([, entry]) => entry);
  }

  clearTurn(turnId: string): PendingRequest[] {
    return this.removeWhere((entry) => entry.turnId === turnId);
  }

  clearSession(sessionId: string): PendingRequest[] {
    return this.removeWhere((entry) => entry.sessionId === sessionId);
  }

  private removeWhere(match: (entry: PendingRequest) => boolean): PendingRequest[] {
    const removed = [...this.entries.values()].filter(match);
    for (const entry of removed) this.remove(entry.request.requestId);
    return removed;
  }

  private remove(requestId: string): void {
    this.entries.delete(requestId);
    this.claimed.delete(requestId);
  }
}
