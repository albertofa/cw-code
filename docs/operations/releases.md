# Releases

`.github/workflows/release.yml` builds, signs, verifies and (only when explicitly
enabled) publishes a Windows release from one immutable commit. Nothing is uploaded
by hand. Until commissioning (step 10) finishes, every run is validation-only.

## Status

- Validation-only by default. Publishing needs both a `mode: publish` dispatch and the
  repository variable `CW_RELEASE_PUBLISHING_ENABLED=true`. The variable is not set yet.
- No SignPath enrollment yet (see [windows-signing.md](windows-signing.md)), so the
  only runs that can finish today are unsigned validation runs. They never publish.
- No release has been published by this pipeline. The legacy `v0.0.1-alpha.21`
  asset has no updater, so the N -> N+1 production-bytes test reports "bootstrap"
  and is skipped until the first pipeline release exists.
- The legacy alphas were published as non-prerelease releases, so
  `/releases/latest` currently resolves to `v0.0.1-alpha.21`, which has no
  `latest.yml`. No stable-channel client exists yet; the first stable release
  replaces it as latest.

## Flow

```
CI (push to main, success) ──workflow_run──┐
workflow_dispatch (main only) ─────────────┤
                                           v
plan (ubuntu, contents: read, tooling at the workflow commit)
  resolve mode, plan version/tag for the source SHA, upload plan.json
  │ skip (6-hour window, unchanged HEAD, source older than a published
  │ release) ends the run here
  v
verify-source (windows)
  checkout plan.sourceSha, frozen install, apply version, typecheck, test, build;
  production-bundle check with the workflow commit's tooling
  v
sign (sign-windows.yml, reusable)
  package app, SignPath app + installer (protected release-signing environment),
  rehash, verify-signatures, signing.json
  v
verify-candidate (windows)
  check-signing-manifest (bound to plan + run), stage the five-file set,
  validate-release-assets, native-load probe (install, start, node-pty, uninstall),
  N -> N+1 production-bytes upgrade, upload release set (30 days)
  v
publish (ubuntu, environment release-publish, contents: write,
         one publish job at a time across channels)
  only if mode == publish and CW_RELEASE_PUBLISHING_ENABLED == 'true'
  (re-read after the environment approval)
  draft at sourceSha, upload (feeds last), re-download and compare, re-check
  ordering, publish
  v
verify-publication (ubuntu, no token)
  runs whenever the release became public, even if publish failed afterwards;
  anonymous checks of the URLs clients use
```

`release.yml` computes its own plan with `tools/release plan` in the read-only
`plan` job. The old `release-plan.yml` did the same thing in a separate workflow and
is gone: two planners meant two answers for the same commit, and chaining workflows
through `workflow_run` would have lost the dispatch inputs. Planning rules are in
[release-versioning.md](release-versioning.md).

## Triggers

- `workflow_run` of `CI` on `main`. The `plan` job only runs when that CI run
  succeeded, was a `push`, ran on `main` and came from this repository. It always
  plans an alpha for the CI run's `head_sha`, always validates and always signs in
  `unsigned` mode, so an
  automatic run never waits for a human signing approval and never uses signing
  quota.
- `workflow_dispatch` on `main` with `channel` (alpha | stable), `candidate`,
  `expected_sha`, `force` and `mode` (validate | publish, default validate). Inputs
  reach scripts through `env:` only. An alpha dispatch with `candidate` or
  `expected_sha` fails in `plan`; those inputs only mean something for stable.

There is no pull request trigger.

Concurrency, all with `cancel-in-progress: false` so a running release is never
cancelled:

| Group | Holds |
| --- | --- |
| `release-validate-<channel>` | every `workflow_run` run and every `validate` dispatch |
| `release-publish-<channel>` | every `publish` dispatch |
| `release-publish` (job level) | the `publish` job, so an alpha and a stable publication never run at the same time |

A validation run therefore never delays a publication. GitHub keeps at most one
pending run (or pending job, for the job-level group) per group: a newer pending one
replaces an older pending one, which then shows as cancelled. Nothing was published
by a cancelled pending run; dispatch it again if it is still wanted.

## Where code runs from

