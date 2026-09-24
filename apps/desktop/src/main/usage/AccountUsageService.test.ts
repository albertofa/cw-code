import { describe, expect, it, vi } from "vitest";
import type { AccountUsageState, CliDriver, DriverKind } from "@cw-code/contracts";
import { AccountUsageService } from "./AccountUsageService.js";

function fakeDriver(kind: DriverKind, getAccountUsage?: () => Promise<AccountUsageState>): CliDriver {
  return {
    kind,
    listSessions: async () => [],
    getHistory: async () => [],
    startTurn: () => ({ turnId: "t", events: (async function* () {})() }),
    interrupt: () => {},
    renameSession: async () => {},
    events: async function* () {},
    ...(getAccountUsage ? { getAccountUsage } : {})
  } as CliDriver;
}

const OK_STATE: AccountUsageState = { status: "ok", windows: [], balances: [], notes: [] };

describe("AccountUsageService", () => {
  it("serves the cache when a driver was fetched under 60s ago", async () => {
    const fetchFn = vi.fn().mockResolvedValue(OK_STATE);
    const drivers = { claude: fakeDriver("claude", fetchFn) } as unknown as Record<DriverKind, CliDriver>;
    let now = 1_000;
    const service = new AccountUsageService(() => drivers, () => now);

    await service.get(["claude"], false);
    now += 30_000;
    await service.get(["claude"], false);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refetches past the 60s freshness window", async () => {
    const fetchFn = vi.fn().mockResolvedValue(OK_STATE);
    const drivers = { claude: fakeDriver("claude", fetchFn) } as unknown as Record<DriverKind, CliDriver>;
    let now = 1_000;
    const service = new AccountUsageService(() => drivers, () => now);

    await service.get(["claude"], false);
    now += 61_000;
    await service.get(["claude"], false);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("forces a refetch when force is true even inside the freshness window", async () => {
    const fetchFn = vi.fn().mockResolvedValue(OK_STATE);
    const drivers = { claude: fakeDriver("claude", fetchFn) } as unknown as Record<DriverKind, CliDriver>;
    const service = new AccountUsageService(() => drivers, () => 1_000);

    await service.get(["claude"], false);
    await service.get(["claude"], true);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("shares in-flight calls for concurrent requests", async () => {
    let resolveFetch: (state: AccountUsageState) => void = () => {};
    const fetchFn = vi.fn(
      () =>
        new Promise<AccountUsageState>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const drivers = { claude: fakeDriver("claude", fetchFn) } as unknown as Record<DriverKind, CliDriver>;
    const service = new AccountUsageService(() => drivers);

    const p1 = service.get(["claude"], false);
    const p2 = service.get(["claude"], false);
    resolveFetch(OK_STATE);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it("keeps lastGood when a later fetch errors", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(OK_STATE).mockRejectedValueOnce(new Error("boom"));
    const drivers = { claude: fakeDriver("claude", fetchFn) } as unknown as Record<DriverKind, CliDriver>;
    let now = 1_000;
    const service = new AccountUsageService(() => drivers, () => now);

    const [firstSnapshot] = await service.get(["claude"], false);
    now += 61_000;
    const [secondSnapshot] = await service.get(["claude"], false);

    expect(firstSnapshot.state.status).toBe("ok");
    expect(secondSnapshot.state).toEqual({ status: "error", message: "boom" });
    expect(secondSnapshot.lastGood).toEqual({ fetchedAt: 1_000, state: OK_STATE });
  });

  it("skips drivers without getAccountUsage", async () => {
    const drivers = { claude: fakeDriver("claude") } as unknown as Record<DriverKind, CliDriver>;
    const service = new AccountUsageService(() => drivers);

    const snapshots = await service.get(["claude"], false);

    expect(snapshots).toEqual([]);
  });

  it("invalidate() forces the next call to refetch", async () => {
    const fetchFn = vi.fn().mockResolvedValue(OK_STATE);
    const drivers = { claude: fakeDriver("claude", fetchFn) } as unknown as Record<DriverKind, CliDriver>;
    const service = new AccountUsageService(() => drivers, () => 1_000);

    await service.get(["claude"], false);
    service.invalidate("claude");
    await service.get(["claude"], false);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("drops a stale in-flight result after invalidate, so the next get starts fresh and does not cache it", async () => {
    const okA: AccountUsageState = { status: "ok", plan: "A", windows: [], balances: [], notes: [] };
    const okB: AccountUsageState = { status: "ok", plan: "B", windows: [], balances: [], notes: [] };
    let resolveFirst: (state: AccountUsageState) => void = () => {};
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AccountUsageState>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce(okB);
    const drivers = { claude: fakeDriver("claude", fetchFn) } as unknown as Record<DriverKind, CliDriver>;
    const service = new AccountUsageService(() => drivers, () => 1_000);

    const p1 = service.get(["claude"], false);
    service.invalidate("claude");
    const p2 = service.get(["claude"], false);
    resolveFirst(okA);
    const [[snap1], [snap2]] = await Promise.all([p1, p2]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(snap1.state).toEqual(okA);
    expect(snap2.state).toEqual(okB);

    const [cached] = await service.get(["claude"], false);
    expect(cached.state).toEqual(okB);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("skips a driver kind that isn't in the drivers map", async () => {
    const service = new AccountUsageService(() => ({}) as Record<DriverKind, CliDriver>);

    const snapshots = await service.get(["claude"], false);

    expect(snapshots).toEqual([]);
  });

  it("falls back to String(err) when a non-Error value is thrown", async () => {
    const fetchFn = vi.fn().mockRejectedValue("boom");
    const drivers = { claude: fakeDriver("claude", fetchFn) } as unknown as Record<DriverKind, CliDriver>;
    const service = new AccountUsageService(() => drivers);

    const [snapshot] = await service.get(["claude"], false);

    expect(snapshot.state).toEqual({ status: "error", message: "boom" });
  });
});
