# [Release 04/10] Implement a serialized main-process updater service

## Status and implementation rules

This is a task-definition draft, not an implemented feature. The initial commit adds only this specification. Develop the implementation on this branch; do not merge a specification-only PR as completion. All PRs initially target main independently. Dependencies mean their implementations must be merged (or deliberately stacked/rebased for development) before this PR can pass its final acceptance gates. Rebase onto main after dependencies merge; do not mark a prerequisite complete merely because its planning document exists.

Shared decisions: Windows x64 first; GitHub Actions + public GitHub Releases + electron-updater + NSIS; no Azure; non-Azure production signing required. Background downloads default on after settings integration; install/restart requires user action. Stable and alpha only; no automatic downgrade. No renderer filesystem/process access, no AI SDK inference, no CLI-owned transcript mutation. Preserve user projects, worktrees, identities and subscription-based CLI execution. Follow CliDriver for provider lifecycle changes. Synchronize contracts, main IPC, preload, renderer types and store. Use no new dependency requiring C++ compilation.

Each implementation must pass pnpm typecheck, pnpm test and pnpm build, plus task-specific verification. Test stable contracts and behavior; verify UI/wiring with typecheck/build and integrated manual checks rather than component snapshots. Run installed upgrade tests in disposable Windows environments, never against the developer's live installation. External service enrollment/purchases require the owner's action/approval and are not implied by a planning draft.

Planning-time local baseline (2026-09-14): 549 tests passed across 44 files. Typecheck could not resolve node-pty; production renderer build could not resolve @fontsource-variable/inter. These checks used the existing local workspace with pre-existing uncommitted work, not the remote PR branches. No source changes were made to fix that unrelated environment. Reproduce on a clean frozen-lockfile install in step 01 and report the actual clean-branch result; do not claim these task-definition commits pass implementation checks.

## Outcome

Discover and download verified updates through electron-updater with deterministic, retryable state and no renderer process privileges.

## Dependencies

- Depends on #7: https://github.com/albertofa/cw-code/pull/7. Required before implementation acceptance/merge.

## Starting files

- `apps/desktop/src/main/updates/UpdateService.ts (new)`
- `apps/desktop/src/main/updates/ElectronUpdaterAdapter.ts (new)`
- `apps/desktop/src/main/updates/updateState.ts (new)`
- `packages/contracts/src/updates.ts (new)`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/cw.ts`
- `apps/desktop/src/renderer/src/stores/appStore.ts`
- `apps/desktop/electron-builder.yml`

Paths identify intended ownership, not a requirement to preserve an unsuitable existing structure. Inspect current main and prerequisite implementations before editing.

## Implementation checklist

- [ ] Pin a compatible electron-updater dependency and lockfile. Generate build-time GitHub provider configuration for albertofa/cw-code and channel manifests. No shared GitHub token is shipped to clients; no renderer-provided feed URL or executable path is accepted.
- [ ] Separate a thin library adapter from a TypeScript service and pure state transitions; do not add T3's Effect framework. Define state fields for running/available/downloaded versions, channel, progress, checkedAt, error context, retryability and disabled reason.
- [ ] Represent disabled, idle, checking, up-to-date, available, downloading, ready, installing and error states. Keep a downloaded installer usable after transient checks fail or report no newer version; reject stale channel/download events.
- [ ] Serialize check/download/install reservation/channel changes in main. Deduplicate repeated requests and make snapshot-plus-event subscription race safe. Return typed action results, not silent no-ops.
- [ ] Use installed packaged builds only; developer, unpacked or missing-feed cases explain why updates are disabled. Check after startup and every six hours with jitter/backoff; manual checking bypasses schedule but not operation locks. Dispose timers/listeners.
- [ ] Use stable and alpha channels with explicit prerelease eligibility and no downgrade after any channel setter. Alpha -> stable waits until an eligible newer stable exists. Persisted user settings and install invocation are integrated in step 05.
- [ ] Set autoInstallOnAppQuit:false explicitly. Expose explicit download policy; keep automatic downloads disabled until step 05 supplies the persisted setting. Retain checksum/signature verification and differential-download fallback supported by the pinned library.
- [ ] Log redacted updater events and bounded progress milestones. Normalize malformed release notes defensively so they cannot block updates; never execute remote content.

## Acceptance criteria

- [ ] All bridge layers compile; main validates requests and serializes every operation across windows/entry points.
- [ ] Offline/error/retry behavior is visible; ready downloads survive transient checks; stable never receives alpha or lower versions.
- [ ] No public updater is active in development and no installer can run before the safe-install integration in step 05.

## Validation and evidence

- [ ] Contract tests using a fake adapter for state transitions, channel selection, event ordering, duplicate requests and retries; no UI snapshot tests.
- [ ] Run pnpm typecheck, pnpm test and pnpm build; inspect packaged app-update.yml and generated manifests.

Record the exact commands, results, artifact versions/SHAs and any manual Windows evidence in the PR before marking ready. Existing planning commits contain no implementation and have not satisfied these checkboxes.

## Out of scope

No installer invocation before step 05, remote update server, Azure, analytics or OS expansion.

## Completion procedure

Implement on this branch, incorporate merged dependencies, replace this task-definition document with maintained operational documentation where appropriate (or remove it), and rewrite the PR summary around the delivered behavior. Keep the dependency and verification evidence. Mark ready only when every required acceptance criterion is met.
