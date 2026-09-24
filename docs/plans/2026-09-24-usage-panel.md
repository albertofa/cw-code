# Plan: Usage panel

**Goal:** show each harness's subscription limits and cw-code's own record of tokens used per turn, in a Usage main view and in a context-ring dock in the composer.

**Constraints:**
- Visual reference: `design/mockups/usage-panel.html`. Variant A is the Usage view, B covers the degraded states, C is the ring and dock.
- No Usage entry in the sidebar nav and no sidebar stats card. The only entry points are a chart icon button placed right after the Settings button in the sidebar footer (`Sidebar.tsx:1272`) and the dock's "Open usage →" link.
- Plan limits are percentages plus reset times only. Never render an unknown value as 0%. Failures show a visible message (AGENTS.md).
- Claude: use only the `get_usage` control request. Never read `~/.claude/.credentials.json` and never call `api.anthropic.com/api/oauth/usage`.
- Codex: use only app-server `account/read` and `account/rateLimits/read`. Never read `~/.codex/auth.json`.
- OpenCode Go:
  - Only read `~/.local/share/opencode/auth.json` (the `opencode-go` entry, `key` field; honour `XDG_DATA_HOME`) when the new setting `opencodeGoUsage` is `true`. It defaults to `false`.
  - The key never leaves the main process, never crosses IPC and never goes into traces or logs.
  - The only request is `GET https://opencode.ai/zen/go/v1/usage`.
- Codex reports no cost, so `costUsd` is `null` and the UI shows "—". Cost is labelled "API-equivalent" everywhere.
- Provider colors are identity only. The combined chart stacks bottom-to-top Codex → Claude → OpenCode, which keeps Codex and OpenCode apart for colour-blind users (ΔE 22.8 vs 0.2 when they touch).
- Verified live on CLI 2.1.281 (2026-09-24):
  - Claude `result.usage` counts one turn and excludes subagents.
  - `result.modelUsage` and `total_cost_usd` add up across the process lifetime and start at zero for each new process, including on `--resume`.
  - `modelUsage[m].contextWindow` is present.

## Task 1: Contracts  [independent]

- **Files:** `packages/contracts/src/events.ts`, `packages/contracts/src/usage.ts` (new), `packages/contracts/src/provider.ts`, `packages/contracts/src/session.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/index.ts`
- **What:**
  - Replace `inputTokens`, `outputTokens` and `costUsd` on `turn.done` with `usage` and an optional `context`.
  - Add the account-usage and ledger types.
  - Add the optional driver method `getAccountUsage`.
  - Add the optional `contextWindow` field on `ModelOption`.
  - Add the `opencodeGoUsage: boolean` setting.
- **Interfaces:**
  ```ts
  // usage.ts
  export interface TokenCounts { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens: number }
  // inputTokens = uncached input; outputTokens includes reasoning; reasoningTokens is informational (subset of output)
  export interface TurnModelUsage extends TokenCounts { model: string; costUsd: number | null }
  export interface ContextUsage { usedTokens: number; windowTokens: number }
  export type UsageSeverity = "normal" | "warning" | "blocked";
  export interface UsageWindow { id: string; label: string; percent: number; resetsAt?: number /* epoch ms */; severity: UsageSeverity; active?: boolean }
  export interface UsageBalance { id: string; label: string; enabled: boolean; usedMinor?: number; limitMinor?: number; currency?: string; detail?: string }
  export type AccountUsageUnavailableReason = "api-key" | "no-subscription" | "logged-out" | "unsupported-version" | "not-installed" | "consent-required" | "key-rejected";
  export type AccountUsageState =
    | { status: "ok"; plan?: string; windows: UsageWindow[]; balances: UsageBalance[]; notes: string[] }
    | { status: "unavailable"; reason: AccountUsageUnavailableReason; message: string }
    | { status: "error"; message: string };
  export interface AccountUsageSnapshot { driver: DriverKind; fetchedAt: number; state: AccountUsageState; lastGood?: { fetchedAt: number; state: Extract<AccountUsageState, { status: "ok" }> } }
  export interface UsageLedgerRow extends TokenCounts { day: string /* local YYYY-MM-DD */; sessionId: string; projectId: string; driver: DriverKind; model: string; turns: number; costUsd: number | null; unpricedTurns: number }
  export interface UsageLedgerQuery { sinceDay?: string; sessionId?: string }
  // events.ts, turn.done
  usage: TurnModelUsage[]; context?: ContextUsage;   // replaces inputTokens/outputTokens/costUsd
  // provider.ts, CliDriver
  getAccountUsage?(): Promise<AccountUsageState>;
  // session.ts, ModelOption
  contextWindow?: number;
  // settings.ts, AppSettings
  opencodeGoUsage: boolean;
  ```