The gate tooling (planner, validators, bundle gate, publisher, post-publication
checks) always runs from the workflow's own commit, `github.workflow_sha`, which for
both triggers is the tip of `main` the workflow file was read from. The plan job checks
out that commit with full history and plans for the source SHA with
`plan --sha <workflow_run.head_sha | github.sha>`, reading the desktop version from the
source commit with `git show`. Only `verify-source` checks out the source SHA, to run
its own typecheck, tests and build; the production-bundle gate on that build comes from
a second checkout of the workflow commit under `tooling/`. `sign-windows.yml` follows
the same rule with `job.workflow_sha`. A stable promotion of an older commit is
therefore always judged by the current gates.

## Validation-only and publish

| Run | Signing mode | Production | Publishes |
| --- | --- | --- | --- |
| `workflow_run` | `unsigned` | no | never |
| dispatch `validate`, `CW_WINDOWS_PUBLISHER_NAME` empty | `unsigned` | no | never |
| dispatch `validate`, `CW_WINDOWS_PUBLISHER_NAME` set | `signpath` | no | never |
| dispatch `publish` | `signpath` | yes | only with `CW_RELEASE_PUBLISHING_ENABLED=true` |

`CW_WINDOWS_PUBLISHER_NAME` is the signal for "SignPath is configured" because the
SignPath variables live in the `release-signing` environment, which the caller cannot
read. A `publish` dispatch without `CW_RELEASE_PUBLISHING_ENABLED=true` or without
`CW_WINDOWS_PUBLISHER_NAME` fails in the `plan` job, before anything is built. There
is no path where a failed signed run falls back to an unsigned one: the signing mode
is fixed in `plan`, and `publish` refuses any `signing.json` that is not
`mode: signpath, production: true`.

## Configuration (owner)

| Item | Where | Value |
| --- | --- | --- |
| `CW_RELEASE_PUBLISHING_ENABLED` | repository variable | `true` only after step 10 commissioning; unset means validation-only |
| `CW_WINDOWS_PUBLISHER_NAME` | repository variable | see [windows-signing.md](windows-signing.md) |
| `release-signing` | environment | see [windows-signing.md](windows-signing.md) |
| `release-publish` | environment | required reviewer (the owner, "prevent self-review" with a co-maintainer), deployment branches: `main` only, no admin bypass, no secrets |

`release-publish` holds no secrets. The publish job uses the run's `GITHUB_TOKEN`
with `contents: write`, granted to that job only. The protection is the reviewer
gate plus the `main` branch rule.

## The release set

Every release carries exactly these assets, validated by
`tools/release validate-release-assets` before upload and again from the uploaded
bytes:

- `cw-code-Setup-<version>-x64.exe`
- `cw-code-Setup-<version>-x64.exe.blockmap`
- `latest.yml`
- `alpha.yml`, a byte copy of `latest.yml`
- `signing.json`

electron-builder 26's GitHub publisher writes only `latest.yml`.
`stage-release-set` writes `alpha.yml` as a byte copy when it is missing, so alpha
clients never depend on electron-updater's 404 fallback. Stable releases carry it too:
alpha clients also read stable releases from the Atom feed.

`validate-release-assets --dir <set> --plan <plan.json> --run-id <id> [--signing
<signing.json>] [--unpacked-root <full set>] [--require-production]
[--expected-publisher <name>] [--report <file>]` fails on:

- a missing file, an extra file or any directory;
- an installer name other than `cw-code-Setup-<plan.version>-x64.exe`;
- `latest.yml` whose version, path, url, sha512 or size disagrees with the plan or the
  installer bytes, or an `alpha.yml` that is not byte-identical;
- a blockmap that is not an electron-builder v2 gzip blockmap covering exactly the
  installer size, or whose digest differs from `signing.json`;
- a `signing.json` that is invalid, belongs to another version, source SHA or run,
  records other installer bytes, or (with `--require-production`) is not
  `signpath` + production, or (with `--expected-publisher`) names another publisher;
- with `--unpacked-root`, any file in `signing.json` (including `win-unpacked/`) that
  no longer matches.

Channel/tag consistency comes from the plan's own shape validation (tag equals `v` +
version, channel matches the version shape).

## Publication

`tools/release publish --plan <plan.json> --dir <set> --run-id <id>
--expected-publisher <name> --work-dir <dir>` runs in the `publish` job with
`GH_TOKEN` set to that job's token:

