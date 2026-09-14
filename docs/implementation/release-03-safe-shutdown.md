# [Release 03/10] Coordinate restart around active CLI work and unsaved edits

## Status and implementation rules

This is a task-definition draft, not an implemented feature. The initial commit adds only this specification. Develop the implementation on this branch; do not merge a specification-only PR as completion. All PRs initially target main independently. Dependencies mean their implementations must be merged (or deliberately stacked/rebased for development) before this PR can pass its final acceptance gates. Rebase onto main after dependencies merge; do not mark a prerequisite complete merely because its planning document exists.

Shared decisions: Windows x64 first; GitHub Actions + public GitHub Releases + electron-updater + NSIS; no Azure; non-Azure production signing required. Background downloads default on after settings integration; install/restart requires user action. Stable and alpha only; no automatic downgrade. No renderer filesystem/process access, no AI SDK inference, no CLI-owned transcript mutation. Preserve user projects, worktrees, identities and subscription-based CLI execution. Follow CliDriver for provider lifecycle changes. Synchronize contracts, main IPC, preload, renderer types and store. Use no new dependency requiring C++ compilation.

Each implementation must pass pnpm typecheck, pnpm test and pnpm build, plus task-specific verification. Test stable contracts and behavior; verify UI/wiring with typecheck/build and integrated manual checks rather than component snapshots. Run installed upgrade tests in disposable Windows environments, never against the developer's live installation. External service enrollment/purchases require the owner's action/approval and are not implied by a planning draft.

Planning-time local baseline (2026-09-14): 549 tests passed across 44 files. Typecheck could not resolve node-pty; production renderer build could not resolve @fontsource-variable/inter. These checks used the existing local workspace with pre-existing uncommitted work, not the remote PR branches. No source changes were made to fix that unrelated environment. Reproduce on a clean frozen-lockfile install in step 01 and report the actual clean-branch result; do not claim these task-definition commits pass implementation checks.

## Outcome

Provide one reusable shutdown coordinator that can safely prepare for an update and recover if installation never starts.

## Dependencies

- Depends on #8: https://github.com/albertofa/cw-code/pull/8. Required before implementation acceptance/merge.

## Starting files

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/sessions/SessionManager.ts`
- `apps/desktop/src/main/pty/PtyPool.ts`
- `packages/contracts/src/provider.ts`
- `apps/desktop/src/renderer/src/components/FilePanel.tsx`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/cw.ts`
- `apps/desktop/src/renderer/src/stores/appStore.ts`

Paths identify intended ownership, not a requirement to preserve an unsuitable existing structure. Inspect current main and prerequisite implementations before editing.

## Implementation checklist

- [ ] Inventory every app-owned CLI process, background title-generation turn, managed server and PTY. Add lifecycle/status APIs through CliDriver rather than provider-specific branches in UI or orchestration.
- [ ] Implement a coordinator with assess, wait/cancel, prepare, commit and recover phases. Inspect all sessions, not only the focused one. Atomically prevent new process-creating work once committed to shutdown; waiting must remain cancellable and must not silently discard new work.
- [ ] Expose active-turn and open-terminal blockers. Offer wait or explicit stop for active work; treat an open terminal as potentially busy without guessing its foreground process.
- [ ] Track dirty editor buffers across open files and obtain save/discard/cancel decisions before stopping processes. Failed saves cancel installation. Preserve composer drafts and workspace selection where applicable without auto-saving repository changes without consent.
- [ ] Flush app-owned state and buffered events before terminating children. Stop only owned handles/PIDs using bounded graceful shutdown via drivers; never kill by process name. Timeout produces an explicit continue/force/cancel decision rather than an unbounded hang.
- [ ] Make before-quit coordination re-entrant safe, handle updater-triggered quit without recursive prompts, and add single-instance protection before writable stores are opened.
- [ ] Provide recovery that clears the shutdown reservation and reinitializes required services if the caller fails before process exit. Interrupted turns must remain honestly marked interrupted; never automatically resend a prompt or promise a live process resumed.

## Acceptance criteria

- [ ] An active background session and dirty file block restart just like focused work; cancel keeps the application usable.
- [ ] Shutdown flushes data and disposes every owned process once; external user CLI processes are untouched.
- [ ] A simulated installer-start failure restores usable services and permits retry; repeated close/install requests do not race.

## Validation and evidence

- [ ] Contract tests for lifecycle ordering, session isolation, cancellation, timeout, ownership and re-entry; test editor behavior manually.
- [ ] Run pnpm typecheck, pnpm test and pnpm build. Perform a real CLI/PTY shutdown smoke in an isolated test project.

Record the exact commands, results, artifact versions/SHAs and any manual Windows evidence in the PR before marking ready. Existing planning commits contain no implementation and have not satisfied these checkboxes.

## Out of scope

No actual updater library integration, automatic turn replay or process resurrection.

## Completion procedure

Implement on this branch, incorporate merged dependencies, replace this task-definition document with maintained operational documentation where appropriate (or remove it), and rewrite the PR summary around the delivered behavior. Keep the dependency and verification evidence. Mark ready only when every required acceptance criterion is met.
