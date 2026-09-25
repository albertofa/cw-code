# Installed-upgrade testing

This is how we prove that an installed cw-code N updates itself to N+1 with the
real updater: the real NSIS installer, the real `electron-updater` 6.8.9 client,
the real `UpdateService`, the shutdown coordinator and a relaunch. A process exit
or an installer exit code is never accepted as success. A scenario passes only
when the relaunched app reports the new version, the registry shows it, and the
seeded projects, sessions, settings and worktree references are still there.

`release.yml` runs the signed N -> N+1 upgrade with the final candidate bytes
before any publication (see [Production bytes](#production-bytes-step-09) and
[releases.md](releases.md#upgrade-gate)). Nothing in this document publishes a
release, reads a token or touches a real account.

## Safety rules

- Installed scenarios run only on a disposable Windows machine: a GitHub-hosted
  runner (`CI=true`) or a VM you pass `--disposable-environment` in. Every install
  and uninstall path refuses to run otherwise.
- Never run the installed scenarios on a machine where you use cw-code. The
  update-test build has its own identity (below), but the harness still installs,
  uninstalls and deletes the update-test cache and userData folders.
- `--dry-run` never installs anything and is safe on a developer machine. It
  builds installers into `apps/desktop/dist-updatetest/` (gitignored) and starts
  the unpacked update-test build once with an isolated `CW_CODE_HOME` and
  `--user-data-dir`. Like `verify-windows-package.mjs`, that startup runs the
  normal orphaned-server sweep, which only touches `opencode serve` /
  `codex app-server` processes whose parent is gone.
- Only fake CLI processes run in automated scenarios. Processes are stopped by
  PID, never by name.

## Architecture

| Piece | Where | Role |
| --- | --- | --- |
| Feed server | `tools/release/src/feedServer.ts` (+ `feedSandbox.ts`, `feedRange.ts`, `feedFaults.ts`) | Loopback-only generic update feed with range support, a request log and fault injection |
| Feed validation | `tools/release/src/feedManifest.ts` | Checks `latest.yml`/`alpha.yml` shape, the referenced installer, its size and sha512, and the blockmap |
| Update-test identity | `apps/desktop/electron-builder.updatetest.yml` | Separate app id, product name, userData, updater cache and loopback feed URL |
| Autotest mode | `apps/desktop/src/main/updates/updateAutotest.ts` | Drives the real `UpdateService` and coordinator without UI; compiled only into update-test builds |
| Scenario matrix and evaluation | `tools/release/src/upgradeScenarios.ts` | Versions, scenarios, expected outcomes, metadata comparison, evidence redaction |
| Harness | `scripts/verify-installed-upgrade.mjs` + `scripts/lib/` | Builds, installs, seeds, serves, launches, waits, asserts, uninstalls |
| Production bundle gate | `scripts/lib/production-bundle.mjs` (`--assert-production-bundle`) | Fails a production `out/main` or `app.asar` that carries the autotest path |
| Fake CLI | `scripts/fixtures/fake-claude.mjs` | Stands in for `claude` so a busy turn can be stopped without an account |
| CI | `.github/workflows/upgrade-test.yml` | Runs everything on `windows-latest` |

### Feed server

`startFeedServer({ root, port, faults })` binds `127.0.0.1` only and serves files
from one root directory. CLI:

```sh
node tools/release/src/cli/release.ts feed-serve --root <dir> [--port 47613] [--faults '<json>' | --faults-file <file>] [--log requests.jsonl]
node tools/release/src/cli/release.ts validate-feed --dir <dir> [--version X] [--channels alpha.yml,latest.yml] [--require-blockmap]
```

- Paths: only `[A-Za-z0-9._-]` segments. `..`, `.`, empty segments, absolute
  paths, drive letters, colons (alternate data streams), backslashes, percent
  signs after decoding, encoded `/`, `\` and NUL, trailing dots, Windows device
  names and a foreign `Host` header are rejected. After that the real path of
  the file (through junctions and symlinks) must stay inside the real path of
  the root, otherwise 403.
- `GET` and `HEAD`, `Accept-Ranges: bytes`, `ETag`, `Last-Modified`,
  `Cache-Control: no-store`. Query strings (the updater's `noCache=`) are
  ignored.
- Ranges: `a-b`, `a-`, `-n`, clamped to the file; several ranges come back as
  `multipart/byteranges` in request order and are never merged, because
  `electron-updater`'s `DataSplitter` maps parts to its task list by position.
  All parts unsatisfiable, or more than 1000 ranges, gives 416 with
  `Content-Range: bytes */<size>`. A malformed `Range` header is ignored (200).
- The request log records method, path, served path, range, status, the body
  bytes actually written and the fault. `summarizeTransfers` sums bytes per
  file; that is how full and differential downloads are measured.

Faults (JSON array, matched by feed-relative path, `*` matches within one
segment, optional `times` applies a fault only to the first N matching
requests, deterministic):

| Type | Fields | Effect |
| --- | --- | --- |
| `unavailable` | `mode`: `503` (default) or `reset` | 503 with `Retry-After: 1`, or the socket is destroyed |
| `missing` | | 404 for a file that exists |
| `truncate` | `bytes` | Headers promise the full length; the body stops after `bytes` and the connection drops |
| `corrupt` | `offset` (0), `length` (1) | Flips those bytes of the file in every response that covers them, full or ranged |
| `stale-manifest` | `serve` | Serves another file from the root instead (a cached old manifest) |
| `slow` | `bytesPerSecond` | Throttles the body |

`feedUpdaterContract.test.ts` runs `electron-updater`'s own
`GenericDifferentialDownloader` (multipart and single-range modes) and
`builder-util-runtime`'s full download against the server with real
app-builder-lib blockmaps, including corrupt and truncated responses.

### Update-test identity

| | Production | Update test |
| --- | --- | --- |
| appId | `com.cwcode.app` | `com.cwcode.app.updatetest` |
| NSIS GUID | `d6e18d04-bf35-5bfe-9145-b95301660833` | `78c8b42b-619d-5778-ad5d-d0527bace3e7` |
| productName / executable | `cw-code` / `cw-code.exe` | `cw-code-updatetest` / `cw-code-updatetest.exe` |
| Default install dir | `%LOCALAPPDATA%\Programs\cw-code` | `%LOCALAPPDATA%\Programs\cw-code-updatetest` |
| package name / Electron userData | `@cw-code/desktop` / `%APPDATA%\@cw-code\desktop` | `@cw-code/desktop-updatetest` / `%APPDATA%\@cw-code\desktop-updatetest` |
| App home when `CW_CODE_HOME` is unset | `~/.cw-code` | `~/.cw-code-updatetest` (set before any store opens) |
| Updater cache | `%LOCALAPPDATA%\@cw-codedesktop-updater` | `%LOCALAPPDATA%\@cw-codedesktop-updatetest-updater` |
| Main bundle | `out/` (`main: out/main/index.js`) | `out-updatetest/` (`main: out-updatetest/main/index.js`, `out/**` excluded) |
| Feed | GitHub Releases | `generic`, `http://127.0.0.1:47613/` baked into `app-update.yml` |

The file `extends` the production `electron-builder.yml` and only overrides
those keys. `CW_UPDATE_TEST_BUILD=1` makes `electron.vite.config.ts` write the
bundle to `out-updatetest/`, so an interrupted test build never leaves the test
bundle in `out/`, which production packaging reads. The overrides replace the
parent values (`publish` is an object there so it replaces the production array
instead of being merged into it). Channel files come from the version with
`generateUpdatesFilesForAllChannels`: an alpha build writes `alpha.yml` only; a
stable build writes `latest.yml` plus the prerelease channel files.
Versions are derived from `apps/desktop/package.json` (`X.Y.Z` base):

| Key | Version | Use |
| --- | --- | --- |
| previous | `X.Y.Z-alpha.9000` | only advertised (downgrade test), never built |
| n, n1, n2 | `X.Y.Z-alpha.9001`, `.9002`, `.9003` | alpha chain |
| stable1, stable2 | `X.Y.(Z+1)`, `X.Y.(Z+2)` | stable pair |
| alphaAfterStable | `X.Y.(Z+3)-alpha.1` | only advertised, to a stable client |

They must be `X.Y.Z` or `X.Y.Z-alpha.N`, because `isEligible` ignores every
other shape.

### Autotest mode

`electron.vite.config.ts` defines `__CW_UPDATE_TEST_BUILD__` as `true` only when
`CW_UPDATE_TEST_BUILD=1` is set at build time (declared in
`src/main/buildFlags.d.ts`). `main/index.ts` imports
`updates/updateAutotest.js` inside `if (__CW_UPDATE_TEST_BUILD__)`, so a
production build drops the module and every `CW_UPDATE_AUTOTEST*` string.
`node scripts/verify-installed-upgrade.mjs --assert-production-bundle [<out/main>] [--asar <app.asar>] [--desktop-dir <dir>]`
fails when `CW_UPDATE_TEST_BUILD` is set, when `out/main/index.js` is missing,
when `out/main` has an `updateAutotest-*` chunk or a script containing
`cw-update-autotest` / `CW_UPDATE_AUTOTEST`, and, with `--asar`, when the
archive's `package.json` `main` is not `out/main/index.js`, when it has any
`out-updatetest/` entry or `updateAutotest-*` chunk, or when any bundled script
under `out/` contains a marker. It runs on the shipping path: after `pnpm build`
in the `verify` job of `ci.yml`, on `dist/win-unpacked` and `dist-ci/win-unpacked`
in its `windows` job, and in `sign-windows.yml` `package-app` (from the tooling
checkout, after a step that refuses `CW_UPDATE_TEST_BUILD`) before
`win-unpacked` is uploaded for signing. The harness also checks that each
update-test `app.asar` does contain the `updateAutotest` chunk. Production builds accept no runtime feed override:
`electron-updater` reads `resources/app-update.yml`, `forceDevUpdateConfig` is
off, and nothing reads a feed URL from the environment.

In an update-test build, after the window loads:

| Variable | Meaning |
| --- | --- |
| `CW_UPDATE_AUTOTEST` | `install`, `check-only`, `download-only` or `cancel` |
| `CW_UPDATE_AUTOTEST_OUT` | absolute path of the JSON-lines event log |
| `CW_UPDATE_AUTOTEST_BUSY_SESSION` | optional session id; a turn is started there before the restart is prepared |
| `CW_UPDATE_AUTOTEST_PAUSE_FILE` | optional absolute path; after the download the run waits (up to 180 s) until the file exists |

The run calls `UpdateService.check()`, `download()`, then
`ShutdownCoordinator.prepare({ reason: "update", stopActiveTurns: true, approvedTurnIds })`
(forcing a timed-out stop), then the same `installUpdate` path as the
`updates.install` IPC handler. `cancel` cancels the token instead. Every step,
every phase change and the 25/50/75/100 % progress marks are logged:
`started` (version, pid), `state`, `progress`, `check`, `download`, `paused`,
`busy-turn`, `assessment`, `prepare`, `cancelled`, `installing`, `install`,
`result` (`outcome`, and `coordinatorIdle`: whether the shutdown coordinator
released its reservation), `quitting`. `started` also records the effective
`CW_CODE_HOME` and `app.getPath("userData")`, and the harness fails a run that
used anything but the isolated folders. Then the app quits through the normal
flush path.

An update-test build that starts without `CW_CODE_HOME` (and without a handoff)
sets it to `~/.cw-code-updatetest` before any store opens, so it can never read
or write the real `~/.cw-code`.

Before installing it writes `cw-update-autotest-handoff.json` in its userData
folder with the log path, `CW_CODE_HOME` and the running version. The
relaunched app may not inherit the environment (NSIS starts it through
`ExecShellAsUser` for `--force-run`), so on startup an update-test build consumes that file,
restores `CW_CODE_HOME` before any store opens, logs `started` and
`relaunched` (`fromVersion`, `version`, `sameVersion`, `startupMode`,
`launchedByInstaller`), runs one check (it should be `up-to-date`) and quits.
That second `started` event is the relaunch proof; the harness also requires a
pid different from N's and `launchedByInstaller` (`--updated` on the command
line).

## Running

Safe anywhere (no install):

```sh
pnpm --filter @cw-code/desktop build
node scripts/verify-installed-upgrade.mjs --assert-production-bundle
node scripts/verify-installed-upgrade.mjs --dry-run [--scenarios n-to-n1,faults] [--work-dir <dir>] [--evidence <file>]
```

The dry run builds the production bundle into `out/` and the needed update-test
installers (`electron-vite build` with `CW_UPDATE_TEST_BUILD=1` into
`out-updatetest/`, then `electron-builder --config electron-builder.updatetest.yml
--publish never -c.extraMetadata.version=<v>` per version), validates each release set and `app-update.yml`, checks the
production bundle, stages every scenario's feed, serves it with its faults and
probes manifests, a single range, a multi-range and a traversal attempt, and
starts the unpacked build once to confirm the autotest reports `disabled` (a
copy without an uninstaller must not update) and ran with the isolated home and
userData. The evidence file is rewritten after each staged plan and each
scenario, so a killed run still leaves what it did (`complete: false`). `--skip-build` reuses
`dist-updatetest/<version>/`.

Only in a disposable Windows VM or runner:

```sh
node scripts/verify-installed-upgrade.mjs --skip-build --disposable-environment --evidence <dir>/installed.json
```

Per scenario it cleans any leftover update-test install, seeds a fresh
`CW_CODE_HOME` from the sanitized schema-0 fixtures in
`apps/desktop/src/main/storage/__fixtures__` (the first project's root points at
a scenario folder, `claudeBinaryPath` is Node and `claudeExtraArgs` the fake CLI
script, background download off, an unknown settings key added), writes
markers under `worktrees/`, `userdata/attachments/` and the Electron userData
folder, installs N silently (`/S`, `/S /D=<dir>` or `/S /allusers`), reads the
feed port from the installed `app-update.yml`, stages the feed, and launches N with
`CW_UPDATE_AUTOTEST`, the isolated home and a `PATH` of Windows system folders
only. It waits for the result, the installer, the relaunched run and its exit,
then compares registry `DisplayVersion` and `InstallLocation`, the relaunch
events, the transfer, the fake CLI log and the metadata, and uninstalls. A
process left behind is stopped by PID only after its image path is checked
(`cw-code-updatetest.exe` for the app, the harness's own Node for fake CLIs).

Running the feed by hand against a build:

```sh
node tools/release/src/cli/release.ts validate-feed --dir apps/desktop/dist-updatetest/0.0.1-alpha.9002 --require-blockmap
node tools/release/src/cli/release.ts feed-serve --root apps/desktop/dist-updatetest/0.0.1-alpha.9002 --port 47613
```

## CI

`.github/workflows/upgrade-test.yml` runs on `workflow_dispatch` (optional
`scenarios` input), nightly at 03:17 UTC and on pull requests that touch
the lockfile, `apps/desktop/package.json`, `main/{updates,shutdown,storage,sessions,settings,paths}/**`
(fixtures included), `main/index.ts`, the builder configs, `electron.vite.config.ts`,
the `updates`/`shutdown`/`settings`/`startup` contracts, the harness, the feed
code or the release-tools modules it uses (`rehash`, `updateInfoYaml`, `semver`,
`upgradeScenarios`). One `windows-latest`
job, 150-minute timeout, `contents: read`, no secrets, no dependency cache,
actions pinned by SHA, `persist-credentials: false`. Steps: release-tools tests,
production bundle assertion, dry run (builds and validates), installed
scenarios, and the redacted evidence folder uploaded with `retention-days: 7`
even when a step fails. `upgradeWorkflowPolicy.test.ts` enforces those rules.

## Automated scenarios

| Id | Installs | Feed | Expected |
| --- | --- | --- | --- |
| `n-to-n1` | N | N+1 with N and N+1 blockmaps | relaunched as N+1, differential download, data preserved |
| `skip-n-to-n2` | N | N+2 | relaunched as N+2 |
| `busy-turn` | N | N+1 | a fake `claude` turn is active at prepare, the coordinator stops it, exactly one turn start in the fake log, no fake process left, relaunched as N+1 |
| `cancel-restart` | N | N+1 | prepared restart cancelled, N still installed, phase `ready` with `downloadedVersion` N+1, coordinator idle |
| `stable-to-stable` | stable1 | stable2 | relaunched as stable2 on the stable channel |
| `alpha-offered-stable` | N | stable2 | check offers stable2 |
| `stable-not-offered-alpha` | stable1 | `latest.yml` and `alpha.yml` advertise `alphaAfterStable` | `up-to-date`, nothing downloaded |
| `no-downgrade` | N | `alpha.yml` advertises `previous` | `up-to-date`, nothing downloaded |
| `feed-unavailable` | N | 503 on every manifest | `check-failed`, retryable, N intact |
| `missing-manifest` | N | 404 on `alpha.yml` | `check-failed` (alpha channel treats a missing channel file as an error), N intact |
| `stale-manifest` | N | `alpha.yml` answered with N's own manifest | `up-to-date`, N intact |
| `truncated-download` | N | installer cut after 4 MiB | `download-failed`, retryable, N intact |
| `corrupted-checksum` | N | 16 installer bytes flipped | `download-failed` (sha512), retryable, N intact |
| `installer-removed` | N | N+1; the cached installer is deleted during the pause | the install pre-check refuses: `install-failed`, phase `available` for N+1, retryable download error, coordinator idle, N keeps running and stays installed |
| `installer-denied` | N | N+1; execute is denied on the cached installer (`icacls /deny *S-1-1-0:(X)`) | the pre-check passes (file present, right size) and the spawn fails after N quit: installer never starts, N intact, a relaunched N offers the update again |
| `differential-n1-n2` | N+1 | N+2 with both blockmaps | download-only, differential |
| `differential-fallback` | N+1 | N+2 without the N+1 blockmap | download-only, full download |
| `custom-dir` | N in `/D=<dir>` | N+1 | updated in place, same `InstallLocation` |
| `per-machine` | N with `/allusers` | N+1 | updated in place in HKLM; skipped without elevation |

Every scenario also checks: the first run started as the installed version,
`InstallLocation` unchanged, `schemaVersion` 1 in both stores, project ids and
roots, session ids, drivers, resume cursors, worktree paths and branches, the
listed settings and the unknown settings key unchanged, and the three marker
files byte-identical.

### Measurements

The evidence file has `measurements` per scenario: installer size, bytes the
feed served for the installer, ratio, download time and the time from
`installing` to the relaunched `started`. N is installed from its own
installer, which NSIS stores as `installer.exe` in the updater cache, so an
update can be differential as soon as the feed serves the old blockmap
(`electron-updater` derives its URL by replacing the new version with the
running one in the new installer URL). `differential-fallback` removes that
blockmap. The builds come from the same commit and differ only in version, so
the differential numbers are a lower bound for real releases; the numbers for
consecutive real releases come from step 09 and 10.

Local reference (2026-09-25, `electron-updater` 6.8.9's
`GenericDifferentialDownloader` against the feed server, no install): N+1 to
N+2 rebuilt a 104,844,558-byte installer from 1,548,003 bytes (1.48 %) in one
multipart range request, and the result matched the manifest sha512; N to N+1
was 1,537,013 bytes (1.47 %).

## Known behavior the scenarios pin down

Read from the app-builder-lib 26.15.3 NSIS templates and the electron-updater
6.8.9 source; the CI evidence is what confirms or corrects it.

- Update and restart calls `quitAndInstall(true, true)`: a silent install
  with `--updated --force-run`. Silent mode keeps the existing scope and
  directory (`initMultiUser` reads `InstallLocation`), elevates a per-machine
  install through `UAC_RunElevated`, and the install section starts the app
  for `--force-run`. No installer window needs a click.
- Before committing, `UpdateService` checks that the installer reported by
  `update-downloaded` still exists, is a regular file and has the feed size.
  A missing file sends the state back to `available` with a retryable download
  error and releases the coordinator; nothing is committed (`installer-removed`).
- A file that is present but cannot be executed passes that check.
  `electron-updater` spawns the installer asynchronously after `quitAndInstall`
  returns, so the app has already quit when the spawn (and the `elevate.exe`
  retry) fails. The install never starts, N and its data stay intact and the
  next start offers the update again (`installer-denied`).
## Manual cases (disposable VM only)

Use a snapshot, the update-test builds from a dry run, and a feed started with
`feed-serve` from the N+1 build folder.

1. **Per-machine with UAC** (`per-machine-uac`): install N with `/allusers`
   from an admin prompt, sign in as a standard user, start N, update. Expect a
   UAC prompt; approve: relaunch as N+1 in the same folder. Deny: N stays
   installed and usable.
2. **Reboot during install** (`reboot-during-install`): start the update and
   reboot while the NSIS progress bar runs. After boot, N or N+1 must start
   and load its projects; if files are half replaced, rerunning the N+1
   installer must repair it. Record which.
3. **OS shutdown mid-install** (`shutdown-mid-install`): same, with sign-out or
   `shutdown /s /t 0`.
4. **Insufficient disk** (`insufficient-disk`): fill the system drive (for
   example `fsutil file createnew C:\fill.bin <bytes>`) so less than the
   installer size is free, then check and download: expect a download error
   with Retry and N intact. Free space, retry, then fill again before Update and
   restart to see the installer's own error.
5. **Dirty buffers and terminals** (`dirty-buffers`): open a file in the editor,
   change it, open a terminal, choose Update and restart. The dialog must list
   both; Cancel keeps everything; Save then continue installs.
6. **Real CLI smoke** (`real-cli-smoke`): after an update, in a throwaway
   project and a throwaway `CW_CODE_HOME`, run one short turn with each
   installed CLI on your own subscription. Never do this on CI.
7. **Legacy identity** (`legacy-identity`): install the legacy
   `v0.0.1-alpha.21` release, then the signed bootstrap installer over it by
   hand. The legacy build has no updater, so this step is always a manual
   install; the exact commands and evidence are step C of
   [rollout.md](rollout.md#c-bootstrap-candidate-over-the-real-legacy-installer-disposable-vm).
8. **Wrong publisher** (`signed-wrong-publisher`, step 09): serve a candidate
   signed by a different controlled certificate; the download must fail with
   `ERR_UPDATER_INVALID_SIGNATURE` and N stay intact. Verification is never
   turned off to run this.

Also still pending from `updater.md`: the keyboard, progress, opt-out, Later and
channel UI checks, done by hand against the same feed.

## Production bytes (step 09)

```sh
node scripts/verify-installed-upgrade.mjs --production-bytes --installer <cw-code-Setup-N-x64.exe> --candidate-dir <signed N+1 release set> --disposable-environment [--feed-port 47613] [--devtools-port 9339] --evidence <file>
```

Production builds contain no autotest path, so this mode drives the real
production renderer bridge instead:

1. Refuses to run if any `com.cwcode.app` install exists, validates the
   candidate set (manifest, sha512, size, blockmap).
2. Seeds cw-code's real default data folders with the guarded `cw-verify`
   fixtures (it aborts if they already hold real data) and installs N per user.
3. Rewrites only the installed copy's `resources/app-update.yml` to
   `provider: generic` on the loopback feed, keeping `updaterCacheDirName` and
   every `publisherName`, so `electron-updater` still verifies the candidate's
   Authenticode publisher.
4. Serves the candidate folder, starts N with `--remote-debugging-port` and
   runs `window.cw.updates.check`, `download`, `window.cw.shutdown.prepare` and
   `window.cw.updates.install` in the renderer over DevTools, the same calls the
   Update and restart button makes.
5. Waits for the silent installer to finish (`DisplayVersion` N+1) and for a new
   `cw-code.exe` main process at the install path, closes it by PID, runs the
   packaged startup probe, checks the Authenticode status and subject of the
   installed executable against `publisherName`, compares the seeded data and
   uninstalls.

Trade-off: the production binary is unchanged, but the test edits one file in
the disposable install and opens a loopback DevTools port for the test's
duration.

## Evidence

The evidence JSON (`schema: 1`) lists versions, builds (installer, size, sha512,
channel files, blockmap, feed URL), the production bundle check, selected,
skipped and manual scenarios, per-scenario results, measurements and
`passed`. Logs per scenario: `autotest.jsonl`, `autotest-recovery.jsonl`,
`fake-claude.jsonl`, `updater.log`, `crash.log`.
Everything is redacted before writing: the work folder, repository,
`%LOCALAPPDATA%`, `%APPDATA%`, `%USERPROFILE%`, the temp folder and the Node
path become placeholders, other `X:\Users\<name>` become `<user>`, GitHub token
shapes are masked, and keys named `env`, `token`, `authorization`, `password`
or `secret` are dropped. The app's own `updater.log` is already redacted by
`updateLog.ts`.

## Troubleshooting

- Port 47613 busy: pass `--feed-port <p>` together with a fresh build (the port
  is baked into `app-update.yml`).
- A failed run left an update-test install behind: the next run uninstalls it
  first (the uninstall key is under the update-test GUID; its location must
  contain `updatetest`, otherwise the harness refuses to touch it).
- No relaunch in CI: look at `updater.log` (its `Executing:` line shows the
  installer arguments) and the Windows Application event log before changing
  expectations.
