# [Release 06/10] Build an isolated installed-upgrade test harness

## Status and implementation rules

This is a task-definition draft, not an implemented feature. The initial commit adds only this specification. Develop the implementation on this branch; do not merge a specification-only PR as completion. All PRs initially target main independently. Dependencies mean their implementations must be merged (or deliberately stacked/rebased for development) before this PR can pass its final acceptance gates. Rebase onto main after dependencies merge; do not mark a prerequisite complete merely because its planning document exists.

Shared decisions: Windows x64 first; GitHub Actions + public GitHub Releases + electron-updater + NSIS; no Azure; non-Azure production signing required. Background downloads default on after settings integration; install/restart requires user action. Stable and alpha only; no automatic downgrade. No renderer filesystem/process access, no AI SDK inference, no CLI-owned transcript mutation. Preserve user projects, worktrees, identities and subscription-based CLI execution. Follow CliDriver for provider lifecycle changes. Synchronize contracts, main IPC, preload, renderer types and store. Use no new dependency requiring C++ compilation.

Each implementation must pass pnpm typecheck, pnpm test and pnpm build, plus task-specific verification. Test stable contracts and behavior; verify UI/wiring with typecheck/build and integrated manual checks rather than component snapshots. Run installed upgrade tests in disposable Windows environments, never against the developer's live installation. External service enrollment/purchases require the owner's action/approval and are not implied by a planning draft.

Planning-time local baseline (2026-09-14): 549 tests passed across 44 files. Typecheck could not resolve node-pty; production renderer build could not resolve @fontsource-variable/inter. These checks used the existing local workspace with pre-existing uncommitted work, not the remote PR branches. No source changes were made to fix that unrelated environment. Reproduce on a clean frozen-lockfile install in step 01 and report the actual clean-branch result; do not claim these task-definition commits pass implementation checks.

## Outcome

Prove that an installed cw-code N can update to N+1 before production publishing is enabled.

## Dependencies

- Depends on #7: https://github.com/albertofa/cw-code/pull/7. Required before implementation acceptance/merge.
- Depends on #8: https://github.com/albertofa/cw-code/pull/8. Required before implementation acceptance/merge.
- Depends on #9: https://github.com/albertofa/cw-code/pull/9. Required before implementation acceptance/merge.
- Depends on #10: https://github.com/albertofa/cw-code/pull/10. Required before implementation acceptance/merge.
- Depends on #11: https://github.com/albertofa/cw-code/pull/11. Required before implementation acceptance/merge.

## Starting files

- `scripts/mock-update-server.* (new)`
- `scripts/verify-installed-upgrade.* (new)`
- `apps/desktop/src/main/updates test adapters`
- `apps/desktop/package.json`
- `package.json`
- `.github/workflows/ci.yml`
- `docs/operations/update-testing.md (new)`

Paths identify intended ownership, not a requirement to preserve an unsuitable existing structure. Inspect current main and prerequisite implementations before editing.

## Implementation checklist

- [ ] Create a loopback-only generic feed server serving final installer/manifests/blockmaps from an isolated root; support HTTP range requests and deterministic fault injection. Reject path traversal and symlink escapes.
- [ ] Permit test feed configuration only in dedicated test builds/build-time flags; production builds must not accept an arbitrary runtime feed override. Use separate test app identity/userData in CI; actual legacy-identity upgrade tests run only inside disposable Windows environments.
- [ ] Build/install N and N+1, seed sanitized projects/sessions/settings/worktree references and use the real updater to download/install/relaunch. Assert installed version changed and preserved metadata; process exit or installer exit code alone is not success.
- [ ] Exercise skipped versions, alpha eligibility, no downgrades, existing per-user and per-machine/custom-directory installs, cancellation, busy turns, dirty buffers, reboot/relaunch behavior and recovery when installation cannot start.
- [ ] Inject unavailable feed, truncated download, stale/missing manifests, corrupted checksum, insufficient disk and denied installer execution. Separate automated scenarios from explicitly documented manual VM cases.
- [ ] Measure full and differential download bytes and duration using representative builds; verify fallback when an old blockmap is missing. Keep previous payloads long enough to exercise both paths.
- [ ] Attach redacted evidence and logs as short-retention artifacts. Use fake CLI processes for automated tests and a documented real CLI smoke in an isolated project without subscribing CI to personal accounts.
- [ ] Provide the trusted signed-artifact test entrypoint for step 09 once step 07 exists; wrong-publisher/signature rejection must use a controlled signed fixture and must not disable verification globally.

## Acceptance criteria

- [ ] Repeatable N -> N+1 and skipped-version evidence proves a real installed application relaunches with preserved metadata.
- [ ] Failure tests leave the old installation/data recoverable and display actionable state.
- [ ] No test touches the developer's installed cw-code/userData, publishes a real release or leaks credentials.

## Validation and evidence

- [ ] Run pnpm typecheck, pnpm test and pnpm build; add contract tests for feed sandbox/range logic and manifest validation.
- [ ] Run the packaged Windows harness; list manual-only conditions honestly and block production enablement until the signed verification in step 09 passes.

Record the exact commands, results, artifact versions/SHAs and any manual Windows evidence in the PR before marking ready. Existing planning commits contain no implementation and have not satisfied these checkboxes.

## Out of scope

No publishing, provider enrollment or replacing real upgrade tests with state-machine mocks.

## Completion procedure

Implement on this branch, incorporate merged dependencies, replace this task-definition document with maintained operational documentation where appropriate (or remove it), and rewrite the PR summary around the delivered behavior. Keep the dependency and verification evidence. Mark ready only when every required acceptance criterion is met.
