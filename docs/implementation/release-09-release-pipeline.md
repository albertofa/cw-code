# [Release 09/10] Publish verified signed releases through GitHub Actions

## Status and implementation rules

This is a task-definition draft, not an implemented feature. The initial commit adds only this specification. Develop the implementation on this branch; do not merge a specification-only PR as completion. All PRs initially target main independently. Dependencies mean their implementations must be merged (or deliberately stacked/rebased for development) before this PR can pass its final acceptance gates. Rebase onto main after dependencies merge; do not mark a prerequisite complete merely because its planning document exists.

Shared decisions: Windows x64 first; GitHub Actions + public GitHub Releases + electron-updater + NSIS; no Azure; non-Azure production signing required. Background downloads default on after settings integration; install/restart requires user action. Stable and alpha only; no automatic downgrade. No renderer filesystem/process access, no AI SDK inference, no CLI-owned transcript mutation. Preserve user projects, worktrees, identities and subscription-based CLI execution. Follow CliDriver for provider lifecycle changes. Synchronize contracts, main IPC, preload, renderer types and store. Use no new dependency requiring C++ compilation.

Each implementation must pass pnpm typecheck, pnpm test and pnpm build, plus task-specific verification. Test stable contracts and behavior; verify UI/wiring with typecheck/build and integrated manual checks rather than component snapshots. Run installed upgrade tests in disposable Windows environments, never against the developer's live installation. External service enrollment/purchases require the owner's action/approval and are not implied by a planning draft.

Planning-time local baseline (2026-09-14): 549 tests passed across 44 files. Typecheck could not resolve node-pty; production renderer build could not resolve @fontsource-variable/inter. These checks used the existing local workspace with pre-existing uncommitted work, not the remote PR branches. No source changes were made to fix that unrelated environment. Reproduce on a clean frozen-lockfile install in step 01 and report the actual clean-branch result; do not claim these task-definition commits pass implementation checks.

## Outcome

Build, sign, verify and publish complete Windows update releases from a trusted immutable commit without manual uploads.

## Dependencies

- Depends on #12: https://github.com/albertofa/cw-code/pull/12. Required before implementation acceptance/merge.
- Depends on #13: https://github.com/albertofa/cw-code/pull/13. Required before implementation acceptance/merge.
- Depends on #14: https://github.com/albertofa/cw-code/pull/14. Required before implementation acceptance/merge.

## Starting files

- `.github/workflows/release.yml (new)`
- `scripts/validate-release-assets.* (new)`
- `scripts/publish-release.* (new as needed)`
- `apps/desktop/electron-builder.yml`
- `docs/operations/releases.md (new)`

Paths identify intended ownership, not a requirement to preserve an unsuitable existing structure. Inspect current main and prerequisite implementations before editing.

## Implementation checklist

- [ ] Consume step-08 version/channel/source plan; build from the exact immutable SHA. Enable production publishing only through an explicit repository setting configured in step 10; default to validation-only until commissioning completes.
- [ ] Run typecheck, full suite and production build on release source; package Windows x64; invoke step-07 signing in trusted context; generate final installer/manifests/blockmaps. Pin third-party Actions to reviewed full SHAs.
- [ ] Run packaged native-load checks and step-06 signed N -> N+1 test using the final candidate bytes through an isolated feed. Validate expected publisher, version, architecture, checksum, metadata schema and every referenced asset before publication.
- [ ] Create a draft GitHub Release, upload the complete immutable artifact set, re-download and validate it, then publish. Mark alpha as prerelease/not-latest and stable appropriately. Never advertise a feed referencing partial uploads.
- [ ] Serialize by channel without cancelling an in-flight publisher. Recheck release version ordering before final publication. Reruns may resume the same draft/SHA but must not silently overwrite different published bytes under an existing tag.
- [ ] Limit contents:write to publication jobs and signing secrets to signing jobs; PR jobs cannot enter this trust path. Keep release artifacts separate from short-retention CI artifacts and record SHA/tool versions/signing results.
- [ ] After publication, anonymously verify client-facing URLs, version/channel selection and asset availability. Fail visibly on errors and link the recovery runbook; a failed job must not automatically publish an unsigned fallback.
- [ ] Validate public repository/download accessibility. If source visibility changes, use a public distribution repo with scoped CI-only credentials; never ship a shared PAT. No npm, web, Azure or remote backend deployments are coupled to this workflow.

## Acceptance criteria

- [ ] Validation-only mode runs the full trusted build/verification graph without publication; enablement is off by default.
- [ ] Production run produces one complete signed release from the intended SHA; clients see correct channel and artifact.
- [ ] Signing/test/upload failures leave no public incomplete release; concurrent/stale/rerun scenarios preserve monotonic immutable releases.

## Validation and evidence

- [ ] Run pnpm typecheck, pnpm test and pnpm build; contract tests for asset completeness/channel/hash validation.
- [ ] Execute a full validation run, including signed installed-upgrade tests. First actual publication is step 10, not an incidental test tag.

Record the exact commands, results, artifact versions/SHAs and any manual Windows evidence in the PR before marking ready. Existing planning commits contain no implementation and have not satisfied these checkboxes.

## Out of scope

No automatic stable release for every merge, public test tags, other platform matrix, paid runners or custom hosting.

## Completion procedure

Implement on this branch, incorporate merged dependencies, replace this task-definition document with maintained operational documentation where appropriate (or remove it), and rewrite the PR summary around the delivered behavior. Keep the dependency and verification evidence. Mark ready only when every required acceptance criterion is met.
