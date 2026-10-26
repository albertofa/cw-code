import type { DriverKind, TokenCounts } from "@cw-code/contracts";

export interface UsageLedgerRow extends TokenCounts {
  day: string;
  sessionId: string;
  projectId: string;
  driver: DriverKind;
  model: string;
  turns: number;
  costUsd: number | null;
  unpricedTurns: number;
}

export interface UsageLedgerQuery {
  sinceDay?: string;
  sessionId?: string;
}