1. Re-validates the set with `--require-production`.
2. Requires the repository to be public.
3. Looks for releases with the planned tag. More than one is an error. A published
   one is accepted only if it targets the source SHA, carries the plan marker and
   holds byte-identical assets (then the job reports `already-published` and changes
   nothing). Otherwise it fails: published bytes are never overwritten.
4. `verify-plan`: no git tag with that name; an existing draft is resumed only if it
   targets `sourceSha` and its body carries `<!-- cw-release-plan sha=<sourceSha> -->`;
   no higher or equal version published in the channel; for alpha, no newer stable
   published, `sourceSha` still reachable from `main`, and the tag commits of the
   highest published alpha and stable both ancestors of `sourceSha` (GitHub compare
   API), so a rerun of an old CI run can never publish older history; for stable, the
   candidate tag still resolves to `sourceSha`.
5. Creates the draft (`target_commitish = sourceSha`, notes plus the marker, alpha
   drafts are prereleases) or resumes the marked draft.
6. Uploads the installer, the blockmap and `signing.json`, then the feed files, with
   the channel's own feed (`alpha.yml` for alpha, `latest.yml` for stable) last. On a
   resumed draft, assets whose bytes already match are kept; any other asset is
   deleted and uploaded again, and if the payload changes the feed files are removed
   first, so the draft never holds a feed that points at bytes not uploaded yet. A
   draft asset that this set does not own stops the job.
7. Downloads every asset with `gh release download` into a scratch folder and
   compares sha512 and size with the validated set.
8. Runs step 4 again, and checks the tag still does not exist.
9. Publishes: alpha with `prerelease=true, make_latest=false`; stable with
   `prerelease=false, make_latest=true`. GitHub creates the tag at `sourceSha`.
10. Sets the job output `published=true` the moment the release is public, then
    confirms the prerelease flag and that the tag points at `sourceSha`, re-reading
    up to 5 times 2 s apart because GitHub's API can lag right after a write.

Everything up to step 9 happens on a draft, which anonymous clients cannot see, so a
failed upload or check never leaves a public incomplete release. Before any of this,
the publish step re-reads `CW_RELEASE_PUBLISHING_ENABLED` (after the environment
approval, which can come days later) and stops unless it is still `true`.

## Post-publication check

`verify-publication` runs whenever `publish` reported `published=true`, including
when `publish` failed afterwards (for example on the tag confirmation), and never when
nothing became public. It runs without any token (`check-published` refuses to start
if `GH_TOKEN` or `GITHUB_TOKEN` is set) and retries up to 6 times, 30 s apart, because
GitHub's CDN lags. It checks:

- `api.github.com/repos/albertofa/cw-code/releases/tags/<tag>`: published, prerelease
  flag, exactly the five assets;
- `github.com/albertofa/cw-code/releases/latest` (what stable clients read): the new
  tag for stable, anything else for alpha;
- `github.com/albertofa/cw-code/releases.atom` (what alpha clients read): the tag
  must be listed while the release is among the N most recent releases, where N is
  the number of entries the feed returned (the anonymous releases API gives that
  order). A release older than that window is out of the feed by design, and the
  release and channel-manifest checks cover it. The feed's window size and its
  caching are not documented by GitHub, so this check is the least certain one; a
  failure here with every other check green is most likely feed lag;
- the channel manifest a client downloads, with the planned version:
  `https://github.com/albertofa/cw-code/releases/latest/download/latest.yml` for stable,
  `https://github.com/albertofa/cw-code/releases/download/<tag>/alpha.yml` for alpha;
- the installer, downloaded in full, matches the manifest sha512 and size;
- `signing.json` is production signpath for the planned version and SHA, and the
  blockmap matches its recorded digest.

