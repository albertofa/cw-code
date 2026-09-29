# Plan: UI structure (redesign phase 2)

**Goal:** rebuild the shell's structure on the phase 1 foundation. That covers the sidebar (Needs you / Working set / Idle / Resolved), the right-edge tool rail with split view and a Session overview tool, settings as a full page, the new model and effort pickers, the PR inbox rows, a Git diff "Last turn" scope with Undo, and a taskbar badge. It also removes CLI-session import.

**Constraints:**
- Visual reference: `design-plans/mockups/cw-code-redesign.html`.
  - Screen map: 1 Workbench, 2 Tool rail · Overview, 3 Approval + split, 4 New session, 5 PR inbox, 7 Settings · PR workflows, 8 Settings · Appearance, 9 Settings · Claude Code, 11 States, 12 Model picker, 13 System.
  - Search the file for the function named in each task.
  - The plan wins where it and the mockup disagree.
- Phase 1 tokens and controls are the only vocabulary. Colours come from `:root` in `theme.css`. Use `--violet-soft` + 2px `--violet` mark for selection, neutral `--hover`, `--accent` for information, `--update` for PR updates, `--warning` for approvals, and the `--t-*` / `--fs-*` type tokens. Checkbox, radio and switch use the phase 1 styles.
- Keep composer geometry, harness icons (`DriverIcon.tsx`) and provider colours unchanged.
- AGENTS.md rules:
  - Keep IPC handler, preload, `cw.ts` and store in sync. `AppSettings` and other shared types are declared in contracts and duplicated in `apps/desktop/src/renderer/src/cw.ts`; change both.
  - Surface failures visibly.
  - Never auto-mutate user-visible state.
  - Tests only for stable contracts (pure helpers, parsers, git and sandbox operations).
- New settings need no schema migration (`SettingsStore.ts` backfills defaults). Add a `sanitize` line and a test.
- New surfaces put their CSS in a component CSS file imported by the component (as `appearance.css` does). Only one task at a time edits `theme.css`. The order below guarantees that.
- Every renderer-supplied path that reaches the filesystem goes through `assertInside` (`apps/desktop/src/main/fs/FileService.ts`).
- Motion follows phase 1 (`docs/plans/2026-09-29-ui-foundation.md`, Task 7). Popups use `cw-pop-in`. Collapses rotate the chevron. List reorder glides for 150ms with `var(--ease-out)`. Hover backgrounds are instant.
- No new npm dependencies.
- Done means `pnpm typecheck`, `pnpm test` and `pnpm build` pass from the repo root. Do not run `pnpm dev`.
- User decisions recorded for this phase:
  - Drop CLI-session import entirely.
  - The model-picker star sets the harness default.
  - Build Last-turn diff, Undo, prompt preview and Claude 1M context.
  - Project filter and "Add project" leave the sidebar: adding lives in the New session project picker, management in Settings → Source control.
  - GitHub avatars load from their URLs, with an initials fallback.
  - Keep the context-ring popover.
  - Clicking a tool docked elsewhere reveals it where it is docked.

## Task 1: Remove CLI-session import  [independent]

- **Files:**
  - Main: `apps/desktop/src/main/sessions/SessionManager.ts`, `apps/desktop/src/main/sessions/SessionManager.test.ts`, `apps/desktop/src/main/index.ts`
  - Bridge and types: `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/cw.ts`, `packages/contracts/src/session.ts`
  - Renderer: `apps/desktop/src/renderer/src/stores/appStore.ts`, `apps/desktop/src/renderer/src/components/projectRecency.ts`, `projectRecency.test.ts`, `Sidebar.tsx`, `AppFlow.test.tsx`, `theme.css`
  - Docs: `AGENTS.md`, `apps/desktop/PRODUCT.md`
- **What:** delete the discovered-session feature from every layer:
  - main: `SessionManager.listDiscovered` and `importSession`, and the IPC `sessions.discovered` and `sessions.import`;
  - bridge and types: the preload methods and `cw.ts` types;
  - store: the `discoveredByProject`, `loadDiscovered` and `importDiscovered` fields and every call site;
  - helpers: `discoveryProjectId` and `discoveredOwnerId`, with their tests;
  - UI: the Sidebar "from cli" section and the `.discovered*` CSS;
  - tests: the SessionManager discovery test and the AppFlow mock;
  - contracts: the unused `"session-discovered"` status reason.

  Keep `CliDriver.listSessions`, the drivers' `listSessions` and `claudeSessions.ts`, because history self-heal uses them (`SessionManager` `verifyEmptyHistory` and `adoptUnclaimedSession`). Delete `SessionStore.findByCursor` only if nothing else uses it.

  Rewrite `AGENTS.md:18-19` to: "The app manages only sessions it created; CLI-native sessions are never imported." Remove the equivalent sentence in `PRODUCT.md:27`.