- **Tests:** none (types only).
- **Done when:** `pnpm --filter @cw-code/contracts typecheck` passes.

## Task 2: Claude per-turn usage  [depends on Task 1]

- **Files:** `apps/desktop/src/main/providers/claude/claudeStreamParser.ts`, `ClaudeCliDriver.ts`, a new `claudeUsage.ts` with its test
- **What:**
  - Parse `result.modelUsage` (inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, thinkingTokens, costUSD, contextWindow) and `result.usage.iterations`.
  - `ClaudeProcessState` keeps the previous cumulative `modelUsage` snapshot. Per-turn usage is the per-model delta against it; models with a zero delta are dropped.
  - Context:
    - `usedTokens` = the last entry of `result.usage.iterations`: input + cache_read + cache_creation + output.
    - `windowTokens` = `contextWindow` of the model with the largest output delta.
    - Omit `context` if either value is missing.
  - `result` messages without `modelUsage` give `usage: []`.
- **Interfaces:**
  - Produces `claudeTurnUsage(prev: ClaudeModelUsageSnapshot, result: unknown): { usage: TurnModelUsage[]; context?: ContextUsage; next: ClaudeModelUsageSnapshot }`.
  - `ClaudeModelUsageSnapshot = Record<string, TokenCounts & { costUsd: number }>`.
- **Tests:** `claudeUsage.test.ts`, run on fixtures shaped like the live probe:
  - two sequential results produce the second turn's delta;
  - two models (subagent) produce two entries;
  - missing `modelUsage` gives `[]`;
  - context calculation.
- **Done when:** `pnpm --filter @cw-code/desktop exec vitest run src/main/providers/claude` passes.

## Task 3: Codex per-turn usage  [depends on Task 1]

- **Files:** `apps/desktop/src/main/providers/codex/codexProtocol.ts`, `CodexCliDriver.ts`, `codexProtocol.test.ts` (or a new `codexUsage.test.ts`)
- **What:**
  - Replace `accumulateCodexUsage` with a function that adds each `last` breakdown **only when `total.totalTokens` changed** since the previous notification on that thread, which removes duplicates.
  - Mapping, where cached and cache-write counts are part of input:
    - `inputTokens = max(0, input − cached − cacheWrite)`
    - `cacheReadTokens = cached`
    - `cacheWriteTokens = cacheWrite`
    - `outputTokens = output`
    - `reasoningTokens = reasoningOutput`
  - Model = the turn's requested model, falling back to `defaultModelId()`, falling back to `"codex"`. `costUsd: null`.
  - Context: `usedTokens = last.totalTokens`, `windowTokens = modelContextWindow` (omitted when null).
- **Interfaces:**
  - Produces `accumulateCodexTurnUsage(acc: CodexTurnUsageAcc, usage: CodexTokenUsage): void`.
  - `CodexTurnUsageAcc = { counts: TokenCounts; lastTotal?: number; context?: ContextUsage }`.
  - The driver keeps `lastTotal` per thread across turns.
- **Tests:**
  - A repeated `total` is ignored.
  - Cached tokens aren't double counted: input 39846 with 39424 cached gives inputTokens 422 and cacheRead 39424.
  - A null window leaves out `context`.
- **Done when:** `pnpm --filter @cw-code/desktop exec vitest run src/main/providers/codex` passes.

