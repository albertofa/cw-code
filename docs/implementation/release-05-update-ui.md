# [Release 05/10] Add update controls and connect safe installation

## Status and implementation rules

This is a task-definition draft, not an implemented feature. The initial commit adds only this specification. Develop the implementation on this branch; do not merge a specification-only PR as completion. All PRs initially target main independently. Dependencies mean their implementations must be merged (or deliberately stacked/rebased for development) before this PR can pass its final acceptance gates. Rebase onto main after dependencies merge; do not mark a prerequisite complete merely because its planning document exists.

Shared decisions: Windows x64 first; GitHub Actions + public GitHub Releases + electron-updater + NSIS; no Azure; non-Azure production signing required. Background downloads default on after settings integration; install/restart requires user action. Stable and alpha only; no automatic downgrade. No renderer filesystem/process access, no AI SDK inference, no CLI-owned transcript mutation. Preserve user projects, worktrees, identities and subscription-based CLI execution. Follow CliDriver for provider lifecycle changes. Synchronize contracts, main IPC, preload, renderer types and store. Use no new dependency requiring C++ compilation.

Each implementation must pass pnpm typecheck, pnpm test and pnpm build, plus task-specific verification. Test stable contracts and behavior; verify UI/wiring with typecheck/build and integrated manual checks rather than component snapshots. Run installed upgrade tests in disposable Windows environments, never against the developer's live installation. External service enrollment/purchases require the owner's action/approval and are not implied by a planning draft.

Planning-time local baseline (2026-09-14): 549 tests passed across 44 files. Typecheck could not resolve node-pty; production renderer build could not resolve @fontsource-variable/inter. These checks used the existing local workspace with pre-existing uncommitted work, not the remote PR branches. No source changes were made to fix that unrelated environment. Reproduce on a clean frozen-lockfile install in step 01 and report the actual clean-branch result; do not claim these task-definition commits pass implementation checks.

## Outcome

Users can discover, download and install an update from the app while preserving active work and receiving clear progress/errors.

## Dependencies

- Depends on #8: https://github.com/albertofa/cw-code/pull/8. Required before implementation acceptance/merge.
- Depends on #9: https://github.com/albertofa/cw-code/pull/9. Required before implementation acceptance/merge.
- Depends on #10: https://github.com/albertofa/cw-code/pull/10. Required before implementation acceptance/merge.

## Starting files

- `apps/desktop/src/renderer/src/components/SettingsModal.tsx`
- `apps/desktop/src/renderer/src/components/Sidebar.tsx`
- `apps/desktop/src/renderer/src/components/Notifications.tsx`
- `apps/desktop/src/renderer/src/stores/appStore.ts`
- `apps/desktop/src/main/settings/SettingsStore.ts`
- `packages/contracts/src/settings.ts`
- `apps/desktop/src/main/updates/UpdateService.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/cw.ts`

Paths identify intended ownership, not a requirement to preserve an unsuitable existing structure. Inspect current main and prerequisite implementations before editing.

## Implementation checklist

- [ ] Add Settings controls for installed version, selected stable/alpha channel, last check, Check for updates, background downloads (default on) and release notes. Map a new install's default channel from its version and persist later user selection.
- [ ] Add a restrained sidebar/title-area update indicator: available -> download/progress -> Update and restart. With background downloads off, click downloads first; with them on, still require an explicit restart click. Keep Later, retry, disabled and up-to-date states understandable and keyboard accessible.
- [ ] Render sanitized release notes as text/controlled markdown without raw HTML or arbitrary protocols. Throttle progress rendering by time/small percentage increments; do not flood the store.
- [ ] Wire installUpdate through the step-03 coordinator, not directly from renderer to quitAndInstall. Bind install intent to the verified downloaded version/channel, revalidate after waiting and reject superseded state.
- [ ] Allow wait/explicit stop of active turns, address terminal warnings and save/discard/cancel, then flush/stop and invoke quitAndInstall with intended relaunch behavior. Never install on ordinary quit or OS session end automatically.
- [ ] If invocation fails before exit, recover app services and restore the ready-to-install state with a useful error. Preserve retry ability and avoid duplicate toasts for the same failure.
- [ ] Maintain session context on restart without automatically restarting completed/interrupted turns. Explain that live terminals are stopped. Update contracts/IPC/preload/types/store together for every new action.

## Acceptance criteria

- [ ] A user can complete check -> download -> update/restart without opening a browser; no restart occurs without consent.
- [ ] Background download preference persists; offline checks and installation failures have usable retry paths.
- [ ] All-session active work and unsaved edits are resolved safely; cancel returns to normal use; successful restart retains projects/settings/cursors.

## Validation and evidence

- [ ] Run pnpm typecheck, pnpm test and pnpm build; unit tests only for stable settings/action contracts.
- [ ] Manually verify keyboard navigation, progress/errors, opt-out, Later, channel changes and each shutdown decision using the local harness when step 06 is available.

Record the exact commands, results, artifact versions/SHAs and any manual Windows evidence in the PR before marking ready. Existing planning commits contain no implementation and have not satisfied these checkboxes.

## Out of scope

No forced updates, automatic prompt replay, client telemetry or styling redesign unrelated to updating.

## Completion procedure

Implement on this branch, incorporate merged dependencies, replace this task-definition document with maintained operational documentation where appropriate (or remove it), and rewrite the PR summary around the delivered behavior. Keep the dependency and verification evidence. Mark ready only when every required acceptance criterion is met.
