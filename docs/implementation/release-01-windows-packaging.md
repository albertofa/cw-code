# [Release 01/10] Define Windows installer identity and reproducible packaging

## Status and implementation rules

This is a task-definition draft, not an implemented feature. The initial commit adds only this specification. Develop the implementation on this branch; do not merge a specification-only PR as completion. All PRs initially target main independently. Dependencies mean their implementations must be merged (or deliberately stacked/rebased for development) before this PR can pass its final acceptance gates. Rebase onto main after dependencies merge; do not mark a prerequisite complete merely because its planning document exists.

Shared decisions: Windows x64 first; GitHub Actions + public GitHub Releases + electron-updater + NSIS; no Azure; non-Azure production signing required. Background downloads default on after settings integration; install/restart requires user action. Stable and alpha only; no automatic downgrade. No renderer filesystem/process access, no AI SDK inference, no CLI-owned transcript mutation. Preserve user projects, worktrees, identities and subscription-based CLI execution. Follow CliDriver for provider lifecycle changes. Synchronize contracts, main IPC, preload, renderer types and store. Use no new dependency requiring C++ compilation.

Each implementation must pass pnpm typecheck, pnpm test and pnpm build, plus task-specific verification. Test stable contracts and behavior; verify UI/wiring with typecheck/build and integrated manual checks rather than component snapshots. Run installed upgrade tests in disposable Windows environments, never against the developer's live installation. External service enrollment/purchases require the owner's action/approval and are not implied by a planning draft.

Planning-time local baseline (2026-09-14): 549 tests passed across 44 files. Typecheck could not resolve node-pty; production renderer build could not resolve @fontsource-variable/inter. These checks used the existing local workspace with pre-existing uncommitted work, not the remote PR branches. No source changes were made to fix that unrelated environment. Reproduce on a clean frozen-lockfile install in step 01 and report the actual clean-branch result; do not claim these task-definition commits pass implementation checks.

## Outcome

Produce a repeatable Windows x64 NSIS installer that upgrades the existing installation in place and preserves app-owned data.

## Dependencies

- No prior implementation PR is required; this work can start immediately.

## Starting files

- `apps/desktop/electron-builder.yml`
- `apps/desktop/package.json`
- `package.json`
- `pnpm-lock.yaml`
- `.github/workflows/ci.yml`
- `scripts/verify-windows-package.* (new)`

Paths identify intended ownership, not a requirement to preserve an unsuitable existing structure. Inspect current main and prerequisite implementations before editing.

## Implementation checklist

- [ ] Audit an existing released installer and a read-only snapshot of its installed metadata: appId, executable/product name, NSIS upgrade GUID/registry keys, per-user/per-machine scope, custom install path, shortcuts and resolved userData. Record evidence, not assumptions; never mutate the live installation to perform this audit.
- [ ] Preserve com.cwcode.app and the established installer/data identity. Use per-user scope for new installs only if compatible with existing behavior; document and test the separate legacy per-machine/UAC path. Do not invent a new GUID or move userData.
- [ ] Pin a compatible Electron/electron-builder toolchain after reviewing changes from the current versions. Explicitly target Windows x64 NSIS for distribution; retain unpacked output only for diagnostics. Preserve custom installation directories and enable differential packaging.
- [ ] Use stable version/architecture artifact names. Keep JavaScript in ASAR and unpack only required native binaries/helpers. With npmRebuild:false, establish a reproducible compatible node-pty prebuilt-binary path; do not make C++ compilation a prerequisite.
- [ ] Add Windows CI alongside current Linux checks, using pinned Node/pnpm, frozen lockfile, typecheck, full tests and production build. Add a non-publishing installer build and packaged startup/native-load probe without authenticated provider CLIs.
- [ ] Package in a disposable directory with explicit --publish never. Record artifact size, install duration and native-load results. Keep release credentials unavailable to pull_request jobs.

## Acceptance criteria

- [ ] Existing identity is documented from an actual installer/install; clean and existing/custom-path installs are verified in disposable Windows environments.
- [ ] Packaged app opens with missing CLIs gracefully; node-pty works on the supported release target, or release packaging fails with a clear diagnostic.
- [ ] No publishing occurs in CI; new installer replaces the existing app without deleting metadata or worktrees.

## Validation and evidence

- [ ] Run pnpm typecheck, pnpm test, pnpm build and the new Windows package verifier.
- [ ] Record clean install and existing installer -> new installer smoke evidence; no untrusted PR code receives signing credentials.

Record the exact commands, results, artifact versions/SHAs and any manual Windows evidence in the PR before marking ready. Existing planning commits contain no implementation and have not satisfied these checkboxes.

## Out of scope

No updater UI, signing provider enrollment, release publication or additional operating systems.

## Completion procedure

Implement on this branch, incorporate merged dependencies, replace this task-definition document with maintained operational documentation where appropriate (or remove it), and rewrite the PR summary around the delivered behavior. Keep the dependency and verification evidence. Mark ready only when every required acceptance criterion is met.