## Task 4: OpenCode per-turn usage and model context window  [depends on Task 1]

- **Files:** `apps/desktop/src/main/providers/opencode/opencodeMessage.ts`, `opencodeModels.ts`, `OpencodeDriver.ts`, and their tests
- **What:**
  - `turnMessagesOf` also reads `info.providerID` and `info.modelID`.
  - `summarizeOpencodeTurn` groups the turn's fresh assistant messages by `${providerID}/${modelID}`:
    - `inputTokens = tokens.input`
    - `cacheRead/cacheWrite = tokens.cache.read/write`
    - `outputTokens = output + reasoning`
    - `reasoningTokens = reasoning`
    - `costUsd = Σ cost`
  - Context:
    - `usedTokens` = the last fresh assistant message: input + cache.read + cache.write + output + reasoning.
    - `windowTokens` = the `contextWindow` of that model from the cached model list.
    - Omit `context` if the model isn't in the list.
  - `parseOpencodeVerboseModels` fills `ModelOption.contextWindow` from the model JSON's `limit.context`.
- **Interfaces:**
  - `OpencodeTurnSummary` becomes `{ text; usage: TurnModelUsage[]; lastModel?: string; lastContextTokens?: number; errorText }`.
  - The driver resolves the window via `listOpencodeModels`'s cache (no extra CLI call if it's cached).
- **Tests:**
  - Grouping by model across two messages.
  - The verbose model parser reads `limit.context`.
  - Messages from before the turn (`beforeIds`) are excluded.
- **Done when:** `pnpm --filter @cw-code/desktop exec vitest run src/main/providers/opencode` passes.

## Task 5: Usage ledger (main) and IPC  [depends on Task 1]

- **Files:**
  - `apps/desktop/src/main/usage/UsageLedger.ts` (new) with its test
  - `apps/desktop/src/main/sessions/SessionManager.ts`
  - `apps/desktop/src/main/paths/appPaths.ts`
  - `apps/desktop/src/main/index.ts`
  - `apps/desktop/src/preload/index.ts`
  - `apps/desktop/src/renderer/src/cw.ts`
- **What:**
  - Storage: monthly files `~/.cw-code/userdata/usage/YYYY-MM.json` with the shape `{ version: 1, rows: UsageLedgerRow[], turnIds: string[] }`.
  - Aggregation: rows are keyed by `day|sessionId|model` and add together. `costUsd` stays `null` until a priced turn arrives; unpriced turns increment `unpricedTurns`.
  - Writing: atomic (tmp + rename), debounced 2 s, flushed on dispose.
  - Duplicates: a `turnId` already recorded is ignored.
  - Recording: `SessionManager.handleDriverEvent` records every non-title `turn.done` with `usage.length > 0`, using the session's `projectId` and `driver`.
  - IPC `usage.ledger` → `queryLedger(query)` reads only the month files the query needs (all of them when `sessionId` is set).
- **Interfaces:**
  - Produces `class UsageLedger { constructor(dir: string); record(input: { turnId: string; sessionId: string; projectId: string; driver: DriverKind; at: Date; usage: TurnModelUsage[] }): void; query(q: UsageLedgerQuery): UsageLedgerRow[]; flush(): void }`.
  - Adds `usageDir()` in appPaths.
  - Preload `window.cw.getUsageLedger(q: UsageLedgerQuery): Promise<UsageLedgerRow[]>`.
- **Tests:**
  - Two turns on the same day, session and model add together.
  - Duplicate `turnId` is ignored.
  - Null plus priced cost behaves as described.
  - Query by `sinceDay` across two months.
  - Query by `sessionId`.
  - The write and read round-trip goes through a temp dir.
- **Done when:** `pnpm --filter @cw-code/desktop exec vitest run src/main/usage` passes.

## Task 6: Account usage service and IPC  [depends on Task 1]

- **Files:**
  - `apps/desktop/src/main/usage/AccountUsageService.ts` (new) with its test
  - `apps/desktop/src/main/debug/tracingDriver.ts`
  - `apps/desktop/src/main/sessions/SessionManager.ts`, which exposes the drivers to the service
  - `apps/desktop/src/main/index.ts`
  - `apps/desktop/src/preload/index.ts`
  - `apps/desktop/src/renderer/src/cw.ts`
