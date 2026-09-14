# [Release 02/10] Add versioned metadata migrations and recoverable startup

## Status and implementation rules

This is a task-definition draft, not an implemented feature. The initial commit adds only this specification. Develop the implementation on this branch; do not merge a specification-only PR as completion. All PRs initially target main independently. Dependencies mean their implementations must be merged (or deliberately stacked/rebased for development) before this PR can pass its final acceptance gates. Rebase onto main after dependencies merge; do not mark a prerequisite complete merely because its planning document exists.

Shared decisions: Windows x64 first; GitHub Actions + public GitHub Releases + electron-updater + NSIS; no Azure; non-Azure production signing required. Background downloads default on after settings integration; install/restart requires user action. Stable and alpha only; no automatic downgrade. No renderer filesystem/process access, no AI SDK inference, no CLI-owned transcript mutation. Preserve user projects, worktrees, identities and subscription-based CLI execution. Follow CliDriver for provider lifecycle changes. Synchronize contracts, main IPC, preload, renderer types and store. Use no new dependency requiring C++ compilation.

Each implementation must pass pnpm typecheck, pnpm test and pnpm build, plus task-specific verification. Test stable contracts and behavior; verify UI/wiring with typecheck/build and integrated manual checks rather than component snapshots. Run installed upgrade tests in disposable Windows environments, never against the developer's live installation. External service enrollment/purchases require the owner's action/approval and are not implied by a planning draft.

Planning-time local baseline (2026-09-14): 549 tests passed across 44 files. Typecheck could not resolve node-pty; production renderer build could not resolve @fontsource-variable/inter. These checks used the existing local workspace with pre-existing uncommitted work, not the remote PR branches. No source changes were made to fix that unrelated environment. Reproduce on a clean frozen-lockfile install in step 01 and report the actual clean-branch result; do not claim these task-definition commits pass implementation checks.

## Outcome

Allow future app upgrades to migrate local metadata without silently resetting user projects, sessions or settings.

## Dependencies

- No prior implementation PR is required; this work can start immediately.

## Starting files

- `apps/desktop/src/main/sessions/SessionStore.ts`
- `apps/desktop/src/main/settings/SettingsStore.ts`
- `apps/desktop/src/main/index.ts`
- `packages/contracts/src/settings.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/cw.ts`
- `apps/desktop/src/renderer/src/stores/appStore.ts`

Paths identify intended ownership, not a requirement to preserve an unsuitable existing structure. Inspect current main and prerequisite implementations before editing.

## Implementation checklist

- [ ] Treat existing unversioned JSON as schema 0; add explicit schema versions independently for session metadata and settings. Preserve current storage paths, project/session IDs, resume cursors, normalized roots, Git account settings and worktree references.
- [ ] Extract deterministic migration steps. Validate input shape before changing files. Preserve or deliberately migrate unknown fields; define forward-schema behavior that refuses destructive writes and shows a recoverable error.
- [ ] Back up the original bytes before the first migration; persist through a same-directory temp file and atomic rename. Make reruns safe after interruption. Separate backup creation/retention from successful replacement; never delete the only valid backup.
- [ ] Replace silent corruption-to-empty/default behavior with a visible recovery state. Never overwrite corrupt or newer-schema source data on startup. Offer opening the data directory and explicit restore from a verified backup; do not silently restore an older snapshot.
- [ ] Move initialization/error handling as needed so metadata failures can render a recovery screen without initializing drivers against empty data. Synchronize main, preload, contracts, renderer types and store for recovery actions.
- [ ] Add sanitized schema-0 fixtures based on actual stored shapes copied read-only, with no credentials or transcripts. Migrations apply only to cw-code-owned files, never CLI sessions, repository files or worktree contents.

## Acceptance criteria

- [ ] Schema-0 sessions/settings retain all established identifiers and settings after upgrade and repeated startup.
- [ ] Malformed JSON, unsupported future schema, failed backup/write/rename leave original data intact and show an actionable error.
- [ ] User-confirmed backup restoration works; path names and userData location remain compatible with installed versions.

## Validation and evidence

- [ ] Contract tests for migration, idempotence, interrupted writes, future schema, corrupt files and restore validation.
- [ ] Run pnpm typecheck, pnpm test and pnpm build; manually verify recovery presentation without snapshot/UI wiring tests.

Record the exact commands, results, artifact versions/SHAs and any manual Windows evidence in the PR before marking ready. Existing planning commits contain no implementation and have not satisfied these checkboxes.

## Out of scope

No database replacement, CLI transcript migrations, automatic downgrade or telemetry.

## Completion procedure

Implement on this branch, incorporate merged dependencies, replace this task-definition document with maintained operational documentation where appropriate (or remove it), and rewrite the PR summary around the delivered behavior. Keep the dependency and verification evidence. Mark ready only when every required acceptance criterion is met.
