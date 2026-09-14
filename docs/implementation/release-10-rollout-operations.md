# [Release 10/10] Commission updater rollout and release recovery operations

## Status and implementation rules

This is a task-definition draft, not an implemented feature. The initial commit adds only this specification. Develop the implementation on this branch; do not merge a specification-only PR as completion. All PRs initially target main independently. Dependencies mean their implementations must be merged (or deliberately stacked/rebased for development) before this PR can pass its final acceptance gates. Rebase onto main after dependencies merge; do not mark a prerequisite complete merely because its planning document exists.

Shared decisions: Windows x64 first; GitHub Actions + public GitHub Releases + electron-updater + NSIS; no Azure; non-Azure production signing required. Background downloads default on after settings integration; install/restart requires user action. Stable and alpha only; no automatic downgrade. No renderer filesystem/process access, no AI SDK inference, no CLI-owned transcript mutation. Preserve user projects, worktrees, identities and subscription-based CLI execution. Follow CliDriver for provider lifecycle changes. Synchronize contracts, main IPC, preload, renderer types and store. Use no new dependency requiring C++ compilation.

Each implementation must pass pnpm typecheck, pnpm test and pnpm build, plus task-specific verification. Test stable contracts and behavior; verify UI/wiring with typecheck/build and integrated manual checks rather than component snapshots. Run installed upgrade tests in disposable Windows environments, never against the developer's live installation. External service enrollment/purchases require the owner's action/approval and are not implied by a planning draft.

Planning-time local baseline (2026-09-14): 549 tests passed across 44 files. Typecheck could not resolve node-pty; production renderer build could not resolve @fontsource-variable/inter. These checks used the existing local workspace with pre-existing uncommitted work, not the remote PR branches. No source changes were made to fix that unrelated environment. Reproduce on a clean frozen-lockfile install in step 01 and report the actual clean-branch result; do not claim these task-definition commits pass implementation checks.

## Outcome

Ship the updater-enabled bootstrap release, prove the first real in-app upgrade and leave a maintainable release/recovery process.

## Dependencies

- Depends on #15: https://github.com/albertofa/cw-code/pull/15. Required before implementation acceptance/merge.

## Starting files

- `README.md`
- `docs/operations/releases.md`
- `docs/operations/windows-signing.md`
- `docs/operations/update-testing.md`
- `.github/workflows/check-update-feed.yml (new)`

Paths identify intended ownership, not a requirement to preserve an unsuitable existing structure. Inspect current main and prerequisite implementations before editing.

## Implementation checklist

- [ ] Document the complete dependency sequence and actual operator inputs: candidate selection, alpha/stable promotion, required repository settings, signing renewal, production enablement, rollout pause and recovery contacts. Keep operational facts aligned with implemented workflows.
- [ ] Use a scheduled read-only feed check with bounded frequency/backoff. Validate stable/alpha metadata and referenced asset availability; surface actionable failures in Actions. Do not create noise/issues on every unchanged run or collect user prompts, paths or telemetry.
- [ ] Commission with an isolated signed candidate, then intentionally enable production. Publish the first updater-enabled release through step 09. The task includes these explicit production actions; do not accidentally trigger them while editing/testing workflow files.
- [ ] Test installation over the actual previously released legacy installer in a disposable Windows environment. Explain publicly that current users need one final manual install; preserve custom path, install scope, data and worktrees.
- [ ] Publish a subsequent real alpha release, install it through the bootstrap app, and record evidence of no browser/manual installer handling, successful relaunch, data preservation and CLI resume. Then intentionally select/promote the verified candidate to stable.
- [ ] Write and rehearse bad-release response: stop future publication/offerings as appropriate, recognize cached/downloaded installers may remain installable, publish corrected code with a higher version, keep recovery installer and metadata backups. Do not claim remote revocation or automatic NSIS rollback.
- [ ] Define artifact retention, old blockmap retention, short CI artifact retention, signing expiry reminders and CI/storage budget controls. Document actual service costs without assuming SignPath acceptance or zero cost for all account plans.
- [ ] Record remaining manual support cases: per-machine UAC, installer interrupted by OS shutdown, unknown/newer schema and failed startup. Defer R2, rollout percentages and opt-in health telemetry until a concrete need; no premature service provision.

## Acceptance criteria

- [ ] Existing users have clear one-time migration instructions and subsequent update works in-app end to end.
- [ ] First production publication and later in-app upgrade evidence identify exact versions/SHAs and preserved metadata.
- [ ] Feed monitor and recovery/signing runbooks exist; production enablement is deliberate and bad-release drill produces a usable path.

## Validation and evidence

- [ ] Run pnpm typecheck, pnpm test and pnpm build; verify real legacy -> bootstrap -> successor sequence in disposable Windows installs.
- [ ] Do not mark ready just because documentation merged: capture rollout evidence or state the exact external blocker and keep this PR draft.

Record the exact commands, results, artifact versions/SHAs and any manual Windows evidence in the PR before marking ready. Existing planning commits contain no implementation and have not satisfied these checkboxes.

## Out of scope

No Azure, forced updates, client analytics, custom backend, R2 migration or unsupported automatic rollback.

## Completion procedure

Implement on this branch, incorporate merged dependencies, replace this task-definition document with maintained operational documentation where appropriate (or remove it), and rewrite the PR summary around the delivered behavior. Keep the dependency and verification evidence. Mark ready only when every required acceptance criterion is met.