- **What:**
  - `get(drivers, force)` returns snapshots:
    - A driver fetched less than 60 s ago returns its cache unless `force` is set.
    - Calls already in flight are shared.
    - A driver without `getAccountUsage` is skipped.
    - A thrown error becomes `{status:"error"}`.
  - The last `ok` state is kept as `lastGood` when a later fetch fails.
  - There are no timers in main. The renderer drives polling.
  - `TracingCliDriver` forwards `getAccountUsage` and traces the call without its payload.
  - Changing the `opencodeGoUsage` setting invalidates the cached `opencode` snapshot.
- **Interfaces:**
  - Produces `class AccountUsageService { constructor(drivers: () => Record<DriverKind, CliDriver>, now?: () => number); get(drivers: DriverKind[], force: boolean): Promise<AccountUsageSnapshot[]>; invalidate(driver: DriverKind): void }`.
  - IPC `usage.account` with `{ drivers: DriverKind[]; force?: boolean }`.
  - Preload `window.cw.getAccountUsage(drivers, force?)`.
- **Tests:**
  - Freshness cache.
  - In-flight calls are shared.
  - An error keeps `lastGood`.
  - A missing method is skipped.
- **Done when:** `pnpm --filter @cw-code/desktop exec vitest run src/main/usage` passes.

## Task 7a: Claude `getAccountUsage`  [depends on Task 1]

- **Files:** `apps/desktop/src/main/providers/claude/claudeAccountUsage.ts` (new) with its test, `ClaudeCliDriver.ts`
- **What:**
  - Start a short-lived probe with the configured binary and extra args: `-p --input-format stream-json --output-format stream-json --verbose --no-session-persistence`.
  - Write the `initialize` control request, then `{"type":"control_request","request_id":…,"request":{"subtype":"get_usage","skip_behaviors":true}}`.
  - Wait up to 20 s for the matching `control_response`, then kill the probe with `killFn`.
  - A pure mapper turns the response into `AccountUsageState`:
    - Windows are built from `rate_limits.limits[]`. The id is `kind` plus the scope's model name. Labels: `session` → "Current session", `weekly_all` → "Weekly · all models", `weekly_scoped` → "Weekly · {scope.model.display_name}", and anything else → the `kind` in title case. `percent` stays as is, `resets_at` is an ISO string converted to epoch ms, and `is_active` is kept. Severity: server `normal` → normal; `warning`, `high` or `critical` → warning; percent ≥ 100 → blocked.
    - Balance `extra_usage`:
      - `enabled = is_enabled`.
      - If enabled: `usedMinor = used_credits` and `limitMinor = monthly_limit`, both kept in minor units, with `currency`.
      - If disabled: `detail` = "Disabled".
    - `plan` = `subscription_type` in title case.
    - `rate_limits_available === false` or `subscription_type === null` → unavailable `api-key`.
    - A control error or unknown subtype → unavailable `unsupported-version`.
    - A missing or malformed `limits` → `error` "Unexpected get_usage response", with a dev-log warning.
    - A spawn ENOENT → unavailable `not-installed`.
- **Interfaces:**
  - Produces `mapClaudeUsage(response: unknown): AccountUsageState`.
  - The driver implements `getAccountUsage()`.
- **Tests:** `claudeAccountUsage.test.ts`, with fixtures for:
  - the live Team response (3 limits, extra usage disabled);
  - an API-key response;
  - a missing `limits`;
  - an unknown `kind`.
- **Done when:** `pnpm --filter @cw-code/desktop exec vitest run src/main/providers/claude` passes.

## Task 7b: Codex `getAccountUsage`  [depends on Task 1]