- **Tests:** delete the discovery tests. No new tests.
- **Done when:** `rg -n "listDiscovered|importSession|discoveredByProject|loadDiscovered|importDiscovered|discoveryProjectId|discoveredOwnerId|session-discovered|\.discovered" apps packages AGENTS.md` returns nothing. `pnpm typecheck && pnpm test` pass.

## Task 2: Sidebar rebuild  [depends on Task 1]

- **Files:**
  - `apps/desktop/src/renderer/src/components/Sidebar.tsx`
  - new `apps/desktop/src/renderer/src/components/needsYou.ts` + `needsYou.test.ts`
  - `sidebarQuickFilters.ts` (+ its test if it exists), `workingSet.ts`
  - `apps/desktop/src/renderer/src/theme.css`
- **What:** the sidebar from mockup screens 1 and 11 (search `function sidebar`, `wsRow`, `flatRow`, and the `/* needs-you rows */` CSS). From top to bottom:
  1. **Header and entry points:** the head with logo and wordmark; the "New session" button (Ctrl T); a search field "Search all sessions" (Ctrl K); the "Pull requests" nav row (existing badge and unseen dot). The project filter picker and its "Add project…" / manage UI are removed.
  2. **Needs you:** section label "Needs you" with an amber count badge. It lists sessions with an attention, sorted by `compareNeedsYou`.
     - Each row: tinted background and a 2px left edge in the attention colour (approval `--warning`, question `--md-link` / `--accent`, update `--update`). Title (weight 600). A second line in the attention colour with the pending request. On the right, the action word with its icon (Approve / Answer / Review, no chip background), then the project avatar and the harness icon.
     - A selected needs-you row keeps its tint and adds an inset 1px `--violet-line` outline.
  3. **Working set:** label "Working set N" with the quick filters (running, PR, updated) as small chips. It lists `isWorkingSetStatus` sessions without an attention, in `compareWorkingSet` order. Rows keep today's two-line layout (title; project avatar · project · branch) with the status word, flat PR badge and harness icon.
  4. **Idle:** label "Idle N" and "Show all". It lists `idle` sessions without an attention, most recent first, as one-line rows: title, faint project name, PR badge, age, harness icon. It shows 4 until "Show all" is used.
  5. **Resolved:** "Resolved N", collapsed by default, with the same one-line rows and a check plus age.
  6. **Update and footer:** the `UpdateIndicator` card, then the footer (Settings, Usage, Skills pushed right). Unchanged.
- **Behaviour:**
  - Search matches title, project name and branch, case-insensitive. It covers every section except archived. While a query is set, Resolved is expanded and the Idle limit is ignored.
  - Drag to Resolved and back to Idle keeps today's behaviour.
  - The context menu is unchanged.
  - The existing FLIP reorder animation (`Sidebar.tsx` ~:308-334) changes to 150ms `var(--ease-out)`.
  - Rows moving between sections glide; if that isn't feasible with remounts, they just appear.
