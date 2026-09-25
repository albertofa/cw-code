import type { AccountUsageOk, AccountUsageSnapshot, AccountUsageState, CliDriver, DriverKind } from "@cw-code/contracts";

const FRESHNESS_MS = 60_000;

interface CacheEntry {
  snapshot: AccountUsageSnapshot;
  fetchedAt: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AccountUsageService {
  private cache = new Map<DriverKind, CacheEntry>();
  private inFlight = new Map<DriverKind, Promise<AccountUsageSnapshot>>();
  private lastGood = new Map<DriverKind, { fetchedAt: number; state: AccountUsageOk }>();
  private generations = new Map<DriverKind, number>();

  constructor(
    private drivers: () => Record<DriverKind, CliDriver>,
    private now: () => number = Date.now
  ) {}

  async get(drivers: DriverKind[], force: boolean): Promise<AccountUsageSnapshot[]> {
    const results = await Promise.all(drivers.map((driver) => this.getOne(driver, force)));
    return results.filter((result): result is AccountUsageSnapshot => result !== null);
  }

  invalidate(driver: DriverKind): void {
    this.cache.delete(driver);
    this.inFlight.delete(driver);
    this.generations.set(driver, this.generationOf(driver) + 1);
  }

  private generationOf(driver: DriverKind): number {
    return this.generations.get(driver) ?? 0;
  }

  private getOne(driver: DriverKind, force: boolean): Promise<AccountUsageSnapshot | null> {
    if (!force) {
      const cached = this.cache.get(driver);
      if (cached && this.now() - cached.fetchedAt < FRESHNESS_MS) return Promise.resolve(cached.snapshot);
    }
    const inFlight = this.inFlight.get(driver);
    if (inFlight) return inFlight;
    const driverImpl = this.drivers()[driver];
    if (!driverImpl || typeof driverImpl.getAccountUsage !== "function") return Promise.resolve(null);
    const generation = this.generationOf(driver);
    const promise = this.fetch(driver, driverImpl, generation).finally(() => {
      if (this.inFlight.get(driver) === promise) this.inFlight.delete(driver);
    });
    this.inFlight.set(driver, promise);
    return promise;
  }

  private async fetch(driver: DriverKind, driverImpl: CliDriver, generation: number): Promise<AccountUsageSnapshot> {
    const fetchedAt = this.now();
    let state: AccountUsageState;
    try {
      state = await driverImpl.getAccountUsage!();
    } catch (err) {
      state = { status: "error", message: errorMessage(err) };
    }
    const stale = generation !== this.generationOf(driver);
    if (!stale && state.status === "ok") this.lastGood.set(driver, { fetchedAt, state });
    const good = this.lastGood.get(driver);
    const snapshot: AccountUsageSnapshot = {
      driver,
      fetchedAt,
      state,
      ...(state.status !== "ok" && good ? { lastGood: good } : {})
    };
    if (!stale) this.cache.set(driver, { snapshot, fetchedAt });
    return snapshot;
  }
}