- **Files:** `apps/desktop/src/main/providers/codex/codexAccountUsage.ts` (new) with its test, `CodexCliDriver.ts`
- **What:**
  - On the existing app-server client, call `account/read`, then `account/rateLimits/read`.
  - A pure mapper:
    - `account.type === "apiKey"` → unavailable `api-key`.
    - A `null` account → unavailable `logged-out`.
    - Windows come from every snapshot in `rateLimitsByLimitId`, falling back to `rateLimits`. For each snapshot's `primary` and `secondary`, the label is picked by `windowDurationMins`, **never by position**: 300 → "5-hour window", 10080 → "Weekly window", anything else → "{n}h window". When the snapshot's `limitName` isn't null and isn't `codex`, prefix the label with `limitName · `. `percent = usedPercent`, and `resetsAt = resetsAt × 1000`.
    - Severity:
      - `rateLimitReachedType` set for that snapshot, or ≥ 100 → blocked.
      - ≥ 80 → warning.
    - A window whose `resetsAt` is already past → percent 0.
    - Balances: "Credits" (`credits.balance` or "None"), and "Limit reset credits" (`rateLimitResetCredits.availableCount` + " available") when present.
    - `plan` from `planType`: `plus` → "ChatGPT Plus", `pro` → "ChatGPT Pro", `team` → "ChatGPT Team", `business` → "ChatGPT Business", `enterprise` → "ChatGPT Enterprise", `edu` → "ChatGPT Edu", `go` → "ChatGPT Go", `free` → "ChatGPT Free", anything else → the raw value.
- **Interfaces:** produces `mapCodexUsage(account: unknown, rateLimits: unknown, now: number): AccountUsageState`.
- **Tests:**
  - The live Plus shape.
  - Swapped primary/secondary is still labelled correctly.
  - An API-key account.
  - Limit reached → blocked.
  - A past `resetsAt` → 0.
- **Done when:** `pnpm --filter @cw-code/desktop exec vitest run src/main/providers/codex` passes.

## Task 7c: OpenCode Go `getAccountUsage`  [depends on Task 1]

- **Files:**
  - `apps/desktop/src/main/providers/opencode/opencodeAccountUsage.ts` (new) with its test
  - `OpencodeDriver.ts`
  - `apps/desktop/src/main/settings/SettingsStore.ts`, where the default is `opencodeGoUsage: false`
- **What:**
  - `opencodeGoUsage` false → unavailable `consent-required` "Allow cw-code to read your OpenCode Go key to show plan limits".
  - Otherwise, read `${XDG_DATA_HOME || ~/.local/share}/opencode/auth.json`:
    - No `opencode-go` entry → unavailable `no-subscription`.
    - Otherwise, fetch `GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <key>`, `Accept: application/json` and `User-Agent: cw-code/<app version>`, with a 15 s timeout.
  - Response handling:
    - 401 → `key-rejected` "Run `opencode auth login` and pick OpenCode Go".
    - 403 → `no-subscription`.
    - Any other non-200 → error.
  - Mapper:
    - Windows `rolling` → "5-hour", `weekly` → "Weekly", `monthly` → "Monthly".
    - `percent`, `resetsAt` (ISO → ms). Severity: `status === "rate-limited"` or ≥ 100 → blocked; ≥ 80 → warning.
    - Plan "OpenCode Go".
    - Note: "Percent only. Dollar caps depend on the model."
  - The key goes only into the fetch header.
- **Interfaces:**
  - Produces `mapOpencodeGoUsage(body: unknown): AccountUsageState`.
  - Produces `readOpencodeGoKey(env, home): string | null`.
- **Tests:**
  - The mapper on a sample body.
  - The rate-limited status.
  - The auth.json reader: missing file, missing entry, present entry. Use a temp dir; never a real key.
- **Done when:** `pnpm --filter @cw-code/desktop exec vitest run src/main/providers/opencode` passes.

## Task 8: Usage view  [depends on Tasks 5, 6]

- **Files:**
  - `apps/desktop/src/renderer/src/stores/prStore.ts`, adding the `MainView` variant `{ kind: "usage" }` and `openUsage()`
  - `stores/usageStore.ts` (new)
  - `components/UsageView.tsx` (new)
  - `components/usageModel.ts` (new) with its test
  - `App.tsx`
  - `components/Sidebar.tsx`, for the chart icon after Settings
  - `components/SettingsModal.tsx`, for the OpenCode Go usage toggle in Harnesses → OpenCode
  - `theme.css`
