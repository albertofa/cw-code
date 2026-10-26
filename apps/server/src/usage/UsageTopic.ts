import type {
  AccountUsageEntry,
  AccountUsageSnapshot,
  DriverKind,
  UsageReport,
  UsageReportQuery,
  UsageTopicData,
  UsageTotals
} from "@cw-code/contracts";
import { USAGE_TOPIC } from "@cw-code/shared/topics";
import type { TopicHub, TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import { sinceDayFor, totals, usageReport } from "./usageReport.js";
import type { UsageLedgerQuery, UsageLedgerRow } from "./ledgerTypes.js";

export const ACCOUNT_REFRESH_MS = 5 * 60 * 1000;

const DRIVERS: readonly DriverKind[] = ["claude", "codex", "opencode"];

export interface UsageTopicDeps {
  accountUsage: { get(drivers: DriverKind[], force: boolean): Promise<AccountUsageSnapshot[]> };
  ledgerRows(query: UsageLedgerQuery): UsageLedgerRow[];
  onUsageRecorded(cb: (sessionId: string) => void): () => void;
  now?: () => number;
}

type UsageStore = TopicStore<UsageTopicData>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyEntry(): AccountUsageEntry {
  return { snapshot: null, loading: false, error: null };
}

function emptyAccount(): Record<DriverKind, AccountUsageEntry> {
  return { claude: emptyEntry(), codex: emptyEntry(), opencode: emptyEntry() };
}

export class UsageTopic implements TopicProvider {
  readonly exactTopics = [USAGE_TOPIC];
  private data: UsageTopicData = { account: emptyAccount(), accountFetchedAt: null, ledgerRev: 0 };
  private store: UsageStore | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly hub: TopicHub,
    private readonly deps: UsageTopicDeps
  ) {
    deps.onUsageRecorded(() => this.recordTurn());
  }

  owns(topic: string): boolean {
    return topic === USAGE_TOPIC;
  }

  acquire(topic: string): UsageStore {
    this.store = null;
    this.setLoading(DRIVERS.filter((driver) => this.data.account[driver].snapshot === null), true);
    this.store = this.hub.createStore<UsageTopicData>(topic, { ...this.data });
    return this.store;
  }

  release(): void {
    this.stopTimer();
    this.store = null;
  }

  onSubscribe(): void {
    this.ensureRefreshing();
  }

  resync(): void {
    this.ensureRefreshing();
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
  }

  resume(): void {
    if (!this.disposed) return;
    this.disposed = false;
    if (this.store) this.ensureRefreshing();
  }

  get ledgerRev(): number {
    return this.data.ledgerRev;
  }

  report(query: UsageReportQuery): UsageReport {
    const today = new Date((this.deps.now ?? Date.now)());
    const rows = this.deps.ledgerRows({ sinceDay: sinceDayFor(query.days, today) });
    return usageReport(rows, query, today, this.data.ledgerRev);
  }

  sessionTotals(sessionId: string): UsageTotals | null {
    const rows = this.deps.ledgerRows({ sessionId });
    return rows.length === 0 ? null : totals(rows);
  }

  async refreshAccount(force: boolean, drivers: readonly DriverKind[] = DRIVERS): Promise<void> {
    this.setLoading(drivers.filter((driver) => force || this.data.account[driver].snapshot === null), true);
    await Promise.all(drivers.map((driver) => this.refreshDriver(driver, force)));
  }

  private recordTurn(): void {
    this.data = { ...this.data, ledgerRev: this.data.ledgerRev + 1 };
    this.store?.upsert("ledgerRev", this.data.ledgerRev);
  }

  private ensureRefreshing(): void {
    if (this.disposed || this.timer) return;
    void this.refreshAccount(false);
    this.timer = setInterval(() => void this.refreshAccount(false), ACCOUNT_REFRESH_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async refreshDriver(driver: DriverKind, force: boolean): Promise<void> {
    let entry: AccountUsageEntry;
    try {
      const [snapshot] = await this.deps.accountUsage.get([driver], force);
      entry = { snapshot: snapshot ?? this.data.account[driver].snapshot, loading: false, error: null };
    } catch (error) {
      entry = { ...this.data.account[driver], loading: false, error: errorMessage(error) };
    }
    if (this.disposed) return;
    this.setEntry(driver, entry);
    if (entry.error === null) this.markFetched();
  }

  private markFetched(): void {
    this.data = { ...this.data, accountFetchedAt: (this.deps.now ?? Date.now)() };
    this.store?.upsert("accountFetchedAt", this.data.accountFetchedAt);
  }

  private setLoading(drivers: readonly DriverKind[], loading: boolean): void {
    for (const driver of drivers) this.setEntry(driver, { ...this.data.account[driver], loading });
  }

  private setEntry(driver: DriverKind, entry: AccountUsageEntry): void {
    this.data = { ...this.data, account: { ...this.data.account, [driver]: entry } };
    this.store?.upsert("account", this.data.account);
  }
}
