# Updater rollout and release operations

This is the operator's guide for turning on in-app updates and running releases
afterwards: the one-time commissioning sequence, how candidates are chosen and
promoted, how to pause, what to do about a bad release, what the feed monitor
reports, retention and budgets, and the support cases that still need a human.

Every production action in this document is the owner's. Nothing here runs by
itself. The pipeline details live in [releases.md](releases.md), signing in
[windows-signing.md](windows-signing.md), installed upgrade tests in
[update-testing.md](update-testing.md) and the client in [updater.md](updater.md).

## Where things stand

- Legacy releases `v0.0.1-alpha.18` to `v0.0.1-alpha.21` were uploaded by hand:
  not marked prerelease, asset `cw-code.Setup.<version>.exe`, no `latest.yml`,
  unsigned, no updater. `/releases/latest` resolves to `v0.0.1-alpha.21`.
- Nobody can update in-app yet. Users of those builds need one manual install of
  the first updater-enabled release (the bootstrap). The installer keeps the
  install identity: per-user HKCU key under GUID
  `d6e18d04-bf35-5bfe-9145-b95301660833`, a custom install folder, per-machine
  scope, and `~/.cw-code` untouched (see
  [windows-packaging.md](windows-packaging.md#installer-identity)).
- SignPath Foundation enrollment is not done, so every run so far is unsigned
  validation. `CW_RELEASE_PUBLISHING_ENABLED` is not set.

## Commissioning checklist

Work through the steps in order. Each one names the exact inputs and what to
record. Fill the `Record` lines in a PR that updates this file; attach the
redacted logs to that PR. Never paste a token, a SignPath secret or real user
data.

### A. Owner prerequisites

- [ ] Every item under "Blocked on the owner" in
      [windows-signing.md](windows-signing.md#blocked-on-the-owner): SignPath
      Foundation application and terms, confirmation that building an ancestor
      `source-sha` satisfies origin verification, code signing policy page, MFA,
      SignPath GitHub App, the two artifact configurations, the release-signing
      policy with manual approval and RFC 3161 timestamps, a submit-only CI user
      token.
- [ ] Repository variable `CW_WINDOWS_PUBLISHER_NAME`, recommended value
      `SignPath Foundation` (the CN only; the trade-off is in
      windows-signing.md).
- [ ] Environment `release-signing`: required reviewers, deployment branches
      `main` only, no admin bypass, secret `SIGNPATH_API_TOKEN`, variables
      `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`,
      `SIGNPATH_SIGNING_POLICY_SLUG`, `SIGNPATH_APP_ARTIFACT_CONFIGURATION`,
      `SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION`.
- [ ] Environment `release-publish`: required reviewer (the owner, "Prevent
      self-review" once there is a co-maintainer), deployment branches `main`
      only, no admin bypass, no secrets.
- [ ] Branch protection or a ruleset on `main` (required review, no direct or
      force push, no deletion, no bypass) and `CODEOWNERS` for
      `.github/workflows/`, `.signpath/`, `scripts/` and `tools/release/` with
      "Require review from Code Owners".
- [ ] Decide on GitHub's immutable releases setting (recommended in
      [releases.md](releases.md#security-properties)).
- [ ] `CW_RELEASE_PUBLISHING_ENABLED` still unset.
- [ ] Recovery contacts filled in (see [Contacts](#contacts)).
- [ ] After this branch is on `main`, the `Check update feed` workflow shows up
      under Actions. Dispatch it once and confirm the summary line reads
      `Update feed ok: stable: no pipeline-built release yet; alpha: no pipeline-built release yet`.

Record: date, who configured what, links to the settings pages (screenshots
without secret values): `<fill>`

### B. First signed validation run

Nothing is published in validate mode, and its `signing.json` says
`production: false`, so `publish` would refuse these bytes anyway.

1. Check the commit you want to ship is `main`'s head and CI passed on it:
   `git ls-remote https://github.com/albertofa/cw-code refs/heads/main`.
2. Dispatch Actions > Release > Run workflow on branch `main` with
   channel `alpha`, candidate empty, expected_sha empty, force unchecked,
   mode `validate`. From a shell:

   ```sh
   gh workflow run release.yml --repo albertofa/cw-code --ref main -f channel=alpha -f mode=validate -f force=false
   ```

   If the plan job skips with the 6-hour window, dispatch again with
   `-f force=true`. `force` lifts only that window.
3. The plan summary must show `signing: signpath; production: false`. If it
   shows `unsigned`, `CW_WINDOWS_PUBLISHER_NAME` is not set.
4. Approve the two `release-signing` deployments (`sign-app`, `sign-installer`)
   and the two SignPath signing requests.
5. `verify-candidate` passes, and its upgrade gate logs the notice
   `N -> N+1 skipped: no release published by this pipeline exists yet`.
6. Run the negative fixtures from
   [windows-signing.md](windows-signing.md#negative-fixtures-once-a-real-certificate-exists)
   against the downloaded set.

Record:

| Item | Value |
| --- | --- |
| Run URL and run id | `<fill>` |
| Planned version and tag | `<fill>` |
| Source SHA (built) / workflow SHA (gate tooling) | `<fill>` / `<fill>` |
| Signer subject and timestamp flag (`verify-signatures.json`) | `<fill>` |
| Thumbprint, timestamp authority, certificate NotAfter (`Get-AuthenticodeSignature` on the downloaded installer: `SignerCertificate.Thumbprint`, `TimeStamperCertificate.Subject`, `SignerCertificate.NotAfter`) | `<fill>` |
| Installer name, size, sha512 (`latest.yml`) | `<fill>` |
| Native-load probe (`verify-windows-package.json`: rendererLoaded, nodePty.spawned) | `<fill>` |
| Release set artifact `cw-code-<version>-windows-signpath-attempt<n>-release` | `<fill>` |
| Negative fixtures (wrong publisher, flipped byte, stripped signature) | `<fill>` |

### C. Bootstrap candidate over the real legacy installer (disposable VM)

Use a fresh Windows 11 x64 VM snapshot with no cw-code on it, Node 24, pnpm
11.5.3, git and `gh`. Never do this on a machine where you use cw-code: the
script installs, seeds the real `%USERPROFILE%\.cw-code` and uninstalls.

Prepare once, then take a snapshot:

```powershell
git clone https://github.com/albertofa/cw-code; cd cw-code
git checkout <source SHA from B>
pnpm install --frozen-lockfile
gh run download <run id from B> --repo albertofa/cw-code --name cw-code-<version>-windows-signpath-attempt<n>-release --dir candidate
gh release download v0.0.1-alpha.21 --repo albertofa/cw-code --pattern "cw-code.Setup.0.0.1-alpha.21.exe" --dir legacy
```

The signed final artifact is kept for 14 days, so finish this step within two
weeks of B or rerun B.

Scripted runs, one per fresh snapshot:

```powershell
node scripts/verify-windows-package.mjs --dist candidate --upgrade-from legacy/cw-code.Setup.0.0.1-alpha.21.exe --disposable-environment
node scripts/verify-windows-package.mjs --dist candidate --upgrade-from legacy/cw-code.Setup.0.0.1-alpha.21.exe --custom-dir C:\cw-code-custom --disposable-environment
# from an elevated prompt:
node scripts/verify-windows-package.mjs --dist candidate --upgrade-from legacy/cw-code.Setup.0.0.1-alpha.21.exe --per-machine --disposable-environment
```

Each run installs the legacy build, seeds cw-code data, installs the candidate
over it, then checks `InstallLocation` unchanged, `DisplayVersion` and
`Publisher` updated, the seeded files byte-identical and a startup probe on
the upgraded app, and uninstalls. The report lands in
`candidate/verify-windows-package.json`; copy it out before the next run.

Then one interactive run on a fresh snapshot, the way a user will do it:

1. Double-click the legacy installer, choose "Only for me", default folder.
2. Start cw-code, add a throwaway project, run one short turn with each CLI
   you have (your own subscription), close it.
3. Double-click `candidate/cw-code-Setup-<version>-x64.exe`. Note whether
   SmartScreen appears and what publisher it shows. The wizard must upgrade
   in place.
4. Start cw-code: the project and sessions are there, a session resumes with
   its CLI context, Settings > Updates shows the new version and channel
   Alpha. A check reports an error at this point because no pipeline release
   is published yet; that is expected only for this unpublished candidate.

Record:

| Case | Result, `DisplayVersion` before/after, `InstallLocation` |
| --- | --- |
| Per-user default folder (scripted) | `<fill>` |
| Per-user custom folder (scripted) | `<fill>` |
| Per-machine (scripted, elevated) | `<fill>` |
| Interactive legacy -> candidate, SmartScreen, CLI resume | `<fill>` |

### D. Enable production and publish the bootstrap alpha

1. B and C are complete for the same source SHA, and `main` still points at
   it. An alpha always builds `main`'s head at dispatch time; if `main` moved,
   repeat B and C for the new head or hold merges until D is done.
2. Turn production on:

   ```sh
   gh variable set CW_RELEASE_PUBLISHING_ENABLED --repo albertofa/cw-code --body true
   ```

3. Dispatch:

   ```sh
   gh workflow run release.yml --repo albertofa/cw-code --ref main -f channel=alpha -f mode=publish -f force=false
   ```

4. Approve `release-signing` twice and SignPath twice. Before approving
   `release-publish`, read the plan summary (version, tag, source SHA equal to
   B) and the `verify-candidate` summary.
5. `publish` and `verify-publication` pass. Then dispatch Actions > Check
   update feed. Expected summary:
   `Update feed ok: stable: no pipeline-built release yet; alpha v<version> (<sha>) ok`.
6. Edit the release notes to add the bootstrap note from
   [Communication templates](#communication-templates), and update README.md's
   "Updating cw-code" section so it no longer says the release is coming.
7. In a fresh VM, download the published installer from the release page and
   repeat the interactive part of C once with those exact bytes.
8. Leave production on only if E follows soon; otherwise turn it off (G).

Record:

| Item | Value |
| --- | --- |
| Release URL, tag, version | `<fill>` |
| Source SHA, run id | `<fill>` |
| Published installer size and sha512 (`alpha.yml`) | `<fill>` |
| `verify-publication` result | `<fill>` |
| Feed monitor summary line | `<fill>` |
| Interactive legacy -> published bootstrap | `<fill>` |

### E. A second real alpha, installed in-app by the bootstrap build

This is the first real updater run. The browser and the manual installer are
not used at all.

1. Merge at least one change to `main` after the bootstrap (an unchanged head
   is skipped by the planner) and let CI pass.
2. Prepare a disposable VM with the bootstrap installed. The best base is the
   snapshot from D.7, which went legacy -> bootstrap. Create a project and a
   few sessions with real CLIs, open a terminal tab, leave one file edited but
   unsaved. Record the "before" state:

   ```powershell
   $db = Get-Content "$HOME\.cw-code\userdata\cw-code.db.json" -Raw | ConvertFrom-Json
   $db.schemaVersion; $db.projects.Count; $db.sessions.Count; $db.sessions.id
   Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\d6e18d04-bf35-5bfe-9145-b95301660833 | Select-Object DisplayVersion, Publisher
   Get-ItemProperty HKCU:\Software\d6e18d04-bf35-5bfe-9145-b95301660833 | Select-Object InstallLocation
   ```

3. With production on, dispatch (use `force=true` if the bootstrap is less
   than 6 hours old):

   ```sh
   gh workflow run release.yml --repo albertofa/cw-code --ref main -f channel=alpha -f mode=publish -f force=true
   ```

   This time `select-upgrade-base` finds the bootstrap as N, and
   `verify-candidate` runs the production-bytes N -> N+1 upgrade on the
   signed candidate before anything is published. Approve as in D.
4. In the VM, wait for the background check (45 s after start, then every
   6 h) or click Check for updates in Settings > Updates. The update downloads
   in the background, the sidebar shows "cw-code X is ready".
5. Click Update and restart. The dialog lists the open terminal and the
   unsaved file. Save, continue. cw-code closes, no installer window appears,
   and it reopens on the new version.
6. Run the "before" commands again, check that the sessions resume with their
   CLI context, and keep `~/.cw-code/logs/updater.log` (it is redacted).
7. Check the installed binary:

   ```powershell
   Get-AuthenticodeSignature "$env:LOCALAPPDATA\Programs\cw-code\cw-code.exe" | Select-Object Status, @{n="Signer";e={$_.SignerCertificate.Subject}}, @{n="NotAfter";e={$_.SignerCertificate.NotAfter}}
   ```

Record:

| Item | Value |
| --- | --- |
| From version / SHA -> to version / SHA | `<fill>` |
| Run id, production-bytes gate result in `verify-candidate` | `<fill>` |
| Download size and whether it was differential (`updater.log`) | `<fill>` |
| Close-to-reopen time | `<fill>` |
| `DisplayVersion`, `InstallLocation`, hive before/after | `<fill>` |
| Projects/sessions count and ids before/after, `schemaVersion` | `<fill>` |
| CLI resume per CLI | `<fill>` |
| Browser or manual installer used | no (`<confirm>`) |

### F. Promote the verified alpha to stable

1. Pick the candidate (rules in [Choosing candidates](#choosing-candidates)),
   normally the alpha from E.
2. Resolve its commit three ways and check they agree:

   ```sh
   git ls-remote https://github.com/albertofa/cw-code refs/tags/v<X.Y.Z-alpha.N>
   gh release view v<X.Y.Z-alpha.N> --repo albertofa/cw-code --json body --jq .body | grep cw-release-plan
   gh release download v<X.Y.Z-alpha.N> --repo albertofa/cw-code --pattern signing.json --output - | jq -r .sourceSha
   ```

3. Dispatch with production on:

   ```sh
   gh workflow run release.yml --repo albertofa/cw-code --ref main -f channel=stable -f candidate=v<X.Y.Z-alpha.N> -f expected_sha=<40-hex SHA> -f mode=publish
   ```

   Leave force off; the planner rejects it for stable.
4. The stable upgrade gate installs the highest pipeline release below the
   candidate and updates it with the new bytes. Approve as in D.
5. After publication, `/releases/latest` resolves to `vX.Y.Z`, and the feed
   monitor reports `stable vX.Y.Z (<sha>) ok; alpha vX.Y.Z (<sha>) ok`. Alpha
   clients take the stable too, because it is newer than their alpha.
6. The base `X.Y.Z` is now used up. Before the next alpha, open a normal PR
   with `node tools/release/src/cli/release.ts set-base --version X.Y.(Z+1)`.
   Until it merges, alpha plans fail with "base already published as stable".

Record: candidate tag and SHA, stable tag, run id, `/releases/latest` result,
monitor summary: `<fill>`

### G. Turn production off, or pause

- Stop any further publication:

  ```sh
  gh variable set CW_RELEASE_PUBLISHING_ENABLED --repo albertofa/cw-code --body false
  ```

  A `publish` dispatch then fails in `plan` before building, and a publish
  job that was already waiting for approval re-reads the variable and stops.
- Reject any pending `release-publish` deployment (the run page > Review
  deployments > Reject).
- To stop validation runs too: `gh workflow disable release.yml` (resume with
  `gh workflow enable release.yml`).
- Pausing does not change anything clients see. Published releases stay
  published and clients keep checking every 6 hours.

Steady state is the owner's call. Two reasonable options: keep the variable
`true` and rely on the manual dispatch plus the `release-publish` approval as
the gate, or keep it `false` and switch it on for each release. Either way the
variable is the kill switch.

Record: final state of the variable and the date: `<fill>`

## Choosing candidates

- **Alpha.** An alpha is always `main`'s head at the time of the dispatch (or
  of the CI run, for automatic validation). Publish only when CI passed on
  that commit, nothing known to be broken is open, and a validation run for
  it passed. Automatic runs never publish.
- **Stable.** Only an alpha that was published, installed in-app by at least
  one person (the E evidence, or the same checks on a later alpha), and left
  alone for a soak period the owner sets: `<owner to set, for example 3 days>`.
  Promote the highest alpha of the base. Promoting an older alpha while a
  newer one exists would give alpha users an older build under a higher
  version number.
- Always pin `expected_sha`. It stops a moved tag from swapping in another
  commit.
- Never reuse a version. A withdrawn number stays withdrawn; the planner skips
  used alpha numbers and refuses a stable whose tag exists.

## Bad-release response

Use this when a published release is bad: it crashes at start, loses or
damages data, breaks a CLI, or has a security problem. Pipeline failures
where nothing was published are in [releases.md](releases.md#recovery).

What cannot be undone:

- Clients that already downloaded the installer keep it in
  `%LOCALAPPDATA%\@cw-codedesktop-updater\pending` and can install it with the
  next Update and restart. A ready download survives later checks that report
  an older version.
- Clients that already installed it run it until a higher version arrives.
- There is no remote revocation, no kill switch in the app, and no automatic
  NSIS rollback. Installers already downloaded from the release page stay
  installable.
- electron-updater still checks sha512 and the publisher, so a tampered file
  is rejected. This runbook is about bad content, not tampering.

Steps:

1. Stop publication (section G): variable `false`, reject pending
   `release-publish` reviews.
2. Stop offering the bad release where that is possible:
   - Stable: on the release page of the previous good stable, choose "Set as
     the latest release". `/releases/latest` then points at it, stable clients
     that have not downloaded the bad one see nothing new, and the feed
     monitor reports the `latest-release` check as failed until the fix ships.
     That failure is expected during the incident.
   - Alpha: alpha clients follow the Atom feed in creation order, and hiding a
     release there means deleting or re-drafting it, which we do not do. Roll
     forward instead.
3. Edit the bad release's notes with the withdrawal template below. Do not
   delete its tag or assets, do not turn it back into a draft, do not reuse
   its number.
4. Fix on `main` and roll forward with a higher version:
   - Bad alpha: publish the next alpha (`force=true` lifts the 6-hour window).
   - Bad stable `X.Y.Z`: merge `set-base --version X.Y.(Z+1)`, publish
     `X.Y.(Z+1)-alpha.1`, check it (E-style, at least on one VM), promote it
     to stable `X.Y.(Z+1)`. The fixed stable replaces the manual "latest"
     choice from step 2.
5. Help users who cannot start cw-code at all: the fixed installer from the
   release page installs over the broken one in place and keeps
   `~/.cw-code`. Recommend a manual install of an older version only after
   testing that exact pair in a VM. An older build may show the recovery
   screen for metadata written by the newer one.
6. Metadata damage: the recovery screen offers the `.last-good.bak` and
   migration backups (see [metadata-migrations.md](metadata-migrations.md)).
   Restoring keeps the current file as `.broken-<timestamp>`.
7. Communicate (template below) on the release page and wherever the project
   announces releases: `<owner to fill>`.
8. Write down what happened in the incident log (below) and turn production
   back on only for the fix.

## Communication templates

Bootstrap note for the first updater-enabled release:

> This is the first cw-code release that can update itself. If you run
> v0.0.1-alpha.21 or older, download `cw-code-Setup-<version>-x64.exe` below
> and run it once. It upgrades your existing install in place: same folder,
> same scope, and your projects, sessions and settings in `~/.cw-code` stay
> as they are. After that, updates come through Settings > Updates.

Withdrawal note on a bad release:

> **Withdrawn.** <One sentence on what goes wrong and who is affected.> Do not
> install this version. <Fixed version> replaces it; cw-code offers it
> automatically. If cw-code already downloaded <bad version>, it will show
> <fixed version> as soon as it is published; wait for it before choosing
> Update and restart. If cw-code no longer starts, install <fixed version>
> from its release page. Your data in `~/.cw-code` is not deleted.

## Drills

Rehearse bad-release handling without touching production. Record each drill
in the table below.

1. **Kill switch.** With `CW_RELEASE_PUBLISHING_ENABLED` unset or `false`,
   dispatch `mode=publish`. Expected: the `plan` job fails with
   "mode=publish needs the repository variable CW_RELEASE_PUBLISHING_ENABLED=true",
   nothing is built or signed.
2. **Approval gate.** During commissioning, with the variable `true`, dispatch
   a `publish` run and reject the `release-publish` deployment. Expected: no
   draft, no tag, no release.
3. **Roll forward on a client.** In a disposable VM with the update-test
   builds from `node scripts/verify-installed-upgrade.mjs --dry-run`, install
   N (`X.Y.Z-alpha.9001`), serve N+1 with `feed-serve` from
   `apps/desktop/dist-updatetest/X.Y.Z-alpha.9002`, let it download (ready),
   stop the server and serve N+2 (`...9003`) instead. Expected: Check for
   updates moves to N+2 as available, the download replaces the cached N+1,
   Update and restart lands on N+2. Commands are in
   [update-testing.md](update-testing.md#running); the automated
   `skip-n-to-n2` scenario covers the install part.
4. **Stable latest switch.** On a disposable fork, or a throwaway repository
   with two dummy releases, practice "Set as the latest release" and read
   `https://github.com/<owner>/<repo>/releases/latest` anonymously. The release
   tooling refuses to run in any repository but the one in `package.json`
   `homepage`, and SignPath will not sign for a fork, so a fork cannot publish
   through `release.yml`; practice only the GitHub UI part there.
5. **Tabletop.** Walk through the bad-release steps with the contacts, using
   the templates, and time how long it takes to get a fixed alpha out.

| Date | Drill | Operator | Result | Evidence link |
| --- | --- | --- | --- | --- |
| `<fill>` | | | | |

Incident log:

| Date | Release | What happened | Fixed by | Notes |
| --- | --- | --- | --- | --- |
| | | | | |

## Feed monitor

`.github/workflows/check-update-feed.yml` runs
`node tools/release/src/cli/release.ts monitor-feed` every 6 hours (at minute
23) and on manual dispatch. It has `contents: read` only, no secrets, pinned
actions and a 20-minute timeout. It opens no issues and uploads nothing. A
healthy run writes one summary line. It collects nothing about users: it only
reads public release URLs.

What it checks, the way installed clients read the feed:

- The releases listing (`api.github.com`, with the run's read-only token to
  avoid the anonymous rate limit; the token is sent only to `api.github.com`).
  A release counts as pipeline-built when its notes carry the
  `cw-release-plan` marker.
- Stable: `https://github.com/albertofa/cw-code/releases/latest` must resolve
  to the highest pipeline-built stable, and `releases/latest/download/latest.yml`
  must advertise it. Before any pipeline-built stable exists, a notice says
  so and the run passes.
- Alpha: the first entry of `releases.atom` that electron-updater would pick
  (valid semver, prerelease id empty, `alpha` or `beta`) must be the highest
  pipeline-built release of either channel, and its `alpha.yml` must advertise
  it. Before any pipeline release exists, a notice says so.
- For each target release: exactly the five assets, all uploaded;
  `alpha.yml` byte-identical to `latest.yml`; the installer answers a
  one-byte range request with the size from the manifest and the listing;
  `signing.json` is production `signpath` for that version and the marker's
  SHA and records the manifest's installer sha512; the blockmap matches the
  digest in `signing.json`.
- The full installer sha512 only with the dispatch input
  `verify_installer_digest` (about 100 MB per channel), so scheduled runs stay
  cheap.

A failed run retries twice (30 s, then 60 s) before it reports. Locally:

```sh
node tools/release/src/cli/release.ts monitor-feed [--attempts 3] [--delay-seconds 30] [--verify-installer-digest] [--report report.json]
```

Without `GH_TOKEN` it is fully anonymous. Result on 2026-09-25 against the
real repository (logs in `agents-scratchpad/updater/step10/`):

```
notice: No stable feed yet: no pipeline-built stable release exists; https://github.com/albertofa/cw-code/releases/latest resolves to v0.0.1-alpha.21, which is not a pipeline-built release, so stable-channel clients see no update until the first pipeline-built stable is published
notice: No alpha feed yet: no pipeline-built release exists; https://github.com/albertofa/cw-code/releases.atom resolves alpha clients to v0.0.1-alpha.21, which is not a pipeline-built release, so alpha-channel clients see no update until the first pipeline-built release is published
Update feed ok: stable: no pipeline-built release yet; alpha: no pipeline-built release yet (attempt 1 of 3)
```

GitHub disables scheduled workflows in a public repository after 60 days
without activity. If the monitor's runs stop, re-enable it from the Actions
tab.

### Feed monitor failures

| Failed check | Likely cause | Action |
| --- | --- | --- |
| `listing` | API outage or rate limit | Rerun later. Persistent: check githubstatus.com. |
| `stable latest-release` | Someone set another release as latest, or the bad-release step 2 is in effect | If unintended, set the highest good stable as latest again. |
| `alpha atom-feed` | Feed lag right after a publish, or a release created by hand after the pipeline's | Lag clears within minutes; rerun. A hand-made release on top hides pipeline releases from alpha clients: fix its notes/flags or publish a higher pipeline release. |
| `channel-manifest` | Feed file missing, unreadable or pointing at another version | Treat the release as bad: [Bad-release response](#bad-release-response). Never re-upload a feed file on a published release. |
| `assets` | An asset was deleted, added or never finished uploading | Never delete release assets. Restore by publishing a higher version; note it in the incident log. |
| `feed-copy` | `alpha.yml` and `latest.yml` differ | Bad release; roll forward. |
| `installer`, `installer-digest` | Installer missing, wrong size or wrong bytes | Bad release; roll forward. Clients reject wrong bytes by sha512, so users see download errors, not a bad install. |
| `signing`, `blockmap` | `signing.json` not production, wrong SHA, or blockmap changed | Check who changed the release. Roll forward. |

## Retention and budgets

- **Published release assets are never deleted.** electron-updater builds the
  old blockmap URL from the running version's release, so deleting an older
  release's blockmap turns every update from that version into a full
  download of about 100 MB, and deleting an installer removes the recovery
  path for users on it. This also applies to the legacy releases.
- **Workflow artifacts** (full table in
  [releases.md](releases.md#artifacts-and-retention)): release plans, release
  sets and release evidence 30 days; `sign-windows.yml` intermediates 3 days
  and its final set 14 days; CI and upgrade-test artifacts 7 days. The feed
  monitor uploads nothing. Evidence worth keeping past 30 days goes into the
  commissioning PR, not into artifacts.
- **CI minutes.** Every job has a timeout: CI `windows` 45 min,
  `upgrade-test.yml` 150 min (nightly at 03:17 UTC and on PRs touching the
  update path), release jobs 15 to 120 min, feed monitor 20 min (usually a
  few minutes, 4 runs a day). Automatic alpha validation coalesces to one run
  per 6 hours. To cut minutes: disable the nightly schedule of
  `upgrade-test.yml`, or `gh workflow disable` a workflow temporarily.
- **Costs.** To be confirmed by the owner for the account's actual plan:
  GitHub Actions minutes and artifact storage (public-repository terms and
  Windows runner multipliers depend on the plan), GitHub release bandwidth,
  and SignPath. SignPath Foundation is free according to its public terms,
  but enrollment is not accepted yet and quotas are not published. A
  commercial plan or another certificate authority costs money and needs the
  owner's approval first. Record the confirmed numbers here: `<owner to fill>`.

### Signing expiry reminders

Nothing checks certificate expiry automatically. The feed monitor would have
to download the full installer and parse its Authenticode signature on
Linux, which is not cheap, so it does not.

- Signatures carry an RFC 3161 timestamp, so installers already signed stay
  valid after the certificate expires. What breaks at expiry is signing new
  releases.
- With `CW_WINDOWS_PUBLISHER_NAME=SignPath Foundation` (CN only), a renewed
  Foundation certificate needs no client change. Any subject change follows
  the rotation procedure in
  [windows-signing.md](windows-signing.md#renewal-and-rotation).
- Calendar reminders for the owner:
  - 60 days before the signing certificate's NotAfter (read it from the last
    signed installer with
    `(Get-AuthenticodeSignature <installer>).SignerCertificate.NotAfter`;
    `verify-signatures.json` records only the subject): confirm with
    SignPath that renewal is scheduled. Next date: `<fill>`.
  - Yearly, and whenever a maintainer with access leaves: rotate
    `SIGNPATH_API_TOKEN`. Next date: `<fill>`.
  - Yearly: re-check SignPath Foundation eligibility and terms. Next date:
    `<fill>`.

## Support cases that still need a human

cw-code sends no telemetry and collects no prompts or paths. Support works
from what the user chooses to share.

| Case | What the user sees | What to do |
| --- | --- | --- |
| Per-machine install, UAC prompt | Update and restart shows a UAC prompt | Approve it. Declined: nothing is installed and cw-code stays closed; start it by hand, the update is still ready, try again. If cw-code is still open after 30 s it shows "The installer was started; restart cw-code if it is still open". |
| Installer interrupted by an OS shutdown or sign-out | After boot cw-code may start on either version, or not at all | Start cw-code. If it fails, run the installer of the newer version from the release page; it installs in place and keeps `~/.cw-code`. This case is still pending in the manual VM checklist (`shutdown-mid-install`). |
| Newer or unknown metadata schema | Recovery screen with "future-schema" | The file came from a newer cw-code. Install that version (or newer) from the release page, or restore a backup offered on the screen. Nothing was overwritten. |
| Corrupt or unreadable metadata | Recovery screen | Restore a backup, start fresh (the current file is kept as `.broken-<timestamp>`), or for `io` close the program that holds the file and Retry. |
| Startup fails for another reason | "cw-code could not start" dialog pointing at `crash.log` | Ask for the relevant lines of `crash.log`; reinstall the latest release over it. Data is not deleted. |
| Cached installer missing (cleaned temp, antivirus) | "The downloaded update is missing; download it again" | Click Download, then Update and restart. cw-code did not close. |
| Signature rejected (`ERR_UPDATER_INVALID_SIGNATURE`) | Download error without Retry | Never turn verification off. Treat it as a possible bad or tampered release: escalate to the contacts. |

What to ask the user for, and nothing more:

- cw-code version (Settings > Updates) and whether the install is per-user or
  for all users.
- `~/.cw-code/logs/updater.log` (and `updater.1.log` if present). It is
  already redacted: no tokens, query strings or user names.
- `~/.cw-code/logs/crash.log`, only the lines around the failure. It is not
  redacted and can contain file paths with the Windows user name and project
  names, so ask the user to read it and remove those before sending.
- Never ask for `cw-code.db.json`, `cw-settings.json`, CLI transcripts,
  prompts or screenshots of conversations. They can hold personal and client
  data; if one is needed to reproduce a metadata bug, ask for a sanitized copy
  and delete it after the fix.

## Deferred on purpose

Not built, and not to be provisioned until there is a concrete need:

- A Cloudflare R2 (or other) mirror of the release feed. GitHub Releases is
  the only feed.
- Staged rollout percentages. Every install sends the same constant staging
  id (see [updater.md](updater.md#privacy)), so percentages would need that
  decision revisited first.
- Opt-in health telemetry. There is none; the feed monitor only reads public
  URLs.

## Contacts

| Role | Who | How to reach | Backup |
| --- | --- | --- | --- |
| Release owner (approves `release-publish`) | `<owner to fill>` | `<fill>` | `<fill>` |
| Signing approver (SignPath, `release-signing`) | `<owner to fill>` | `<fill>` | `<fill>` |
| SignPath Foundation support | `<owner to fill>` | `<fill>` | |
| User communication channel | `<owner to fill>` | `<fill>` | |