- **What:** build mockup variant A without the "how" annotations.
  - **Plan cards:** one card per harness, rendered generically from `AccountUsageSnapshot`:
    - Windows are meters, with a warning tag at "warning" and a "Limit reached" tag at "blocked".
    - Balances are rows.
    - Notes are shown.
    - Unavailable and error states use the messages from variant B. `consent-required` shows an "Allow" button that patches the setting and forces a refresh. An error with `lastGood` shows the stale meters dimmed, plus "Couldn't refresh · showing data from N m ago" and a Retry button.
  - **Token section:**
    - Controls: 7/30/90 days, All tokens / Excluding cache reads, harness chips, and a project select.
    - Five KPI tiles.
    - The combined stacked daily SVG chart, with a legend and hover tooltip.
    - The ranked "Tokens by model" bars: top 6 plus "Other", with the driver icon.
    - The "Top sessions" table: title from the session list, "Deleted session" when missing.
  - **Refreshing:** `usageStore` fetches account snapshots when the view opens and re-polls every 5 min while it's open. It re-fetches the ledger when the view opens and on `turn.done` while it's open, debounced 2 s.
- **Interfaces:**
  - Produces `usageModel.ts`, pure over `UsageLedgerRow[]`:
    - `dailyByDriver(rows, days, metric)`
    - `byModel(rows, metric, top = 6)`
    - `topSessions(rows, limit = 5)`
    - `totals(rows)`
  - It also produces `usageStore.refreshAccount(drivers, force)`, `usageStore.loadLedger(query)` and `usageStore.sessionTotals(sessionId)`, which Task 9 consumes.
- **Tests:** `usageModel.test.ts` covers day bucketing with gaps filled with zero, the metric toggle, "Other" folding, and null cost with `unpricedTurns`.
- **Done when:** `pnpm typecheck` and `pnpm --filter @cw-code/desktop exec vitest run src/renderer/src/components/usageModel.test.ts` pass.

## Task 9: Context ring and dock  [depends on Tasks 2, 3, 4, 8]

- **Files:**
  - `apps/desktop/src/renderer/src/stores/appStore.ts`: replace `usageBySession` with `turnUsageBySession: Record<string, { context?: ContextUsage; lastTurn: TokenCounts & { costUsd: number | null; durationMs?: number } }>`, set from `turn.done`.
  - `components/ContextRing.tsx` (new)
  - `components/ComposerView.tsx`: optional `usageSlot?: ReactNode`, rendered just before the stop/send button.
  - `components/Composer.tsx`
  - `components/ThreadView.tsx`: remove the `.usage` footer.
  - `theme.css`
- **What:** build mockup variant C.
  - **The ring** is a 20 px SVG filled by `context.usedTokens / windowTokens`. It's neutral, turns amber at ≥ 80% and red at ≥ 95%. Before the first turn in this app run it's empty, with the tooltip "No context data yet".
  - **Clicking it** opens the dock. It closes on outside click or Escape. The dock has:
    - a context section;
    - "This session" (ledger totals via `usageStore.sessionTotals`, plus the last turn);
    - the subscription section for the session's driver, reusing the plan card's meter component in compact form;
    - "Open usage →", which calls `openUsage()`.
  - **Refreshing:** opening the dock refreshes that driver's account snapshot (the 60 s cache applies).
- **Tests:** none (UI wiring; verified by typecheck and build).
- **Done when:** `pnpm typecheck`, `pnpm test` and `pnpm build` all pass.

## Final verification

- Run `pnpm typecheck`, `pnpm test` and `pnpm build` from the repo root.
- Ask the user to run the app and check three things:
  - One turn per harness adds a ledger row in `~/.cw-code/userdata/usage/`.
  - The dock shows context and plan data.
  - The Usage view renders all three cards, including the OpenCode consent flow.
