# Release versioning

`tools/release` (`@cw-code/release-tools`) computes candidate versions, builds release
plans and notes, and validates stable promotion. It never creates tags, GitHub releases,
npm publications or commits by itself — it only produces a `ReleasePlan` JSON artifact
that a later, separately-gated publish step (step 09) consumes.

## Channels and versions

- Stable: `X.Y.Z`.
- Alpha: `X.Y.Z-alpha.N`.

`apps/desktop/package.json`'s `X.Y.Z` (its prerelease identifier, if any, stripped) is the
single authoritative "intended next stable base". The three package.json files
(root, `apps/desktop`, `packages/contracts`) must always carry the same version; `check-sync`
verifies this and `set-base`/`apply` keep them in sync.

The next alpha for the current base is `base-alpha.(N + 1)`, where `N` is the highest
published (non-draft) alpha number for that exact base, or `alpha.0` if no alpha has been
published for it yet. Planning an alpha is rejected outright if the base is already
published as a stable release — bump the base first with a normal PR (`set-base`).

The version applied to the three `package.json` files happens only inside the CI workspace
at build time, via `apply`, and is never committed. Because there is no version-bump commit,
there is no recursive CI trigger. The publish job (step 09) creates the git tag `v<version>`
at the exact source SHA recorded in the plan — the tag is never created here.

## Stable promotion

Stable promotion always starts from an explicit, already-tested candidate: an alpha release
tag (`vX.Y.Z-alpha.N`) or its resolved commit SHA. `plan --channel stable --candidate <tag|sha>`:

1. Resolves the candidate to a published GitHub release (by tag name, or by matching a
   40-or-fewer-hex-character SHA against the candidate alphas' resolved tag commits).
2. Rejects a resolution that: does not match any published tag/SHA; is a draft; is not an
   alpha release; belongs to a different base than the current intended stable base; or
   whose tag no longer exists in git (moved/deleted after the release was published).
3. Rejects if a stable release already supersedes the candidate's base (i.e. the "latest
   candidate" is never resolved implicitly — only an explicit candidate that is still ahead
   of the highest published stable is accepted).
4. Builds a stable plan for the candidate's base, at the candidate's exact resolved SHA.

The GitHub API's own `prerelease` flag on existing releases is not used to classify a
release's channel (the alphas published for this project are all marked non-prerelease in
GitHub); the tag/version shape is always the source of truth.

## Release notes

Notes are generated from `git log --first-parent <previousTag>..<sourceSha>` (or from the
start of history when there is no previous release in the same channel), grouped by
Conventional Commit type:

- `## Features` — `feat:` commits
- `## Fixes` — `fix:` commits
- `## Performance` — `perf:` commits
- `## Other` — everything else (including merge commit subjects)

`chore(release): ...` and `docs: ...` commits are dropped. For alpha, "previous release in
the same channel" is the highest published alpha overall. For stable, it is the highest
published stable (or none, for the first stable release).

## Automatic alpha policy

After a successful `CI` run on `main`, an alpha plan is generated automatically
(`workflow_run`). It is skipped (not failed) when:

- HEAD is unchanged from the SHA of the latest published alpha or stable release, or
- fewer than 6 hours have passed since the latest published alpha.

This coalesces bursts of merges into at most one alpha release per 6 hours, without
publishing a redundant alpha for an unchanged commit.

Stable is never triggered automatically. The default (and only) trigger for a stable plan
is an explicit `workflow_dispatch` with `channel: stable` and a `candidate` input. This
keeps promotion to stable a deliberate, human-initiated action tied to a specific tested
build, matching the "no automatic downgrade / no implicit latest" requirement.

## Concurrency and staleness

Every plan records `sourceSha`, `previousTag` and (for stable) `candidate: { tag, sha }`.
Before publication, `verify-plan --plan <file>` re-checks, against the live repository
state, that:

- the planned tag does not already exist,
- no higher version has been published in the same channel since the plan was created, and
- the source SHA is still current (HEAD, for alpha; the candidate tag's resolved commit,
  for stable).

A stale result rejects the plan instead of publishing it. Step 09 must run `verify-plan`
immediately before creating any tag/release.

## CLI

All commands live in `tools/release/src/cli/release.ts`, run directly with Node's native
TypeScript support (`node tools/release/src/cli/release.ts <command> ...`, no build step).
They print machine-readable JSON to stdout and, when `$GITHUB_OUTPUT` is set, also append
`channel`, `version`, `tag`, `sha`, `skip`, `reason` (as applicable) as workflow outputs.

- `plan --channel alpha|stable [--candidate <tag|sha>] [--sha <sha>] [--now <iso>] --out <file>`
  Writes the `ReleasePlan` (or `{ skip: true, reason }` for a throttled alpha) to `<file>`.
- `verify-plan --plan <file>` — re-validates a previously written plan against the current
  repository state; exits non-zero when stale.
- `apply --version <version>` — writes `version` into the three `package.json` files
  (workspace-only, never committed).
- `set-base --version X.Y.Z` — writes a new stable base into the three `package.json` files
  (this is the normal-PR path referenced above).
- `check-sync` — verifies the three `package.json` files agree on a single version.

`pnpm release:plan` is a root convenience alias for `plan`.

## Workflow

`.github/workflows/release-plan.yml` runs on `workflow_run` (workflow `CI`, branch `main`,
on completion) for automatic alpha planning, and on `workflow_dispatch` (`channel`,
`candidate` inputs) for manual alpha or stable planning. It has `permissions: contents: read`
only — it cannot create tags, releases or commits. It checks out the exact commit that
triggered it (or `github.sha` for manual dispatch) with full history and tags, runs `plan`,
uploads `plan.json` as a 14-day artifact, and writes a job summary. The
`release-plan-<channel>` concurrency group serializes plans per channel without cancelling
an in-progress run.