Failures show up as error annotations and in the job summary, with a link to
[Recovery](#recovery).

## Upgrade gate

`select-upgrade-base` lists published releases and picks N: the highest release
below the candidate that this pipeline produced (plan marker, installer, both feeds,
`signing.json`). An alpha candidate only takes an alpha N, because a stable client
never accepts an alpha. A stable candidate takes the highest N of either channel.

- `found` and `signpath` mode: `verify-installed-upgrade.mjs --production-bytes`
  installs N, points its `app-update.yml` at the loopback feed serving the candidate
  set, updates through the real renderer bridge and checks version, relaunch,
  signature and data (see [update-testing.md](update-testing.md#production-bytes-step-09)).
- `found` and `unsigned` mode: skipped with a warning, because N would reject an
  unsigned candidate by publisher.
- `bootstrap` (no pipeline release exists yet): skipped with a notice. The first
  published release is the bootstrap; step 10 records its evidence by hand.
- `none-compatible`: a warning in validate mode, a failure in publish mode.

## Artifacts and retention

| Artifact | Retention |
| --- | --- |
| `release-plan-attempt<n>` | 30 days |
| `cw-code-<version>-release-set-attempt<n>` (the five files) | 30 days |
| `cw-code-<version>-release-evidence-attempt<n>` (verification reports) | 30 days |
| `sign-windows.yml` intermediate artifacts | 3 days |
| `sign-windows.yml` final set (with `win-unpacked/`) | 14 days |
| CI and upgrade-test artifacts | 7 days |

Summaries record the source SHA, the gate tooling commit, node, pnpm,
electron-builder and app-builder-lib versions, the signing mode, publisher and the
installer's Authenticode status and signer, and every asset digest.

## Reruns and resume

- Artifact names carry the run attempt and are never overwritten. Jobs that passed
  keep their outputs across attempts, so a rerun reuses their artifacts by name.
- Prefer **Re-run failed jobs** for failures in `verify-candidate`, `publish` and
  `verify-publication`: they only download earlier artifacts, and the release set and
  evidence they upload get a new `attempt<n>` suffix. A rerun of `publish` resumes the
  same draft and keeps matching assets.
- Use **Re-run all jobs** when `sign` (any `sign-windows.yml` job) failed, because a
  partially failed signing job may already have uploaded an artifact under its
  attempt name, and when you want fresh signatures. Re-running everything after a
  draft exists re-signs, so the bytes change; `publish` then resumes the draft and
  replaces its assets, and nothing public changes.
- If `main` moved or a newer release appeared, start a new run instead: `publish`
  rejects a stale plan anyway.
- Once a release is published, a rerun of `publish` either confirms identical bytes
  (`already-published`) or fails. It never replaces published assets.

## Security properties

- All actions are pinned to full commit SHAs (`releaseWorkflowPolicy.test.ts`).
- Checkouts never persist credentials; there is no dependency cache.
- `contents: write` exists only in `publish`; signing secrets exist only in the
  `release-signing` jobs of `sign-windows.yml`; `release.yml` references no secrets.
- No `${{ }}` expression is interpolated into a `run:` script.
- Gate tooling runs from `github.workflow_sha` (see [Where code runs from](#where-code-runs-from)).
- `plan`, `publish` and `verify-publication` install with `--ignore-scripts`: they only
  run the release tooling, so no dependency lifecycle script runs next to a token.
- No npm, web, Azure or backend deployment is part of this workflow.
- Recommended for the owner: evaluate GitHub's immutable releases setting for the
  repository. Once a release is published its assets and tag can then no longer be
  changed, which matches the roll-forward rules below (the pipeline never edits a
  published release), and a draft stays editable, so resume keeps working.

## Distribution repository

Clients download anonymously from `albertofa/cw-code` releases, so the repository and
its releases must stay public. `publish` refuses to run against a private repository.
If the source ever has to go private, publish to a separate public distribution
repository instead: the publish job gets a credential scoped to that one repository
(a GitHub App installation token or a fine-grained token with `contents: write` on it
only, stored in the `release-publish` environment), and `electron-builder.yml`'s
`publish` block and the checks point at it. Never ship a shared personal access token,
and never embed any token in the app.

## Recovery

Step 10 completes this runbook. The one rule behind every entry: a version number is
used once. Nothing is ever re-drafted, re-tagged or re-uploaded under a number that
may have been public; problems are fixed by rolling forward to a higher version.

- **Signing, verification or upgrade gate failed**: nothing was published. Fix the
  cause and start a new run. Do not switch to `unsigned`.
- **Publish failed before step 9**: the release is still a draft. Re-run the failed
  `publish` job; it resumes the draft. If the draft holds an asset the set does not
  own, check it, delete that asset by hand, then rerun.
- **An abandoned draft for another SHA blocks the number**: `publish` refuses a draft
  it cannot resume ("cannot resume"). The tag was never created, because drafts do
  not create tags. The owner checks the draft and deletes it, then starts a new run.
  The plan job's read-only token cannot see drafts, so it may plan that number again;
  once the draft is deleted that is fine.
- **Publish failed after step 9** (wrong prerelease flag, tag at another commit): the
  release is public. `verify-publication` still runs and shows what clients see. Fix
  the prerelease/latest flags by hand if they are wrong. If the tag is wrong, do not
  move it: withdraw the release (below) and roll forward. Record what happened.
- **verify-publication failed**: open the failing URL from the summary. CDN lag clears
  within minutes; re-run the job. A wrong manifest or digest means a withdrawal and a
  roll-forward release.
- **Withdrawing a published release**: edit its notes to say it is withdrawn and
  which version supersedes it, and publish a fixed N+1 through the normal pipeline as
  soon as possible. For a stable release, make sure the previous good stable or the
  fix is marked latest. Do not turn the release back into a draft, do not delete its
  tag or assets and do not reuse its number: clients may already hold the installer
  in their updater cache and will install it on the next restart unless a higher
  version supersedes it. electron-updater still verifies sha512 and the publisher
  before installing, so this is about bad content, not tampering.
- **A leftover tag or deleted release**: the planner treats every existing
  `v<base>-alpha.*` git tag and every visible draft as a used alpha number and plans
  the next free one. A stable version whose tag exists is refused; bump the base with
  `set-base` in a normal PR.

## Local dry run

Safe on a developer machine (no install, no upload):

```sh
node tools/release/src/cli/release.ts plan --channel alpha --force --sha <origin/main SHA> --out plan.json
# build win-unpacked and the installer with electron-builder --publish never into a
# gitignored or temp folder, then in that folder's release dir:
node tools/release/src/cli/release.ts rehash --dir release-full
pwsh scripts/verify-signatures.ps1 -Root release-full -AllowUnsigned -OutFile release-full/verify-signatures.json
node tools/release/src/cli/release.ts signing-manifest --mode unsigned --production false --version <v> --source-sha <sha> --run-id <id> --package-info release-full/package-info.json --report release-full/verify-signatures.json --release-dir release-full --out release-full/signing.json
node tools/release/src/cli/release.ts stage-release-set --from release-full --to release-set --plan plan.json
node tools/release/src/cli/release.ts validate-release-assets --dir release-set --plan plan.json --run-id <id> --unpacked-root release-full
```

Never run `publish` locally; its behavior is covered by `publishRelease.test.ts`
against an in-memory GitHub fake.

Result on 2026-09-25 (unsigned local build of `0.0.1-alpha.22`, logs in
`agents-scratchpad/updater/step09/dryrun/`):

| Step | Exit |
| --- | --- |
| `plan --sha <origin/main>` (0.0.1-alpha.22; alpha.21's tag commit is an ancestor) | 0 |
| `plan --sha <v0.0.1-alpha.20 commit>` | 0, skip: alpha.21 is not an ancestor |
| `rehash`, `verify-signatures -AllowUnsigned`, `signing-manifest` unsigned | 0 |
| `check-signing-manifest` with the plan's version, SHA and run id | 0 |
| same with another run id | 1 |
| `stage-release-set` (generated `alpha.yml`, byte-identical) | 0 |
| `validate-release-assets` (validate mode) | 0 |
| same with `--require-production` | 1 (not a production signpath manifest) |
| other run id; extra file; flipped blockmap byte; edited `alpha.yml` | 1 each |
| `select-upgrade-base` against GitHub | 0, `bootstrap` |
| `verify-plan` for the origin/main plan | 0 |
| `verify-plan` for a SHA GitHub does not know | 1 |
| `check-published` with `GH_TOKEN` set | 1 (refuses) |
| `check-published` for the unpublished tag | 1 (404s) |

## Blocked on the owner

- [ ] Everything under "Blocked on the owner" in [windows-signing.md](windows-signing.md).
- [ ] Create the `release-publish` environment (reviewers, `main` only, no bypass).
- [ ] Run a dispatch `validate` with SignPath configured and record the evidence.
- [ ] Step 10: set `CW_RELEASE_PUBLISHING_ENABLED=true` and dispatch the first
      `publish`.
