import type { AccountUsageEntry, DriverKind, UsageTopicData, UsageTotals } from "@cw-code/contracts";
import { USAGE_TOPIC } from "@cw-code/shared/topics";
import { peekTopic, useTopicSelect } from "../server/topics.js";

const EMPTY_ENTRY: AccountUsageEntry = { snapshot: null, loading: false, error: null };

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  totalTokens: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  costUsd: null,
  turns: 0,
  sessions: 0,
  unpricedTurns: 0
};

export function useAccountUsage(driver: DriverKind, enabled = true): AccountUsageEntry {
  return useTopicSelect<AccountUsageEntry, UsageTopicData>(enabled ? USAGE_TOPIC : null, (state) => state?.data.account?.[driver] ?? EMPTY_ENTRY);
}

export function useAccountFetchedAt(): number | null {
  return useTopicSelect<number | null, UsageTopicData>(USAGE_TOPIC, (state) => state?.data.accountFetchedAt ?? null);
}

export function useLedgerRev(): number | null {
  return useTopicSelect<number | null, UsageTopicData>(USAGE_TOPIC, (state) => state?.data.ledgerRev ?? null);
}

export function accountEntryNow(driver: DriverKind): AccountUsageEntry {
  return peekTopic<UsageTopicData>(USAGE_TOPIC)?.data.account?.[driver] ?? EMPTY_ENTRY;
}

export function accountRefreshFailed(driver: DriverKind): boolean {
  const entry = accountEntryNow(driver);
  return entry.error !== null || entry.snapshot?.state.status === "error";
}
