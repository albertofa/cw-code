# [Release 08/10] Automate candidate versions and explicit stable promotion

## Status and implementation rules

This is a task-definition draft, not an implemented feature. The initial commit adds only this specification. Develop the implementation on this branch; do not merge a specification-only PR as completion. All PRs initially target main independently. Dependencies mean their implementations must be merged (or deliberately stacked/rebased for development) before this PR can pass its final acceptance gates. Rebase onto main after dependencies merge; do not mark a prerequisite complete merely because its planning document exists.

Shared decisions: Windows x64 first; GitHub Actions + public GitHub Releases + electron-updater + NSIS; no Azure; non-Azure production signing required. Background downloads default on after settings integration; install/restart requires user action. Stable and alpha only; no automatic downgrade. No renderer filesystem/process access, no AI SDK inference, no CLI-owned transcript mutation. Preserve user projects, worktrees, identities and subscription-based CLI execution. Follow CliDriver for provider lifecycle changes. Synchronize contracts, main IPC, preload, renderer types and store. Use no new dependency requiring C++ compilation.

Each implementation must pass pnpm typecheck, pnpm test and pnpm build, plus task-specific verification. Test stable contracts and behavior; verify UI/wiring with typecheck/build and integrated manual checks rather than component snapshots. Run installed upgrade tests in disposable Windows environments, never against the developer's live installation. External service enrollment/purchases require the owner's action/approval and are not implied by a planning draft.

Planning-time local baseline (2026-09-14): 549 tests passed across 44 files. Typecheck could not resolve node-pty; production renderer build could not resolve @fontsource-variable/inter. These checks used the existing local workspace with pre-existing uncommitted work, not the remote PR branches. No source changes were made to fix that unrelated environment. Reproduce on a clean frozen-lockfile install in step 01 and report the actual clean-branch result; do not claim these task-definition commits pass implementation checks.

## Outcome

Generate consistent versions and release notes, and resolve stable releases to an explicitly tested candidate commit.

## Dependencies

- Depends on #7: https://github.com/albertofa/cw-code/pull/7. Required before implementation acceptance/merge.

## Starting files

- `scripts/release-version.* (new)`
- `scripts/resolve-release.* (new)`
- `package.json`
- `apps/desktop/package.json`
- `pnpm-lock.yaml`
- `.github/workflows/release-plan.yml (new)`
- `.github/release.yml (new as appropriate)`

Paths identify intended ownership, not a requirement to preserve an unsuitable existing structure. Inspect current main and prerequisite implementations before editing.

## Implementation checklist

- [ ] Use one authoritative release-version input and synchronize root/desktop package versions, lockfile metadata and packaged version. Tag must equal v<desktop-version>; reject malformed, duplicate, already-published or backwards versions.
- [ ] Define stable X.Y.Z and alpha X.Y.Z-alpha.N. Require alpha candidates to use the next intended stable version, with monotonically increasing N. Changing channels must never implicitly lower the client version.
- [ ] Generate release plans/notes from an exact SHA and previous release in the same channel. Document labels or Conventional Commit conventions if used; select one minimal approach rather than combining multiple release managers.
- [ ] Accept explicit candidate tag/SHA for stable promotion, verify it is an eligible successful candidate and record its source SHA. Rebuild with stable version and require re-verification; never resolve 'latest candidate' after a human tested a specific one.
- [ ] Implement a validation-only workflow that produces proposed versions/notes/metadata as artifacts and cannot create tags, releases, npm publications or commits. Tests must not push test tags.
- [ ] Specify automatic alpha policy: after successful main CI and changed commits, coalesce release requests to at most one per six hours. Stable is triggered by merging a generated release PR or explicit candidate dispatch; choose and document one default.
- [ ] Keep version-commit/tag recursion under control, handle concurrent reservations and retries, and reject stale source commits before publication. Expose machine-readable outputs for step 09 without adding production publication here.

## Acceptance criteria

- [ ] Release plans deterministically agree on version/channel/SHA and notes; invalid or conflicting plans fail before mutation.
- [ ] Stable promotion refers to the exact tested candidate source, not moving main or latest-nightly state.
- [ ] Validation-only runs create no remote release/tag/version commit; alpha policy skips unchanged commits.

## Validation and evidence

- [ ] Stable contract tests for version synchronization, candidate resolution, channel comparison, reruns and concurrent/stale plans.
- [ ] Run pnpm typecheck, pnpm test and pnpm build; exercise all triggers in dry-run/fixture mode.

Record the exact commands, results, artifact versions/SHAs and any manual Windows evidence in the PR before marking ready. Existing planning commits contain no implementation and have not satisfied these checkboxes.

## Out of scope

No actual release publication, manual bumping of unrelated packages or forced downgrade.

## Completion procedure

Implement on this branch, incorporate merged dependencies, replace this task-definition document with maintained operational documentation where appropriate (or remove it), and rewrite the PR summary around the delivered behavior. Keep the dependency and verification evidence. Mark ready only when every required acceptance criterion is met.