- **Interfaces:**
  ```ts
  // needsYou.ts
  export type AttentionKind = "approval" | "question" | "update";
  export interface Attention { kind: AttentionKind; line: string }
  export function sessionAttention(input: {
    session: Session;
    approvals: ApprovalRequest[] | undefined;   // appStore.pendingApprovals[id]
    questions: QuestionRequest[] | undefined;   // appStore.pendingQuestions[id]
    unseenPr: { number: number; summary?: PrSummary; updates?: PrUpdate[] } | null; // first unseen linked PR
  }): Attention | null;
  //  - resolved/archived → null
  //  - approvals non-empty → { kind: "approval", line: approvals[0].title (or its command/details, first line) }
  //  - questions non-empty → { kind: "question", line: first question text }
  //  - status "input-required" with both empty → { kind: "question", line: "Waiting for your input" }
  //  - unseenPr → { kind: "update", line: "#<n> · " + summary text built from updates/summary (e.g. "2 checks failing · 1 new review"), or "#<n> updated" }
  export const ATTENTION_RANK: Record<AttentionKind, number>; // approval 0, question 1, update 2
  export function compareNeedsYou(a: { attention: Attention; updatedAt: number }, b: …): number; // rank, then updatedAt desc
  export function needsYouCount(sessions: Session[], attentionOf: (s: Session) => Attention | null): number;
  ```
  A session leaves Needs you only when its attention clears:
  - approval and question clear when answered;
  - an update clears when the existing mark-seen path runs (the PR update dock's send or dismiss, or a turn finishing).

  Opening a session does not clear it.
- **Tests:** `needsYou.test.ts`: kind priority, the line text for each kind, resolved/archived excluded, input-required fallback, compare order, count.
- **Done when:** `pnpm test` passes the new tests, and `pnpm typecheck && pnpm --filter @cw-code/desktop build` pass.

## Task 3: Taskbar badge  [depends on Task 2]

- **Files:**
  - Main: new `apps/desktop/src/main/attention.ts` + `attention.test.ts`, `apps/desktop/src/main/index.ts`
  - Bridge and types: `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/cw.ts`
  - Renderer: new `apps/desktop/src/renderer/src/components/useAttentionBadge.ts`, `apps/desktop/src/renderer/src/App.tsx`
- **What:**
  - The renderer computes the Needs-you count with `needsYouCount` (Task 2). On change it draws a 32×32 badge on a canvas: an amber `#e8b44f` circle with the count in dark text; "9+" above 9. It sends `{ count, badgeDataUrl }` to main.
  - Main shows it on the window:
    - `win.setOverlayIcon(nativeImage.createFromDataURL(url), "<n> sessions need you")`, or `null` when the count is 0;
    - `app.setBadgeCount(count)` where supported;
    - `win.flashFrame(true)` once when the count increases while the window is not focused, and `flashFrame(false)` on focus.
- **Interfaces:**
  ```ts
  // preload / cw.ts
  setAttention(state: { count: number; badgeDataUrl: string | null }): void; // ipcRenderer.send("app.attention", state)
  // attention.ts
  export function shouldFlash(prevCount: number, nextCount: number, focused: boolean): boolean; // next > prev && !focused
  export function attentionDescription(count: number): string; // "1 session needs you" / "N sessions need you" / ""
  ```
- **Tests:** `attention.test.ts` for `shouldFlash` and `attentionDescription`.
- **Done when:** the tests pass, and `pnpm typecheck && pnpm build` pass.

## Task 4: Tool rail, pane headers, split view and panel motion  [depends on Task 2]

- **Files:**
  - Panel model: `packages/contracts/src/panels.ts`, `apps/desktop/src/renderer/src/stores/panelLayout.ts` + `panelLayout.test.ts`, `stores/panelStore.ts`
  - Shell and components: `App.tsx`, new `components/ToolRail.tsx`, new `components/PaneHeader.tsx`, `components/PanelToggles.tsx`, `components/TabMenu.tsx`, `components/toolTabs.ts`
  - Settings field: `packages/contracts/src/settings.ts`, `apps/desktop/src/main/settings/SettingsStore.ts` + test, `cw.ts`, `appStore.ts`, `components/AppearanceSettings.tsx`, `appearanceFonts.ts`
  - `theme.css`
- **What:** mockup screens 1–3 (search `function rail`, `rightTabs`, and the `/* tool rail */` CSS).
  - **ToolRail:** a 44px column rendered as the last child of `.app-body`. It is always visible, including when the right panel is hidden. Its top 40px stay empty, since the window controls overlay them.
    - Buttons are 32px with radius 8, grouped with 18px separators:
      - `[diff, pr (only when linked), files, agents]`
      - `[shell, <session driver CLI>]`
      - `[preview (only when present)]`
      - Task 5 inserts `overview` first.
    - Bottom of the rail: a split toggle and the right-panel toggle. The bottom-panel toggle moves here from `PanelToggles`.
    - The active tool (shown in the right panel or its split) gets the selection style, with the 2px mark on the panel side.
    - A tool docked in main or bottom shows a 5px `--muted` dot. Clicking it calls `revealTab` (existing).
    - Badges: diff = `gitStatus.dirtyCount` when > 0; agents = subagent total (green `--success` while any is running, as today); pr = a 6px dot coloured by checks (success, danger or warning).
    - Rail buttons are draggable to main or bottom (`startTabDrag`), and right-click opens `TabMenu`.
    - This replaces `.tool-rail` and `.right-tabbar` in App.tsx.
  - **PaneHeader:** 40px, `padding-right: 100px` so it clears the window controls. It shows the tool icon (`--violet-ink`), title and optional summary, and a dock button that opens `TabMenu` with "Open in main/bottom". The split pane's header also has a close (×) that clears the split. The Git diff summary is "<n> files · +<a> −<d>" from `gitStatus`.
  - **Split view:** the right panel can show a second tool below the active one, with a draggable divider. Rail click opens a tool as the main right tool. The split toggle turns the split on with the first other right-docked tool, or opens `shell` into the right panel when there is none. It turns the split off when it is on. Right-click has "Open in split".
  - **Panel motion setting:** `panelAnimationMs`, 0–400 in steps of 25, default 0. An Appearance row "Panel animation" with a stepper shows "Off" at 0.
    - When > 0, the root var `--panel-anim-ms` drives `transition: width` on `.right` and `transition: height` on the bottom panel, with `var(--ease-out)`.
    - Never while drag-resizing: add a `.resizing` class during the drag.
    - Reduced motion forces it off.
- **Interfaces:**
  ```ts
  // SessionPanelState additions (panelLayout.ts), sanitized with defaults
  rightSplit: DockableTabId | null;   // default null; must be docked "right" and ≠ active right tab, else sanitized to null
  rightSplitRatio: number;            // default 0.5, clamp 0.25–0.75
  // panelStore
  setRightSplit(sessionId: string | undefined, tab: DockableTabId | null): void;
  setRightSplitRatio(sessionId: string | undefined, ratio: number): void;
  toggleRightSplit(sessionId: string | undefined): void;
  // AppSettings
  panelAnimationMs: number;           // default 0, clamp 0–400, Math.round to multiples of 25
  ```
- **Tests:** `panelLayout.test.ts` covers split sanitizing (unknown tab, not docked right, equals active, ratio clamp, defaults). `SettingsStore.test.ts` covers the `panelAnimationMs` clamp and step.
- **Done when:** `pnpm typecheck && pnpm test && pnpm build` pass, and `rg -n "right-tabbar|tool-rail-openers" apps/desktop/src/renderer/src` returns only removed-CSS leftovers (none in tsx).

## Task 5: Session overview tool  [depends on Task 4]

- **Files:**
  - Panel model: `packages/contracts/src/panels.ts`, `stores/panelLayout.ts` + test, `components/toolTabs.ts`, `components/ToolContent.tsx`, `components/ToolRail.tsx`
  - New: `components/SessionOverview.tsx`, `components/sessionOverview.css`
- **What:** a new dockable tool `"overview"` (title "Session overview", lucide `Activity` icon). It is closed by default and auto-located right, and appears first in the rail. The panel matches mockup screen 2 (search `function overviewPane`): collapsible sections on `--bg-deep` wells with radius 12. Each section header has an icon, a bold title, a right-aligned summary and a chevron.
  - **Context:** a meter and "<used> / <window>" from `turnUsageBySession`.
  - **Workspace:** branch (mono), worktree or checkout, changes "<n> files · +a −d", and the linked PR with checks, from `gitStatusBySession` and `useLinkedPrs`.
  - **This session:** turns, input, cache read, output, last turn, and API-equivalent cost, from `useUsageStore.sessionRowsById` via `ensureSessionRows`, refreshed on `turn.done`.
  - **Plan:** the session driver's `accountByDriver` windows, using `UsageMeter`, plus "Updated …" and a link to Usage.
  - **Todos:** "done/total" and the active item, from `todosBySession`.
  - **Subagents:** name and status per row, from `collectSubagents`.
  - **Skills:** count enabled for the driver, from `useSkillsStore`, calling `load()` when `status === "idle"`.

  Empty or unavailable data shows a one-line faint message, never a blank section.
- **Interfaces:** `DockableTabId` gains `"overview"`. `DOCKABLE_TABS`, `DEFAULT_DOCK` (closed) and `DEFAULT_AUTO` (right) include it.
- **Tests:** extend the `panelLayout.test.ts` defaults test to cover the new id.
- **Done when:** `pnpm typecheck && pnpm test && pnpm build` pass.

## Task 6: Model picker and effort menu  [depends on Task 4]

- **Files:**
  - Contracts, settings and parser: `packages/contracts/src/session.ts` (ModelOption), `packages/contracts/src/settings.ts`, `apps/desktop/src/main/settings/SettingsStore.ts` + test, `apps/desktop/src/main/providers/opencode/opencodeModels.ts` + `opencodeModels.test.ts`
  - Renderer types and store: `cw.ts`, `appStore.ts`
  - Composer: `components/ComposerView.tsx`, `components/lastModel.ts` + `lastModel.test.ts`
  - New: `components/ModelPicker.tsx`, `components/EffortMenu.tsx`, `components/modelMenus.ts` + `modelMenus.test.ts`, `components/modelPicker.css`
- **What:** mockup screen 12 (search `function modelPicker`, `effortMenu`, and the `/* model picker */` CSS).
  - **ModelPicker** replaces the model `MenuSelect` in the composer. It is a popover (width 400, `cw-pop-in`) containing:
    - A search field "Search models" (autofocus).
    - "Custom model…" with a mono hint: "provider/model or alias" for OpenCode, "model ID or alias" otherwise. It opens today's inline custom input.
    - Groups: "Recent" (up to 3), then a provider group per provider for OpenCode, or one harness group for Claude and Codex.
    - Rows are 32px: name, faint context size (`formatTokensShort(contextWindow)`), a check on the current model, and a star.
      - The star is filled `--warning` when the model is the harness default. Clicking it sets or clears the default.
    - A search with no match offers `Use “<text>” as a custom model`.
    - Keyboard: ↑↓ move, Enter picks, Esc closes. The footer shows the key hints.
    - A detail card appears beside the highlighted row only when `meta` or `contextWindow` exists. It shows model ID, context, capabilities, input, output, cost ($/1M), variants and source.
  - **EffortMenu** replaces the effort `MenuSelect` (popover, width 250). Its pill label is "<Effort>" plus " · <200K|1M>" for Claude.
    - **"Reasoning" section:** the existing `effortOptionsFor` options, labelled Minimal, Low, Medium, High, "Extra high" and Max. The session's default effort ("medium") carries a small blue "Default" tag. For OpenCode the header is "Variants · <model>".
    - **"Context window" section:** Claude only, with 200K and 1M. 200K is the plain id and 1M is the id with the `[1m]` suffix. Picking one rewrites the session model with `withContextSuffix`. 200K carries the "Default" tag.
    - The current choice is filled and checked.
  - **Default model per harness:** `claudeDefaultModel` exists but is never read. Add `codexDefaultModel` and `opencodeDefaultModel`, both default `""`. When a session has no model, the composer picks the harness default if it is in the list, else the most recent, else the first.
  - **OpenCode metadata:** `opencodeModels.ts` also parses `cost.input` and `cost.output` (per 1M), capabilities (`reasoning` → "Reasoning", `tool_call` → "Tool calling", `attachment` → "Attachments"), and `modalities.input` / `modalities.output`. Missing fields stay undefined. `isModelOption` accepts `meta`.
- **Interfaces:**
  ```ts
  // ModelOption (contracts + cw.ts)
  meta?: { costInputPerM?: number; costOutputPerM?: number; capabilities?: string[]; input?: string[]; output?: string[] };
  // AppSettings
  codexDefaultModel: string; opencodeDefaultModel: string;   // default "", trimmed
  // lastModel.ts (keep getLastModel/setLastModel working as recents[0])
  export function getRecentModels(driver: DriverName): string[];      // localStorage "cw:recentModels:<driver>", max 3, most recent first
  export function pushRecentModel(driver: DriverName, id: string): void;
  // modelMenus.ts
  export function hasContextSuffix(id: string): boolean;               // /\[1m\]$/i
  export function withContextSuffix(id: string, oneM: boolean): string;
  export function pickInitialModel(models: ModelOption[], defaultId: string, recents: string[]): string | null;
  export function effortLabel(e: EffortLevel): string;                 // xhigh → "Extra high"
  ```
- **Tests:**
  - `modelMenus.test.ts`: suffix helpers, `pickInitialModel` order, labels.
  - `lastModel.test.ts`: recents cap, dedupe, order.
  - `opencodeModels.test.ts`: meta parsing from a verbose sample, missing fields, cache validation with meta.
  - `SettingsStore.test.ts`: the new defaults.
- **Done when:** `pnpm typecheck && pnpm test && pnpm build` pass.

## Task 7: PR inbox rows and PR author  [depends on Task 1]

- **Files:**
  - GitHub query, parser and contracts: `apps/desktop/src/main/github/prQueries.ts`, `apps/desktop/src/main/github/prParsers.ts` + `prParsers.test.ts`, `packages/contracts/src/pullRequests.ts` (and the duplicate in `cw.ts` if one exists)
  - Renderer: `components/PrInboxView.tsx`, `components/PrDetailView.tsx`, new `components/PrAvatar.tsx`, new `components/prInbox.css` (no `theme.css` edits)
- **What:** mockup screen 5 (search `function prRow`, `person`, `sessChip`, and the `/* PR rows */` CSS).
  - **Author data:** fetch `author { login __typename avatarUrl(size: 48) ... on User { name } }`. The author becomes `{ login, isBot, name?, avatarUrl? }`.
  - **Row grid:** `16px minmax(0,1fr) 164px 96px 156px 176px`, gap 10, padding `9px 12px`.
    - **State icon:** the unseen dot moves onto the icon as a 7px corner dot.
    - **Title column:** the title line (unchanged); the meta line "owner/repo#n · age · +a −d" plus a "not cloned" tag; and, when sessions are linked, a third line with up to 2 session chips (harness icon, full title, state word: Running `--success`, "Needs review" `--update`, or age) plus "+N".
    - **Author:** `PrAvatar` (24px circle `<img referrerPolicy="no-referrer">`, initials fallback on error or missing URL), the name (or login) at weight 500, and `@login` in mono `--t-2xs`.
    - **Checks** and **Review** columns stay.
    - **Action:** a fixed 176px split button. The main part is left-aligned with the workflow icon (`WORKFLOW_ICONS` by `workflow.icon`; Open session `MessageSquare`, Re-review `RefreshCw`, GitHub `ExternalLink`) and the label, with ellipsis. The 28px caret is unchanged.
    - The comments and sessions columns are removed.
  - **Container queries:** at ≤760px hide Review; at ≤560px also hide Checks and Author.
  - **PR detail:** `PrAvatar` shows in the header sub-line and on comment cards.
- **Tests:** `prParsers.test.ts` covers name and avatarUrl mapping, bots without a name, and a missing avatarUrl.
- **Done when:** `pnpm typecheck && pnpm test && pnpm build` pass.

## Task 8: Turn snapshots, Last-turn diff and Undo (backend)  [depends on Task 1]

- **Files:**
  - Contracts and types: `packages/contracts/src/session.ts`, `apps/desktop/src/renderer/src/cw.ts`
  - Git: `apps/desktop/src/main/fs/GitService.ts` + `GitService.test.ts`
  - Sessions: `apps/desktop/src/main/sessions/SessionManager.ts` + `SessionManager.test.ts`, `apps/desktop/src/main/sessions/SessionStore.ts`
  - IPC: `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`
- **What:**
  - **Snapshot at turn start:** in `startTurn`, after `ensureWorktree` and before `driver.startTurn`, capture a full working-tree snapshot of the session's cwd (worktree or current checkout, whenever it is a git repo).
    1. Copy the real index (`git rev-parse --git-path index`) to a temp file.
    2. With `GIT_INDEX_FILE` pointing at it, run `git add -A -- . ":(exclude).cw"`.
    3. Run `git write-tree`.
    4. Run `git commit-tree <tree> -p HEAD -m "cw-code turn snapshot"`, without `-p` when HEAD is unborn.
    5. Always delete the temp file.

    The commit is unreferenced, and the user's index, stash, refs and working tree are never touched. The timeout is 15s.
  - **Persist it:** store `lastTurnSnapshot = { turnId, sha, capturedAt }` on the session once the driver returns the turn id. On failure store `{ turnId, capturedAt, error }` and continue the turn.
  - **Remove the old turn base:** `turnBaseShas`, `captureTurnBaseSha`, `turnBaseSha`, `GitService.turnDiff`, IPC `git.turnDiff`, and preload / `cw.ts` `turnDiff`.
  - **Last-turn diff:** `GitDiffMode` gains `"turn"`. `git.diff` in turn mode takes a fresh snapshot of the current tree and returns `git diff --no-ext-diff --binary --find-renames <snapshot> <now>`, with the same truncation as other modes. If there is no snapshot it rejects with "No snapshot for the last turn".
  - **Changes and Undo:**
    - `turnChanges` returns per-file change and stats from `git diff --numstat` and `--name-status --no-renames` between the snapshot and now.
    - `undoTurn(sessionId, turnId)` is refused when a turn is active, when `turnId !== lastTurnSnapshot.turnId`, or when the snapshot is missing.
      - Modified and deleted files: `git restore --source=<snapshot> --worktree -- <path>`. This never touches the index.
      - Added files: delete them.
      - Every path goes through `assertInside(root, path)`.
      - Afterwards call `invalidateStatus` and `invalidateBranches`, then return the restored list.
- **Interfaces:**
  ```ts
  // contracts session.ts (+ cw.ts)
  export type GitDiffMode = "working" | "staged" | "branch" | "turn";
  export interface TurnSnapshot { turnId: string; sha?: string; capturedAt: number; error?: string }
  // SessionMeta.lastTurnSnapshot?: TurnSnapshot
  export interface TurnFileChange { path: string; change: "modified" | "added" | "deleted"; added: number; deleted: number; binary: boolean }
  export interface TurnChanges { turnId: string; files: TurnFileChange[] }
  // GitService
  snapshotWorkingTree(root: string): Promise<string>;
  diffSnapshot(root: string, snapshotSha: string): Promise<string>;
  snapshotChanges(root: string, snapshotSha: string): Promise<TurnFileChange[]>;
  restoreSnapshot(root: string, snapshotSha: string, changes: TurnFileChange[]): Promise<TurnFileChange[]>;
  // preload / cw.ts
  getTurnChanges(sessionId: string): Promise<TurnChanges | null>;   // IPC "git.turnChanges"; null when no snapshot
  undoTurn(sessionId: string, turnId: string): Promise<TurnChanges>; // IPC "git.undoTurn"
  // getGitDiff(sessionId, "turn") works through the existing "git.diff"
  ```
- **Tests** (`GitService.test.ts`, real temp repos like the existing tests):
  - A snapshot includes a dirty tracked file and an untracked file, and leaves the real index and `git stash list` unchanged.
  - `diffSnapshot` shows only changes made after the snapshot, not pre-existing dirty work.
  - `snapshotChanges` classifies modified, added and deleted with numstat.
  - `restoreSnapshot` restores modified, deletes added and restores deleted. It keeps pre-snapshot dirty content and leaves the index untouched.
  - A path outside the root is rejected.
  - An unborn HEAD works.

  `SessionManager.test.ts`: the snapshot is stored per turn, a failure is stored as `error`, and undo is refused while a turn is active or for a stale turn id.
- **Done when:** the tests pass, `rg -n "turnBaseSha|turnDiff|captureTurnBaseSha" apps packages` returns nothing, and `pnpm typecheck && pnpm test` pass.

## Task 9: Git diff scopes, stacked files and the changes card  [depends on Tasks 5, 8]

- **Files:**
  - Diff panel and file panel: `components/GitInspectPanel.tsx`, `components/FilePanel.tsx` (remove the dead `DiffPanel`)
  - Thread: `components/ThreadView.tsx`, `components/TurnBlock.tsx`, new `components/TurnChangesCard.tsx`
  - `stores/panelStore.ts`, `theme.css`
- **What:** mockup screen 1 (search `dfile`, `changes`, and the `.changes` / `.dfh` / `.dl` CSS).
  - **Diff scopes:** the segmented control shows "Changes · Staged · Branch · Last turn". "Last turn" is disabled, with the tooltip "No snapshot for the last turn", when `lastTurnSnapshot?.sha` is missing. A snapshot `error` shows as a one-line warning in the panel.
  - **Stacked layout:** the diff renders as stacked collapsible file sections instead of the list-plus-diff grid.
    - Each section has a sticky 32px header: chevron, file icon, dir in faint text plus the name, `+a −d` in mono, and an open-in-Files button that calls `revealFile`.
    - The unified diff follows, using the Task 2 phase 1 line styles.
    - Sections start expanded when there are ≤ 8 files and collapsed otherwise.
  - **Changes card:** for the session's latest completed turn, when `lastTurnSnapshot.turnId` matches that turn and it is not running, `ThreadView` calls `getTurnChanges` after `turn.done` and renders `TurnChangesCard` at the end of that turn.
    - The card is a `--card` background with radius 10. Its header reads "N files changed", then `+A −D`, then the buttons Undo and "Review ›".
    - One mono row per file, clickable to open it in Files.
    - Review opens the Git diff tool in "turn" mode.
    - Undo opens `useConfirm({ danger: true, title: "Undo this turn's changes?", confirmLabel: "Undo changes" })`. The message lists every file with its change kind and says that pre-turn work is kept.
    - On confirm it calls `undoTurn`. The card then shows "Changes undone" and a success or error notification is shown.
    - No card when there are no changes.
- **Interfaces:**
  ```ts
  // panelStore
  diffModeRequest: { sessionId: string; mode: GitDiffMode; nonce: number } | null;
  requestDiffMode(sessionId: string, mode: GitDiffMode): void; // sets request and revealTab(sessionId, "diff")
  clearDiffModeRequest(nonce: number): void;
  ```
- **Tests:** none (UI).
- **Done when:** `rg -n "function DiffPanel" apps` returns nothing, and `pnpm typecheck && pnpm test && pnpm build` pass.

## Task 10: Settings as a page, with prompt preview  [depends on Tasks 6, 9]

- **Files:**
  - Routing and shell: `stores/prStore.ts`, `App.tsx`, `components/Sidebar.tsx`
  - Settings: `components/SettingsModal.tsx` → rename to `components/SettingsPage.tsx`, new `components/SettingsNav.tsx`, new `stores/settingsDraftStore.ts`, `components/AppearanceSettings.tsx`, `components/UpdatesSettings.tsx`, `components/BinaryPicker.tsx`
  - Workflows: `components/prWorkflows.ts` + `prWorkflows.test.ts`, `components/WorkflowRunModal.tsx` (move `loadFailedLogs` out)
  - Other callers and CSS: `components/UsageView.tsx`, `theme.css`
- **What:** mockup screens 7–9 (search `settingsNav`, `function s7`, `s7b`, and the `/* settings page */` CSS).
  - **Routing:** Settings becomes a main view (`mainView.kind === "settings"`). While it is active:
    - The sidebar column renders `SettingsNav`: "← Back to sessions" with an Esc hint, a "Search settings" field that filters nav items by label, group "App" (General, Appearance, Updates, Source control, PR workflows) and group "Harnesses" (Claude Code, OpenCode, Codex, each with the installed version, amber when below the minimum).
    - The main column renders `SettingsPage`: a breadcrumb head, content with max-width 1180 centered and scrolling, and a sticky save bar ("Unsaved changes in <section>", Discard, Save) that appears only when the draft differs from the saved settings.
    - The rail and right panel are hidden.
    - Every existing `openSettings(harness?)` caller routes to the new view.
  - **Draft:** the draft lives in `settingsDraftStore`. Leaving the view (Back, Esc, selecting a session, Ctrl+T, opening the inbox or Usage) with a dirty draft asks `useConfirm({ title: "Discard unsaved settings?", danger: true, confirmLabel: "Discard" })`. Save keeps today's `saveSettings` flow. Settings that apply immediately today stay immediate: BinaryPicker, update channel and background download, auto-location, prune.
  - **PR workflows:**
    - A 3-column strip on top: Repositories (clone root), Updates (refresh interval), Attribution (switch plus text plus preview).
    - Below it, master–detail: a 290px list (drag handle, icon tile, label, suggest hint, enable switch, "custom" tag; "New"), and the editor.
    - Editor header: icon tile picker, label and description fields, built-in tag, Reset / Duplicate / Delete.
    - "Suggest when" is a 2-column checkbox list. "Default workspace" is a radio list with hints.
    - "Start prompt" and "Follow-up prompt" sit side by side. Each has a Template / Preview segmented control and the variable-insert chips.
    - **Preview** shows a PR selector (MenuSelect over inbox PRs "owner/repo#n title"). It loads `PrDetail` through `prStore.loadDetail`, fetches failed logs only when `needsFailedLogs(template)`, and renders `resolveTemplate(template, templateVars(detail, { attribution, harness, failedLogs }))` read-only in mono. `pr.delta` and `session.lastSeenSha` resolve to empty in preview. With no PRs it shows "No pull requests to preview with".
  - **Harness pages:** two columns.
    - The main column has:
      - Binary: the verified-installs radio list with source and version, flagged amber when below the minimum, plus "Browse for another binary…".
      - Launch: arguments field and the reasoning-expanded switch.
      - Models: a checkbox to enable, a star for the harness default (Claude uses `claudeDefaultModel`; Codex and OpenCode use the Task 6 fields and list their live models), plus custom model and display name.
      - OpenCode keeps its Go usage switch.
    - A 300px side card shows Ready / Not installed, version, minimum, account and plan use (usageStore), with Recheck and Usage buttons.
  - **General, Appearance, Updates and Source control:** keep their content, restyled into the page layout. Source control gains the project management that left the sidebar: project list with path, Copy, and "Add project…".
- **Interfaces:**
  ```ts
  // prStore
  type MainView = … | { kind: "settings"; section: SettingsSection; harness?: DriverName };
  openSettings(section?: SettingsSection, harness?: DriverName): void;
  // settingsDraftStore
  saved: AppSettings | null; draft: AppSettings | null; dirty: boolean;
  load(): Promise<void>; set(patch: Partial<AppSettings>): void; discard(): void; save(): Promise<void>;
  // prWorkflows.ts
  export async function loadFailedLogs(detail: PrDetail): Promise<string>; // moved from WorkflowRunModal, behaviour unchanged
  ```
- **Tests:** `prWorkflows.test.ts` covers the `loadFailedLogs` truncation and joining with a stubbed fetcher (make the fetcher an argument).
- **Done when:** `rg -n "SettingsModal" apps/desktop/src` returns nothing, and `pnpm typecheck && pnpm test && pnpm build` pass.

## Task 11: Composer docks and thread polish  [depends on Task 10]

- **Files:** `theme.css`, `components/TodoDock.tsx`, `components/ApprovalDock.tsx`, `components/QuestionDock.tsx`, `components/PrUpdateDock.tsx`, `components/NewThread.tsx` (CSS class hooks only, where needed)
- **What:** mockup screens 1, 3 and 11 (the `.dock`, `.apprdock`, `.q`, `.prdock` and `.wsbar` CSS).
  - Docks attach to the composer as one object. Each has margin `0 14px` so it sits inside the hull width, top radius 12, no bottom border, and a 1px ring in its tone:
    - todo: `--border-soft`;
    - approval: `--warning` at 42% with a warm tint;
    - question: `--accent` at 42% with a cool tint;
    - PR update: `--accent` at 30%.
  - The approval dock gets keyboard hints (Enter on Allow once, Esc on Reject) where those keys already work, and a mono command block.
  - The New session workspace bar attaches under the hull with bottom radius 12.
  - Composer geometry is unchanged.
- **Tests:** none.
- **Done when:** `pnpm --filter @cw-code/desktop build` passes.

## Order

- **Wave A:** Task 1.
- **Wave B (parallel):**
  - Task 2 (sidebar, `theme.css`)
  - Task 8 (backend, no CSS)
  - Task 7 (PR inbox). It does not edit `theme.css`. Its CSS goes in `components/prInbox.css`, imported by `PrInboxView.tsx`, which loads after `theme.css` and overrides the old `.pr-inbox-*` rules. The final fix round removes the superseded rules from `theme.css`.
- **Wave C:**
  - Task 3 (after 2)
  - Task 4 (after 2), which owns `theme.css`
- **Wave D (parallel):** Task 5 (own CSS file) and Task 6 (own CSS file).
- **Wave E:** Task 9.
- **Wave F:** Task 10.
- **Wave G:** Task 11.
- **Finish:** whole-branch deep review, one fix round, then `pnpm typecheck && pnpm test && pnpm build` run and read by the orchestrator.
