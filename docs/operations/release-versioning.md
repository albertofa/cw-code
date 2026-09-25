# Release versioning

`tools/release` (`@cw-code/release-tools`) computes candidate versions, builds release
plans and notes, and validates stable promotion. It never creates tags, GitHub releases,
npm publications or commits by itself — it only produces a `ReleasePlan` JSON artifact
that a later, separately-gated publish job in `release.yml` consumes.

## Channels and versions

- Stable: `X.Y.Z`.
- Alpha: `X.Y.Z-alpha.N`.

`apps/desktop/package.json`'s `X.Y.Z` (its prerelease identifier, if any, stripped) is the
single authoritative "intended next stable base". The three package.json files
(root, `apps/desktop`, `packages/contracts`) must always carry the same version; `check-sync`
verifies this and `set-base`/`apply` keep them in sync.

The next alpha for the current base is `base-alpha.(N + 1)`, where `N` is the highest
published (non-draft) alpha number for that exact base, or `alpha.0` if no alpha has been
published for it yet. Planning an alpha is rejected outright if:

- the base is already published as a stable release, or
- the base is *behind* the base of the highest published alpha (the desktop version must
  never move backwards, even transiently).

Either case is a hard error, not a skip — bump the base first with a normal PR (`set-base`).

The version applied to the three `package.json` files happens only inside the CI workspace
at build time, via `apply`, and is never committed. Because there is no version-bump commit,
there is no recursive CI trigger. The publish job of `release.yml` creates the git tag `v<version>`
at the exact source SHA recorded in the plan — the tag is never created here.

## Stable promotion

Stable promotion always starts from an explicit, already-tested candidate: an alpha release
tag (`vX.Y.Z-alpha.N`) or its resolved commit SHA. `plan --channel stable --candidate <tag|sha>
[--expected-sha <sha>]`:

1. Resolves the candidate to a published GitHub release. A candidate given as a SHA must be a
   full 40-character hex string (case-insensitive, normalized to lowercase); shorter/prefix
   SHAs are rejected outright, never treated as a fuzzy match. If more than one published
   alpha for the current base resolves to the same SHA (e.g. a tag was recreated on top of
   another), the SHA form is rejected as ambiguous — pass the tag explicitly instead.
2. Rejects a resolution that: does not match any published tag/SHA; is a draft; is not an
   alpha release; belongs to a different base than the current intended stable base; whose
   tag no longer exists in git (moved/deleted after the release was published); or, when
   `--expected-sha` is given, whose resolved commit does not equal it (this lets a human pin
   the exact tested commit even when promoting by tag name, so a moved/re-pushed tag can never
   silently substitute a different commit).
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
publishing a redundant alpha for an unchanged commit. Note: releases published before this
tooling existed have tags pointing at the old per-release-branch merge commit rather than a
`main` SHA, so the "unchanged HEAD" comparison against those historical tags will never match
`main`'s HEAD; the skip only becomes fully effective once every published tag's resolved
commit is itself a `main` SHA (i.e. after the first alpha built by this tooling).

Manual alpha planning (`workflow_dispatch` with `channel: alpha`) goes through the exact same
throttle — it is not a bypass path. To force an alpha out sooner (e.g. to test the pipeline,
or ship an urgent fix ahead of the 6-hour window), dispatch with `force: true`. `force` only
lifts the 6-hour window; it never lifts the unchanged-HEAD skip or any of the ordering/base
rejections in the section above — there is no way to force a plan onto a commit that already
has a release, or backwards past a published version.

Stable is never triggered automatically. The default (and only) trigger for a stable plan
is an explicit `workflow_dispatch` with `channel: stable` and a `candidate` input (optionally
`expected_sha`). This keeps promotion to stable a deliberate, human-initiated action tied to
a specific tested build, matching the "no automatic downgrade / no implicit latest"
requirement.

## Plan validation and staleness

A `ReleasePlan` is never trusted at face value. `verifyPlan` (used by both `verify-plan` and,
internally, before any of its own staleness checks) first validates the plan's own shape and
internal consistency — before touching git or GitHub at all:

- `schema` is `1`;
- `tag` equals `"v" + version`;
- `channel` matches the shape of `version` (`X.Y.Z` ⇒ stable, `X.Y.Z-alpha.N` ⇒ alpha);
- `sourceSha` is a full 40-character hex SHA;
- for a stable plan, `candidate` is present, its tag is a valid alpha tag on the same base as
  `version`, and its `sha` is a full 40-character hex SHA;
- `prerelease`/`makeLatest` match the channel (`true`/`false` for alpha, `false`/`true` for
  stable).

A structurally invalid plan is rejected immediately, with no network or git calls. The CLI
never blindly casts the parsed JSON — `JSON.parse` result is passed through as `unknown` and
only becomes a typed `ReleasePlan` after passing this validator.

Once the shape is confirmed, `verify-plan --plan <file>` re-checks, against the live
repository/GitHub state, that:

- the planned tag is not already a git tag;
- the planned tag is not reserved by a GitHub release, drafts included, with one
  exception: a single **draft** whose `target_commitish` equals `sourceSha` and whose body
  carries `<!-- cw-release-plan sha=<sourceSha> -->` is returned as `resumeDraft` so a rerun
  continues it. Any other release with that tag (published, unmarked, another SHA, or more
  than one) rejects the plan;
