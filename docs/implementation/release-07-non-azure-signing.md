# [Release 07/10] Integrate non-Azure Windows signing with production gates

## Status and implementation rules

This is a task-definition draft, not an implemented feature. The initial commit adds only this specification. Develop the implementation on this branch; do not merge a specification-only PR as completion. All PRs initially target main independently. Dependencies mean their implementations must be merged (or deliberately stacked/rebased for development) before this PR can pass its final acceptance gates. Rebase onto main after dependencies merge; do not mark a prerequisite complete merely because its planning document exists.

Shared decisions: Windows x64 first; GitHub Actions + public GitHub Releases + electron-updater + NSIS; no Azure; non-Azure production signing required. Background downloads default on after settings integration; install/restart requires user action. Stable and alpha only; no automatic downgrade. No renderer filesystem/process access, no AI SDK inference, no CLI-owned transcript mutation. Preserve user projects, worktrees, identities and subscription-based CLI execution. Follow CliDriver for provider lifecycle changes. Synchronize contracts, main IPC, preload, renderer types and store. Use no new dependency requiring C++ compilation.

Each implementation must pass pnpm typecheck, pnpm test and pnpm build, plus task-specific verification. Test stable contracts and behavior; verify UI/wiring with typecheck/build and integrated manual checks rather than component snapshots. Run installed upgrade tests in disposable Windows environments, never against the developer's live installation. External service enrollment/purchases require the owner's action/approval and are not implied by a planning draft.

Planning-time local baseline (2026-09-14): 549 tests passed across 44 files. Typecheck could not resolve node-pty; production renderer build could not resolve @fontsource-variable/inter. These checks used the existing local workspace with pre-existing uncommitted work, not the remote PR branches. No source changes were made to fix that unrelated environment. Reproduce on a clean frozen-lockfile install in step 01 and report the actual clean-branch result; do not claim these task-definition commits pass implementation checks.

## Outcome

Sign Windows application executables and NSIS installers through an approved non-Azure service, failing closed for production releases.

## Dependencies

- Depends on #7: https://github.com/albertofa/cw-code/pull/7. Required before implementation acceptance/merge.

## Starting files

- `apps/desktop/electron-builder.yml`
- `scripts/sign-windows.* (new as needed)`
- `.github/workflows reusable signing job (new)`
- `docs/operations/windows-signing.md (new)`

Paths identify intended ownership, not a requirement to preserve an unsuitable existing structure. Inspect current main and prerequisite implementations before editing.

## Implementation checklist

- [ ] External prerequisite: obtain an approved non-Azure signing identity. Evaluate SignPath Foundation first for this open-source project; confirm publisher identity, unattended GitHub Actions support, build provenance rules, approvals and service limits. If unavailable, record a commercial cloud/HSM option and obtain owner approval before enrollment/purchase. Do not use Azure.
- [ ] Document selected provider, exact publisher subject, key custody, certificate renewal/rotation, recurring cost and required repository variables/secrets/permissions. Placeholder credentials or an application submitted to SignPath do not complete this task.
- [ ] Implement a provider-specific hook/job compatible with the packaging toolchain. Sign inner executables before packing and the final installer afterward; generate/recompute final blockmaps, hashes and update manifests only after the last byte-changing signing operation.
- [ ] Configure updater publisher verification for the actual certificate identity. Require trusted timestamping and verify signatures/timestamp/expected publisher using Windows tools before release artifacts are accepted.
- [ ] Use short-lived credentials where supported; otherwise narrowly scoped encrypted secrets. Restrict signing to trusted release commits/workflows and protected environments. Fork PRs, validation jobs and arbitrary workflow inputs must not gain signing access.
- [ ] Production signed mode must fail on missing credentials, provider refusal, missing signature, unexpected publisher or failed verification. Local/test unsigned mode must be explicit and produce non-production artifacts.
- [ ] Define certificate rotation so existing clients accept intended renewals; publisher-subject changes need a transition release signed by the still-trusted identity. Document outages and recovery without an unsigned production bypass.

## Acceptance criteria

- [ ] A real non-Azure signed Windows build passes publisher/timestamp verification and the updater accepts its successor.
- [ ] Missing/bad signing config cannot publish or masquerade as signed; wrong-publisher/corrupt artifacts are rejected.
- [ ] Provider setup and renewal runbook are reproducible without committing secrets; operational prerequisites are actually completed.

## Validation and evidence

- [ ] Run pnpm typecheck, pnpm test and pnpm build; validate a trusted signed test build and controlled negative fixtures.
- [ ] Record signing proof with sensitive details redacted; full signed installed-upgrade gate is consumed by step 09.

Record the exact commands, results, artifact versions/SHAs and any manual Windows evidence in the PR before marking ready. Existing planning commits contain no implementation and have not satisfied these checkboxes.

## Out of scope

No Azure, self-signed production certificates, spending without owner approval or treating unsigned fallback as production success.

## Completion procedure

Implement on this branch, incorporate merged dependencies, replace this task-definition document with maintained operational documentation where appropriate (or remove it), and rewrite the PR summary around the delivered behavior. Keep the dependency and verification evidence. Mark ready only when every required acceptance criterion is met.
