import { describe, expect, it } from "vitest";
import type { PrLinkSnapshot, PrSummary } from "@cw-code/contracts";
import {
  PR_CLOSED_INTERVAL_MS,
  PR_IDLE_AFTER_MS,
  PR_IDLE_INTERVAL_MS,
  isPrDue,
  isValidSnapshot,
  snapshotOf,
  summaryChanged,
  type TrackedPrEntry
} from "./prTracking.js";

const NOW = 10_000_000;
const ref = { host: "github.com", owner: "acme", repo: "widgets", number: 1 };

function entry(snapshot: Partial<PrLinkSnapshot> | null, forced = false): TrackedPrEntry {
  return {
    ref,
    forced,
    ...(snapshot ? { snapshot: { state: "OPEN", headRefOid: "sha", updatedAt: NOW, syncedAt: NOW, ...snapshot } } : {})
  };
}

describe("isPrDue", () => {
  it("is due without a snapshot or when forced", () => {
    expect(isPrDue(entry(null), NOW)).toBe(true);
    expect(isPrDue(entry({ state: "MERGED" }, true), NOW)).toBe(true);
  });

  it("refreshes active open PRs every tick", () => {
    expect(isPrDue(entry({ updatedAt: NOW - PR_IDLE_AFTER_MS, syncedAt: NOW }), NOW)).toBe(true);
  });

  it("slows idle open PRs to the idle interval since the last sync", () => {
    const idleUpdate = NOW - PR_IDLE_AFTER_MS - 1;
    expect(isPrDue(entry({ updatedAt: idleUpdate, syncedAt: NOW - PR_IDLE_INTERVAL_MS + 1 }), NOW)).toBe(false);
    expect(isPrDue(entry({ updatedAt: idleUpdate, syncedAt: NOW - PR_IDLE_INTERVAL_MS }), NOW)).toBe(true);
  });

  it("treats an unknown updatedAt as active", () => {
    expect(isPrDue(entry({ updatedAt: 0, syncedAt: NOW }), NOW)).toBe(true);
  });

  it("refreshes closed PRs on the closed interval", () => {
    expect(isPrDue(entry({ state: "CLOSED", syncedAt: NOW - PR_CLOSED_INTERVAL_MS + 1 }), NOW)).toBe(false);
    expect(isPrDue(entry({ state: "CLOSED", syncedAt: NOW - PR_CLOSED_INTERVAL_MS }), NOW)).toBe(true);
  });

  it("never refreshes merged PRs that already have a snapshot", () => {
    expect(isPrDue(entry({ state: "MERGED", syncedAt: 0 }), NOW)).toBe(false);
  });
});

describe("snapshotOf", () => {
  it("copies state, head, updatedAt and stamps syncedAt", () => {
    const summary = { state: "MERGED", headRefOid: "abc", updatedAt: 42 } as PrSummary;
    expect(snapshotOf(summary, 99)).toEqual({ state: "MERGED", headRefOid: "abc", updatedAt: 42, syncedAt: 99 });
  });
});

describe("isValidSnapshot", () => {
  const valid = { state: "OPEN", headRefOid: "sha", updatedAt: 1, syncedAt: 2 };

  it("accepts a well-formed snapshot", () => {
    expect(isValidSnapshot(valid)).toBe(true);
  });

  it("rejects a syncedAt in the future beyond clock skew but tolerates small skew", () => {
    expect(isValidSnapshot({ ...valid, syncedAt: 1_000_000 + 60_001 }, 1_000_000)).toBe(false);
    expect(isValidSnapshot({ ...valid, syncedAt: 1_000_000 + 60_000 }, 1_000_000)).toBe(true);
  });

  it.each([
    ["unknown state", { ...valid, state: "DRAFT" }],
    ["non-finite updatedAt", { ...valid, updatedAt: Number.NaN }],
    ["string syncedAt", { ...valid, syncedAt: "2" }],
    ["missing head", { ...valid, headRefOid: undefined }],
    ["null", null],
    ["string", "OPEN"]
  ])("rejects %s", (_name, value) => {
    expect(isValidSnapshot(value)).toBe(false);
  });
});

describe("summaryChanged", () => {
  const base = {
    state: "OPEN",
    headRefOid: "a",
    updatedAt: 1,
    ci: "passing",
    review: "none",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checks: { total: 2, passed: 2, failed: 0, pending: 0 },
    isDraft: false,
    title: "t"
  } as unknown as PrSummary;

  it("treats a first summary as changed", () => {
    expect(summaryChanged(undefined, base)).toBe(true);
  });

  it("ignores fields outside the tracked set", () => {
    expect(summaryChanged(base, { ...base, title: "other" })).toBe(false);
  });

  it.each([
    ["state", { state: "MERGED" }],
    ["headRefOid", { headRefOid: "b" }],
    ["updatedAt", { updatedAt: 2 }],
    ["ci", { ci: "failing" }],
    ["review", { review: "approved" }],
    ["mergeable", { mergeable: "CONFLICTING" }],
    ["mergeStateStatus", { mergeStateStatus: "BLOCKED" }],
    ["checks total", { checks: { total: 3, passed: 2, failed: 0, pending: 1 } }],
    ["checks passed", { checks: { total: 2, passed: 1, failed: 1, pending: 0 } }],
    ["checks pending", { checks: { total: 2, passed: 1, failed: 0, pending: 1 } }],
    ["isDraft", { isDraft: true }]
  ])("detects a %s change", (_name, patch) => {
    expect(summaryChanged(base, { ...base, ...patch } as PrSummary)).toBe(true);
  });
});