- no higher-or-equal version has been published in the same channel since the plan was
  created, and, for alpha, no stable newer than the alpha has been published (the alpha
  would land after it in the Atom feed and stay hidden from alpha clients); and
- the source SHA is still acceptable: for alpha, `sourceSha` must be reachable from `main`
  on GitHub (`gh api repos/<owner>/<repo>/compare/<sha>...main` is `identical` or `ahead`,
  exposed as `ReleaseSource.isAncestorOfMain()`). `main` moving on after the plan is fine;
  a force-push or a side-branch SHA is not. For stable, the candidate tag's resolved commit
  must still equal the recorded `sourceSha`.

A stale result rejects the plan instead of publishing it. `release.yml`'s publish step runs
the same checks before creating the draft and again right before publishing
([releases.md](releases.md#publication)).

## CLI

All commands live in `tools/release/src/cli/release.ts`, run directly with Node's native
TypeScript support (`node tools/release/src/cli/release.ts <command> ...`, no build step).
They print machine-readable JSON to stdout and, when `$GITHUB_OUTPUT` is set, also append
`channel`, `version`, `tag`, `sha`, `skip`, `reason` (as applicable) as workflow outputs using
the heredoc delimiter format, so values are never corrupted or split by embedded newlines.

- `plan --channel alpha|stable [--candidate <tag|sha>] [--expected-sha <sha>] [--sha <sha>]
  [--force] [--now <iso>] --out <file>`
  Writes the `ReleasePlan` (or `{ skip: true, reason }` for a throttled alpha) to `<file>`.
  `--sha`/`--expected-sha` must be a full 40-character hex SHA, validated before any git call.
  When `--sha` is given, the desktop version is read from that exact commit
  (`git show <sha>:apps/desktop/package.json`), never from the working tree, so a plan for a
  historical or out-of-band commit cannot pick up an unrelated local edit. `--force` only
  applies to `--channel alpha` (see "Automatic alpha policy" above).
- `verify-plan --plan <file>` — re-validates a previously written plan against the current
  repository state; exits non-zero when invalid or stale, and sets the `resume` output when
  a marked draft can be resumed.
- `apply --plan <file>` (preferred) applies a plan's version after re-validating its shape;
  `apply --version <version>` remains for local/manual use but is rejected unless `<version>`
  is on the current desktop base (use `set-base` to change the base, or pass `--plan`).
  Applies to the workspace only, never committed.
- `set-base --version X.Y.Z` — writes a new stable base into the three `package.json` files
  (this is the normal-PR path referenced above).
- `check-sync` — verifies the three `package.json` files agree on a single version.
- `rehash`, `signing-manifest`, `check-signing-manifest` — Windows signing post-processing
  and the `signing.json` gate; documented in [windows-signing.md](windows-signing.md).
- `stage-release-set`, `validate-release-assets`, `select-upgrade-base`, `publish`,
  `check-published` — the release set, publication and post-publication checks;
  documented in [releases.md](releases.md).

`pnpm release:plan` is a root convenience alias for `plan`. `gh api` calls use whatever auth `gh` has
(a read-only `GH_TOKEN` in CI, or `gh auth login` locally); any `gh api` failure is reported with
its original message and a hint to check network access and auth, and releases are fetched with `per_page=100` plus a `--jq`
projection limited to the fields the tool actually reads.

## Workflow

Planning is the first job (`plan`) of `.github/workflows/release.yml`
([releases.md](releases.md)); there is no separate planning workflow. It runs on
`workflow_run` (workflow `CI`, on completion) for automatic alpha planning, and on
`workflow_dispatch` (`channel`, `candidate`, `expected_sha`, `force`, `mode` inputs) for
manual alpha or stable runs. The job has `permissions: contents: read` only — it cannot
create tags, releases or commits — and checks out with `persist-credentials: false` so the
ephemeral token is never written to disk.

The job only runs when:

- it was dispatched manually **on `main`** (`github.ref == 'refs/heads/main'`), or
- the triggering `CI` run concluded successfully, was itself triggered by a `push`, ran on
  `head_branch == 'main'`, and its `head_repository` is this repository (not a fork).

This guards against a fork opening a PR from a branch also named `main`: without the
`event == 'push'` and `head_repository.full_name == github.repository` checks, `workflow_run`
would still match on `head_branch`, and the fork's `head_sha` would be checked out and
executed with this repository's (read-only, but still real) token and cache scope. All four
conditions must hold together.

No workflow step ever interpolates `${{ github.event.inputs.* }}` or a previous step's
`${{ steps.*.outputs.* }}` directly inside a `run:` shell block — those values are passed
through `env:` and referenced as quoted shell variables, so a crafted input (e.g. a candidate
string containing shell metacharacters) cannot break out of its argument position.

The job checks out the exact commit that triggered it (or `main`'s current head for manual
dispatch) with full history and tags, runs `plan`, uploads `plan.json` as a 30-day artifact,
and writes a job summary. The workflow's `release-<channel>` concurrency group serializes
runs per channel without cancelling an in-progress run.
