import { describe, expect, it, vi } from "vitest";
import type { AccountUsageOk } from "@cw-code/contracts";
import { mapCodexAccountGate, mapCodexUsage } from "./codexAccountUsage.js";

const NOW = Date.parse("2026-09-24T00:00:00Z");

describe("mapCodexUsage", () => {
  it("maps the live ChatGPT Plus shape", () => {
    const account = { account: { type: "chatgpt", email: "dev@example.com" }, requiresOpenaiAuth: false };
    const rateLimits = {
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: "codex",
        limitName: null,
        normalModelSlug: "gpt-6-astra",
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1790235336 },
        secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1790235336 },
        credits: { hasCredits: false, unlimited: false, balance: null },
        individualLimit: null,
        spendControlReached: false,
        planType: "plus",
        rateLimitReachedType: null
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: 1, credits: null },
      accountId: "acc_1",
      rateLimitUpsell: null
    };

    const state = mapCodexUsage(account, rateLimits, NOW) as AccountUsageOk;
    expect(state.status).toBe("ok");
    expect(state.plan).toBe("ChatGPT Plus");
    expect(state.windows).toEqual([
      { id: "codex:primary", label: "5-hour window", percent: 0, resetsAt: 1790235336_000, severity: "normal" },
      { id: "codex:secondary", label: "Weekly window", percent: 9, resetsAt: 1790235336_000, severity: "normal" }
    ]);
    expect(state.balances).toEqual([
      { id: "credits", label: "Credits", enabled: false, detail: "None" },
      { id: "resetCredits", label: "Limit reset credits", enabled: true, detail: "1 available" }
    ]);
  });

  it("labels windows by duration, not by primary/secondary position", () => {
    const account = { account: { type: "chatgpt" }, requiresOpenaiAuth: false };
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        limitName: "gpt-6-astra",
        primary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1790235336 },
        secondary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1790235336 },
        credits: null,
        planType: "pro",
        rateLimitReachedType: null
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null
    };

    const state = mapCodexUsage(account, rateLimits, NOW) as AccountUsageOk;
    expect(state.windows).toEqual([
      { id: "codex:primary", label: "gpt-6-astra · Weekly window", percent: 9, resetsAt: 1790235336_000, severity: "normal" },
      { id: "codex:secondary", label: "gpt-6-astra · 5-hour window", percent: 0, resetsAt: 1790235336_000, severity: "normal" }
    ]);
  });

  it("treats an API-key account as unavailable", () => {
    const state = mapCodexUsage({ account: { type: "apiKey" }, requiresOpenaiAuth: false }, {}, NOW);
    expect(state).toEqual({
      status: "unavailable",
      reason: "api-key",
      message: "Signed in with an API key; plan limits aren't available."
    });
  });

  it("treats a null account as logged out", () => {
    const state = mapCodexUsage({ account: null, requiresOpenaiAuth: true }, {}, NOW);
    expect(state).toEqual({
      status: "unavailable",
      reason: "logged-out",
      message: "Sign in to Codex CLI to see plan usage."
    });
  });

  it("marks a window blocked when the snapshot's rate limit was reached", () => {
    const account = { account: { type: "chatgpt" } };
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1790235336 },
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: "primary"
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null
    };

    const state = mapCodexUsage(account, rateLimits, NOW) as AccountUsageOk;
    expect(state.windows).toEqual([
      { id: "codex:primary", label: "5-hour window", percent: 42, resetsAt: 1790235336_000, severity: "blocked" }
    ]);
  });

  it("zeroes out a window whose reset time is already in the past", () => {
    const account = { account: { type: "chatgpt" } };
    const pastResetsAt = Math.floor((NOW - 60_000) / 1000);
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 67, windowDurationMins: 300, resetsAt: pastResetsAt },
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: null
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null
    };

    const state = mapCodexUsage(account, rateLimits, NOW) as AccountUsageOk;
    expect(state.windows).toEqual([
      { id: "codex:primary", label: "5-hour window", percent: 0, resetsAt: pastResetsAt * 1000, severity: "normal" }
    ]);
  });

  it("stays normal for a past-reset window even when the snapshot's limit was reached", () => {
    const account = { account: { type: "chatgpt" } };
    const pastResetsAt = Math.floor((NOW - 60_000) / 1000);
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: pastResetsAt },
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: "primary"
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null
    };

    const state = mapCodexUsage(account, rateLimits, NOW) as AccountUsageOk;
    expect(state.windows).toEqual([
      { id: "codex:primary", label: "5-hour window", percent: 0, resetsAt: pastResetsAt * 1000, severity: "normal" }
    ]);
  });

  it("uses the rateLimitsByLimitId map key as the window id, not the snapshot's inner limitId", () => {
    const account = { account: { type: "chatgpt" } };
    const rateLimits = {
      rateLimits: null,
      rateLimitsByLimitId: {
        "gpt-6-astra": {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1790235336 },
          secondary: null,
          credits: null,
          planType: "plus",
          rateLimitReachedType: null
        },
        "gpt-6-nova": {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1790235336 },
          secondary: null,
          credits: null,
          planType: "plus",
          rateLimitReachedType: null
        }
      },
      rateLimitResetCredits: null
    };

    const state = mapCodexUsage(account, rateLimits, NOW) as AccountUsageOk;
    const ids = state.windows.map((w) => w.id);
    expect(ids).toEqual(["gpt-6-astra:primary", "gpt-6-nova:primary"]);
    expect(new Set(ids).size).toBe(2);
  });

  it("marks unlimited credits as enabled with an Unlimited detail", () => {
    const account = { account: { type: "chatgpt" } };
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1790235336 },
        secondary: null,
        credits: { hasCredits: false, unlimited: true, balance: null },
        planType: "plus",
        rateLimitReachedType: null
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null
    };

    const state = mapCodexUsage(account, rateLimits, NOW) as AccountUsageOk;
    expect(state.balances).toEqual([{ id: "credits", label: "Credits", enabled: true, detail: "Unlimited" }]);
  });

  it("labels sub-hour windows in minutes and non-whole-hour windows with one decimal", () => {
    const account = { account: { type: "chatgpt" } };
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 0, windowDurationMins: 45, resetsAt: 1790235336 },
        secondary: { usedPercent: 0, windowDurationMins: 90, resetsAt: 1790235336 },
        credits: null,
        planType: "plus",
        rateLimitReachedType: null
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null
    };

    const state = mapCodexUsage(account, rateLimits, NOW) as AccountUsageOk;
    expect(state.windows.map((w) => w.label)).toEqual(["45m window", "1.5h window"]);
  });

  it("returns an error when the rate-limits response has neither rateLimits nor rateLimitsByLimitId", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = { account: { type: "chatgpt" } };
    const state = mapCodexUsage(account, { ordinaryUsageAllowed: true, rateLimits: null, rateLimitsByLimitId: null }, NOW);
    expect(state).toEqual({ status: "error", message: "Unexpected account/rateLimits/read response" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("codex account/rateLimits/read"));
    warn.mockRestore();
  });

  it("returns an error when the only snapshot has neither a primary nor a secondary window", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = { account: { type: "chatgpt" } };
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: null,
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: null
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null
    };
    const state = mapCodexUsage(account, rateLimits, NOW);
    expect(state).toEqual({ status: "error", message: "Unexpected account/rateLimits/read response" });
    warn.mockRestore();
  });

  it("returns an error when the rate-limits response is malformed garbage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = { account: { type: "chatgpt" } };
    expect(mapCodexUsage(account, "nope", NOW)).toEqual({
      status: "error",
      message: "Unexpected account/rateLimits/read response"
    });
    expect(mapCodexUsage(account, null, NOW)).toEqual({
      status: "error",
      message: "Unexpected account/rateLimits/read response"
    });
    warn.mockRestore();
  });
});

describe("mapCodexAccountGate", () => {
  it("gates on a null account", () => {
    expect(mapCodexAccountGate({ account: null })).toEqual({
      status: "unavailable",
      reason: "logged-out",
      message: "Sign in to Codex CLI to see plan usage."
    });
  });

  it("gates on an apiKey account", () => {
    expect(mapCodexAccountGate({ account: { type: "apiKey" } })).toEqual({
      status: "unavailable",
      reason: "api-key",
      message: "Signed in with an API key; plan limits aren't available."
    });
  });

  it("passes through a chatgpt account", () => {
    expect(mapCodexAccountGate({ account: { type: "chatgpt" } })).toBeNull();
  });
});
