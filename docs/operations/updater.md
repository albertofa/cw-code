# Auto-updater

cw-code checks GitHub Releases of `albertofa/cw-code` for newer Windows builds
and downloads them with `electron-updater` 6.8.9. The main process runs the
updater. The renderer can only read state and ask for actions through the
preload bridge. It never passes a feed URL, a file path, or an executable.

The installer only runs after the user chooses **Update and restart**. That
click goes through the shutdown coordinator (see `shutdown.md`) with reason
`update`, and only then does main call `quitAndInstall`. An ordinary quit, a
closed window or an OS session end never installs anything.

## Architecture

All updater code is in `apps/desktop/src/main/updates/`:

| File | Role |
| --- | --- |
| `updateState.ts` | Pure reducer `reduceUpdate(state, event)` plus version helpers (`compareVersions`, `channelOfVersion`, `isEligible`), release-notes normalization. No I/O. |
| `UpdateService.ts` | Serialized operation queue, request dedupe, disabled detection, scheduling, typed action results, redacted logging. The clock, scheduler, random source, file checks and adapter are injected. |
| `ElectronUpdaterAdapter.ts` | The only file that imports `electron-updater`. Implements the `UpdaterAdapter` interface the service depends on. |
| `updateLog.ts` | Log and error redaction, error classification (retryable, missing release), the bounded `updater.log` file sink. |
| `updatePreferences.ts` | Maps the saved `updateChannel` / `updateBackgroundDownload` settings to the service's channel and download policy. |

The contract types live in `packages/contracts/src/updates.ts`.

`main/index.ts` creates the service in `createServices()`, so it exists only in
normal startup. Recovery mode has no updater on purpose: the user has to fix the
metadata first, and an update must not replace the app while its data files are
broken. The service is disposed on `before-quit`, except while `installing`
(see [Failure recovery](#failure-recovery)). The adapter, and with it the `NsisUpdater` instance, is created
lazily on the first check, so disabled builds never create an updater object.

### IPC

| Channel | Direction | Payload |
| --- | --- | --- |
| `updates.state` | invoke | returns `UpdateState` |
| `updates.check` | invoke | returns `UpdateActionResult` |
| `updates.download` | invoke | returns `UpdateActionResult` |
| `updates.setChannel` | invoke `{ channel }` | returns `UpdateActionResult` and saves `updateChannel` only when the result is ok; anything other than `"stable"`/`"alpha"` returns code `invalid`, and `busy` or `failed` save nothing either |
| `updates.install` | invoke `{ version, channel, token }` | returns `UpdateActionResult`; see [Install flow](#install-flow) |
| `updates.changed` | main → renderer event | `UpdateState` |

Renderer: `window.cw.updates.{getState, check, download, setChannel, install, onChanged}`
and the `appStore` fields `updates`, `updateRestartPending`, `subscribeUpdates()`,
`applyUpdateState()`, `checkForUpdates()`, `downloadUpdate()`, `setUpdateChannel()`,
`setUpdateBackgroundDownload()`. `stores/updateFlow.ts` runs Update and restart.
`subscribeUpdates()` subscribes to `updates.changed` first and then fetches the
snapshot. Every state carries a `seq` that increases on each change. The store
drops any state whose `seq` is lower than the one it holds, so a late snapshot
cannot overwrite a newer event. Action results carry a state and go through the
same rule.

Download progress is throttled in the store (`stores/updateThrottle.ts`). A state
that differs from the current one only in `progress` is applied when 500 ms have
passed since the last applied state, when the percentage moved by 2 points or
more, or when it reaches 100 %. Phase, version and error changes are never
throttled.

## States

| Phase | Meaning |
| --- | --- |
| `disabled` | Updates cannot run in this copy; `disabledReason` says why. It never changes for the life of the process. |
| `idle` | Enabled, nothing checked yet (or the channel just changed and nothing carried over). |
| `checking` | A check is in flight. |
| `up-to-date` | The last check found no eligible newer version. |
| `available` | An eligible newer version was found and is not downloaded. |
| `downloading` | Download in progress; `progress` is set. |
| `ready` | `downloadedVersion` is downloaded and verified by `electron-updater` (sha512, plus Authenticode publisher check when `publisherName` is configured). |
| `installing` | The user chose Update and restart, the coordinator is committing and `quitAndInstall` was called. Checks and downloads queue behind it; channel changes return `busy`. |
| `error` | The last check or download failed; `error.context` is `check` or `download` and `error.retryable` says whether retrying can help. A failed install goes back to `ready` with `error.context` `install` instead. |

Rules the reducer enforces:

- A ready download survives later failed checks, empty checks, and checks that
  report an older version. The phase stays `ready`. A failed check still sets
  `error` so the UI can show it.
- A newer version found while one is ready moves the phase to `available`. The
  older `downloadedVersion` stays usable until a download of the newer version
  starts. `electron-updater` keeps a single pending installer and wipes its
  cache when a different version starts downloading (and again on failure or
  cancel), so `download-started` for another version clears
  `downloadedVersion`. If that download then fails, the phase is `error`, not
  `ready`.
- Results that do not fit the current phase (a check result when not checking,
  progress when not downloading, a download result for a different version) are
  ignored without changing `seq`.
- Changing the channel drops `availableVersion` and `downloadedVersion` when
  the new channel does not allow them, and clears progress and error.

`UpdateActionResult` codes: `disabled`, `busy` (a download holds the lock and no check is running),
`no-update` (nothing to download), `not-ready` (check again first, e.g. after a
failed check), `superseded` (the channel changed or the service shut down
before the operation finished), `invalid` (bad argument), `failed` (the
check or download failed; the message is redacted). A request is never
silently ignored.

## Serialization

Every check, download and channel change runs through one promise chain in the
service, whether it came from IPC or from a timer.

- Concurrent identical requests share one in-flight promise (two `check()` calls
  run one check; two `download()` calls run one download; repeating the latest
  pending `setChannel` value returns the pending promise).
- A check requested while another check is running joins that check, even if a
  download is queued behind it. Otherwise a check requested while a download is
  queued or running returns `busy` instead of waiting behind a long download.
- A download requested during a check waits for the check and then evaluates
  the fresh state.
- `setChannel` cancels the active download immediately through its
  `CancellationToken` only when the new channel would not accept that version
  (alpha to stable while an alpha downloads). It reconfigures the updater
  first; if that throws, nothing is cancelled and the channel stays as it was.
  A stable to alpha switch lets a stable download finish. Progress that arrives
  after a cancel is dropped, because it no longer matches an active download
  operation.
- `setChannel` also detaches any pending download request from dedupe, so a
  `download()` issued after the switch gets its own operation instead of the
  old, possibly superseded promise. A queued download whose version the pending
  channel would not accept returns `superseded` without starting.
- After the change, the service queues a check on the new channel behind
  whatever is already queued, including a download, so the check is never
  dropped as `busy`.
- Setting the channel that is already active returns `ok` and cancels nothing.
- If an operation throws unexpectedly, the service logs it, counts it as a
  failure for backoff, cancels and releases an active download so the lock
  cannot stick, moves a running check or download to `error`, and schedules the
  next check with backoff so the timer never stops.

## Channels

| Channel | `allowPrerelease` | `electron-updater` channel | Accepts |
| --- | --- | --- | --- |
| `stable` | false | `latest` | Stable `X.Y.Z` newer than the running version |
| `alpha` | true | `alpha` | Stable or `X.Y.Z-alpha.N` newer than the running version |

- The default channel is derived from the running version
  (`0.0.1-alpha.21` → `alpha`) and frozen: on the first start with updates
  enabled and `updateChannel` still `null`, main saves the derived channel. An
  alpha tester who later receives a stable build through the alpha channel
  therefore stays on alpha instead of silently moving to stable. Choosing a
  channel in Settings overwrites it. Dev and other disabled builds never save
  it. The renderer uses the same rule (`components/updateChannel.ts`, parity
  tested against `channelOfVersion` in main).
- The adapter sets `allowDowngrade = false` after setting `channel`, because the
  `electron-updater` channel setter turns downgrades on. A unit test fails if
  that order is reversed.
- On top of the library's own checks, the service runs `isEligible()` on every
  reported version: a prerelease on stable, a version at or below the running
  one, or a version that is neither `X.Y.Z` nor `X.Y.Z-alpha.N` is logged and
  treated as "no update". An alpha user who switches to stable therefore waits
  until a stable release newer than the running alpha exists.
- `autoDownload`, `autoInstallOnAppQuit`, `forceDevUpdateConfig` and
  `fullChangelog` are all false. `disableWebInstaller` is true (we ship only the
  full NSIS installer). Signature and checksum verification and differential
  download keep the library defaults (`verifyUpdateCodeSignature` is not
  touched).

How the GitHub provider resolves releases (from the 6.8.9 source):

- Stable (`allowPrerelease` false): `https://github.com/albertofa/cw-code/releases/latest`,
  that is, the newest non-prerelease, non-draft release. That release's
  `latest.yml` is fetched.
- Alpha (`allowPrerelease` true): the releases Atom feed. It takes the first
  entry, in feed order, whose tag is valid semver and whose prerelease tag is
  empty, `alpha` or `beta`, then fetches `alpha.yml` from that release. If
  `alpha.yml` is missing, it falls back to `latest.yml`. Feed order is release
  creation order, not semver order, and the feed only lists recent releases.
  If the first qualifying entry is not newer than the running version (for
  example a late hotfix release created for an older line), alpha users see no
  update even when a higher version exists further down. A `beta` tag at the
  top would also hide older alphas, because `isEligible` rejects betas. The
  release pipeline has to publish in version order.

Missing releases on the stable channel:

| Code | Cause | Stable channel | Alpha channel |
| --- | --- | --- | --- |
| `ERR_UPDATER_LATEST_VERSION_NOT_FOUND` wrapping `HttpError: 404` | `/releases/latest` returned 404: no stable release exists yet | `up-to-date`, warn log `no stable release yet (<code>)`, normal 6 h schedule | error with backoff |
| `ERR_UPDATER_LATEST_VERSION_NOT_FOUND`, any other cause | 5xx, 403/429 rate limit, `Request timed out`, a captive portal's HTML failing `JSON.parse`, `net::ERR_...` | retryable error with backoff | error with backoff |
| `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` | The chosen release has no `latest.yml`/`alpha.yml` (a `net::ERR_...` cause stays an error) | `up-to-date`, same warn log | error with backoff |

The library wraps every failure of the `/releases/latest` request in
`ERR_UPDATER_LATEST_VERSION_NOT_FOUND` and appends the cause's stack to the
message. The service only trusts the wrapped `HttpError: 404` as "no stable
release yet".

## Schedule

- First check: 45 s ± 15 s after `start()` (called right after IPC is
  registered).
- After a successful check: every 6 h ± 10 %.
- After a failed check: exponential backoff 5 min, 10 min, 20 min, ... capped at
  6 h (± 10 % jitter, never above the cap). A success resets it.
- A manual check skips the schedule but not the lock, and resets the timer.
- A timer that fires while a download holds the lock reschedules itself for the
  regular interval.
- A timer that fires while the shutdown coordinator is not idle (a quit or
  restart is being prepared) is postponed by 60 s. The coordinator is still
  idle while the shutdown dialog is only reviewing blockers or waiting, so a
  check in that window can still make a newer version available; the restart
  is then cancelled after prepare and the user is asked to try again.
- `dispose()` cancels the timer and any active download, detaches adapter
  listeners, disposes the adapter and stops publishing state.

`autoDownload` is a policy flag on the service (`setAutoDownload`), fed from the
`updateBackgroundDownload` setting (default on). When true, a check that finds
an available update queues a download, and turning it on while an update is
`available` starts that download. It never installs anything.

## Disabled cases

Checked once at construction, in this order:

| Condition | `disabledReason` |
| --- | --- |
| `!app.isPackaged` (dev, `electron-vite dev`) | Updates are disabled in development builds |
| `process.resourcesPath/app-update.yml` missing | No update feed is configured for this build |
| No `Uninstall *.exe` next to `process.execPath` (portable copy, `win-unpacked`) | This copy of cw-code was not installed with the Windows installer |

Any NSIS uninstaller name counts, so the update-test build
(`Uninstall cw-code-updatetest.exe`) is detected too. An unreadable install
directory counts as "not installed".

Every action then returns code `disabled` with that message.

## Logging and redaction

Updater lines go to `~/.cw-code/logs/updater.log` (under `CW_CODE_HOME` when
set) and to the main-process console with an `[updates]` prefix. The file
rotates at 1 MB to `updater.1.log`, so it never exceeds about 2 MB. A failed
rotation or write is reported on the console and never throws; the line is
still appended when only the rotation failed. `electron-updater`'s own
logger goes through the same sink with an `electron-updater:` prefix. Every
line passes through `redactUpdateText` before it reaches the sink, which:

- removes URL credentials, query strings and fragments;
- masks GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`),
  `Bearer`/`Basic` values and `authorization|token|password|secret = value` pairs;
- replaces the home directory (either slash style) with `~`, and any other
  `X:\Users\<name>` with `X:\Users\<user>`;
- hides the library's staging user id in its "staging user ID" log lines;
- caps each line at 2,000 characters (the GitHub provider can dump a whole
  releases feed into an error).

Error messages shown in state use the first line only, redacted, capped at 300
characters. Chromium network errors (`net::ERR_INTERNET_DISCONNECTED`, name
resolution, timeouts, proxy failures) become "Could not reach the update
server (...). Check your connection and try again." Invalid signature, invalid
version, invalid or unsupported provider configuration, and disabled web
installer are not retryable. Everything else is.

Download progress is logged only at 25/50/75/100 %.

## Privacy

`electron-updater` generates a random per-install id, stores it as `.updaterId`
in Electron `userData` (`%APPDATA%\@cw-code\desktop`), and sends it to the feed
as the `x-user-staging-id` header for staged rollouts. cw-code does not use
staged rollouts, and a stable per-install id sent to GitHub is identifying
data we do not need (LGPD data minimization). The adapter sets
`requestHeaders = { "x-user-staging-id": "00000000-0000-0000-0000-000000000000" }`.
The library merges `requestHeaders` over its own headers on every feed and
download request, so every install sends the same constant. The library still
writes `.updaterId` locally; it never leaves the machine and its value is
redacted from logs. If staged rollouts are ever wanted, this decision has to
be revisited, since every install now falls in the same rollout bucket.

## Release notes

`releaseNotes` from the feed can be a string, an array of `{ version, note }`,
or missing. The service normalizes it to a plain string or `null`: array entries
become `## <version>\n\n<note>` blocks, malformed entries are skipped, CRLF is
normalized, NUL characters are removed, and the result is capped at 20,000
characters. The service stores the text as data and never evaluates it. With the GitHub
provider and no notes in `latest.yml`, the library takes the notes from the
releases Atom feed, which is HTML. Notes may therefore contain HTML markup,
and the UI has to show them as text, never as HTML.

The renderer converts them with `releaseNotesMarkdown()`
(`components/releaseNotes.ts`), a pure string function with no DOM parsing:
when the notes contain HTML tags, `script`/`style` blocks and comments are
dropped, headings, list items and paragraph breaks become Markdown structure,
`<a>` elements become Markdown links only when the target is a well-formed
`https:` URL (anything else keeps only its text), images become their alt
text, all other tags are stripped and entities are decoded to literal text.
The result goes to the shared `Md` component with `linkPolicy="https-only"`:
raw HTML is shown as text (react-markdown never renders it), only `https:`
links are clickable and open in the browser, and images are shown as labels,
so rendering the notes never loads a remote resource.

## Build configuration and generated files

`apps/desktop/electron-builder.yml`:

```yaml
publish:
  - provider: github
    owner: albertofa
    repo: cw-code
    releaseType: draft
generateUpdatesFilesForAllChannels: true
```

No token is in the config. `dist` and `dist:dir` keep `--publish never`, so
local builds never upload anything.

Verified with `pnpm --filter @cw-code/desktop dist` on electron-builder 26.15.3
(version `0.0.1-alpha.21`, 2026-09-24):

`dist/win-unpacked/resources/app-update.yml`:

```yaml
owner: albertofa
repo: cw-code
provider: github
releaseType: draft
updaterCacheDirName: '@cw-codedesktop-updater'
```

- No `publisherName` yet, so `electron-updater` skips the Authenticode
  publisher check and only verifies the sha512. `sign-windows.yml` injects `publisherName`
  at the signed build.
- `updaterCacheDirName` comes from the package name `@cw-code/desktop`.
  Downloads are cached under `%LOCALAPPDATA%\@cw-codedesktop-updater\pending`.

`dist/` update files:

- `latest.yml` with `version: 0.0.1-alpha.21`,
  `files[0].url: cw-code-Setup-0.0.1-alpha.21-x64.exe` (matches `nsis.artifactName`
  `${productName}-Setup-${version}-${arch}.${ext}`), `sha512` (base64, matches
  the installer bytes), `size`, `path`, `releaseDate`.
- `cw-code-Setup-0.0.1-alpha.21-x64.exe.blockmap` next to the installer.
  `electron-updater` needs the blockmaps of both the old and the new version
  for a differential download and falls back to a full download when either is
  missing. It first reuses `current.blockmap`, which it saves in its cache after
  each update. Without that file, it builds the old blockmap URL by replacing
  the new version string with the running version everywhere in the new
  installer's URL path, `/releases/download/v<new>/cw-code-Setup-<new>-x64.exe`
  becoming `.../v<old>/cw-code-Setup-<old>-x64.exe.blockmap`. That only resolves
  when the old release used the same tag and file naming and uploaded its
  blockmap. The legacy `v0.0.1-alpha.21` release has neither (its asset is
  `cw-code.Setup.0.0.1-alpha.21.exe`, no blockmap), so the first update from a
  legacy install is always a full download of about 100 MB.
  `previousBlockmapBaseUrlOverride` stays off; a full download is correct, just
  larger.
- No `alpha.yml`, even for an alpha version and with
  `generateUpdatesFilesForAllChannels: true`. In app-builder-lib 26.15.3,
  `computeChannelNames` returns only `publish.channel || "latest"` when
  `provider === "github"`, and the channel is not derived from the version for
  the GitHub provider. Alpha clients still work: they ask for `alpha.yml`, get a
  404, and fall back to `latest.yml` in the same release. The setting does
  apply to the generic provider (the update-test builds for the loopback feed).
  The release pipeline (`release.yml`) uploads a byte copy of `latest.yml` as
  `alpha.yml` on every release, so alpha clients never hit that 404.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `updateChannel` | `null` | `"stable"` or `"alpha"`; `null` until the first enabled start saves the channel derived from the running version |
| `updateBackgroundDownload` | `true` | Download an available update without asking; installing still needs a click |

Both are sanitized per field in `SettingsStore` (an invalid channel falls back
to `null`, a non-boolean flag to `true`) and the settings schema stays at
version 1: they are optional keys with defaults, so files written before them
load without a migration or a `.v1.bak`. Unknown keys are still preserved.
Main reads them when it creates the service and reapplies them whenever
`settings.set` receives either key.

## User interface

**Settings > Updates** shows the installed version and status, when the last
check ran, Check for updates (disabled with a reason while disabled, checking,
downloading or installing), Download when an update is available, Update and
restart when one is ready, the last error, the download progress, the channel
select (Stable / Alpha), the background download toggle and the release notes.
Switching an alpha build to Stable explains that it keeps running until a
stable release newer than it is published, because there is no downgrade.
Channel and download changes apply immediately, like binary picks.

**Sidebar footer indicator** (`components/UpdateIndicator.tsx`, view model in
`components/updateModel.ts`). Quiet while disabled, idle, checking or up to date.

| State | Shows | Action |
| --- | --- | --- |
| `available` | "cw-code X is available" | Download |
| `downloading` | progress bar, percentage and "The download is in progress" | none |
| `ready` | "cw-code X is ready" | Update and restart |
| `ready` with a retryable install error | the error | Try again |
| `ready` after the installer started but cw-code did not exit | "The installer was started; restart cw-code if it is still open" | none |
| `error` | the check or download error | Retry when `retryable`; otherwise the message says retrying will not help |
| restart pending / `installing` | "Restarting to update" | none; Later disabled |

Later hides the indicator until the state changes (phase, versions or error).
Everything is a native button, so it is reachable with Tab and activated with
Enter or Space. Only the title is an `aria-live` region; the reason a control
is disabled is visible text that the buttons reference with
`aria-describedby`. Progress uses `role="progressbar"`.

## Install flow

1. Update and restart is only offered in `ready`, and not after an install
   error that is not retryable. If a quit or restart flow is already open it
   does nothing except say so. The renderer takes the downloaded version and
   channel as the install target, sets `updateRestartPending` and re-reads
   `updates.state`; if the download already changed, it stops here without
   touching any session.
2. It runs `runShutdownFlow("update")` first. The installer is already
   downloaded at this point, so the prepare lease (120 s) is only held for the
   few calls that follow. The dialog appears only when something needs a
   decision: active turns in any session (Wait or Stop), open terminals (they
   will be closed) and unsaved files (Save, Discard or Cancel). For the update
   reason it also explains that cw-code closes, installs in the background and reopens,
   that projects, sessions and settings are kept, that live terminals stop and
   that nothing is resent. Cancel returns to normal use and nothing is
   installed.
3. With a token, the renderer re-reads `updates.state`. If the phase is no
   longer `ready` or the downloaded version or channel changed, it cancels the
   token (services come back) and shows "The update changed".
4. Otherwise it calls `updates.install({ version, channel, token })`. Main
   requires the coordinator's current reason to be `update` (a quit token is
   answered `invalid` and left alone), validates the arguments (`invalid`),
   queues the install behind any running
   check, then requires a downloaded update (`not-ready`), the same version,
   the same current or pending channel and no newer `available` version
   (`superseded`). Any rejection before the commit releases the token itself,
   so services are always restored.
5. Before the commit, main checks the cached installer (see
   [Installer pre-check](#installer-pre-check)). If it is missing the token is
   released and nothing is stopped for good.
6. The phase becomes `installing` and main runs
   `shutdown.commit(token, () => adapter.quitAndInstall(true, true))`, a silent
   install with a forced relaunch. The user already consented with Update and
   restart; the assisted wizard would otherwise show its install-mode page in
   the middle of an update and relaunch only from its finish page.
   `electron-updater` starts the installer with `--updated /S --force-run` and
   then calls `app.quit()`; the quit is approved because the coordinator is
   committing, so there is no second dialog.

### What the silent NSIS upgrade does

Checked against the app-builder-lib 26.15.3 templates
(`templates/nsis/assistedInstaller.nsh`, `multiUser.nsh`, `installer.nsi`,
`installSection.nsh`):

- **Install scope and directory are kept.** `.onInit` runs `initMultiUser`,
  which reads `InstallLocation` from `HKLM\Software\<APP_GUID>` and
  `HKCU\Software\<APP_GUID>`. Only a per-machine install selects per-machine
  mode; only a per-user install selects per-user mode. `setInstallModePerUser`
  / `setInstallModePerAllUsers` then set `$INSTDIR` from that
  `InstallLocation`, so a custom directory chosen at first install is reused.
  With both a per-user and a per-machine install present (or neither), it
  falls back to per-user because `perMachine` is not set in
  `electron-builder.yml`. The installer is not given `/D=`, so nothing
  overrides the directory.
- **Per-machine installs still elevate.** The install section checks
  `$hasPerMachineInstallation == "1"` and `${Silent}` and, when not admin, runs
  `UAC_RunElevated`, so Windows shows the UAC prompt. If the user declines
  (1223) the outer installer quits and nothing is installed. cw-code has
  already quit by then and is not relaunched; starting it by hand shows the
  old version with the update still `ready`.
- **No installer window.** `SpiderBanner` and the wizard pages are skipped in
  silent mode, so the user sees cw-code close and, after the copy, reopen.
- **Relaunch.** The assisted template starts the app when `${isForceRun}` and
  `${Silent}` are both true, which is the case with `--force-run /S`.
- **`--updated`** keeps user data during the old version's uninstall step and
  skips the pages that only a fresh install shows.

## Installer pre-check

`electron-updater` spawns the installer asynchronously and calls `app.quit()`
right away, so a cached installer that disappeared (cleaned temp folder,
antivirus quarantine) would close cw-code without installing anything. Before
the commit, `UpdateService.install` therefore checks the file the library
reported in its `update-downloaded` event (`downloadedFile`, recorded by the
adapter with the size of the matching `files[]` entry from the feed):

- it must exist and be a regular file;
- its size must match the feed size, when the feed reported one.

If any check fails, or no downloaded file was reported for that version, the
token is released, the result is `not-ready`, and the state goes back to
`available` with `downloadedVersion` cleared and a retryable `download` error:
"The downloaded update is missing; download it again". Download (or a
background download on the next check) fetches it again, and
`electron-updater` re-validates its cache by sha512 before reusing anything.

After the restart, projects, settings and resume cursors are on disk as
before. Interrupted turns stay `holding`/interrupted and are never restarted.

## Failure recovery

- `quitAndInstall` failing synchronously (for example no cached installer:
  `electron-updater` emits an error instead of throwing, and the adapter turns
  that error into an exception) makes the commit fail at once. The coordinator
  recovers the drivers and terminal pool, and the service returns to `ready`
  with `error.context` `install`, retryable.
- A process that is still alive 30 s after `quitAndInstall` returned (the
  installer may be running, or the quit was blocked) gets the same service
  recovery, but the install error is not retryable: "The installer was
  started; restart cw-code if it is still open". `electron-updater` latches
  `quitAndInstallCalled` once an installer was spawned, so a second call would
  silently do nothing. From then on the service refuses installs, checks and
  channel changes with that message, the UI hides Update and restart, and a
  restart of cw-code clears it.
- The library's `app.quit()` fires `before-quit`, which disposes services.
  `UpdateService.dispose()` does nothing while the phase is `installing`, so if
  cw-code survives the exit timeout the updater is still alive to report the
  failure instead of leaving a dead UI.
- A token that was not committed within the 120 s lease is recovered by the
  coordinator; main sends `shutdown.expired` and a stale dialog closes with a
  message. A later install call with that token fails and restores `ready`.
- The renderer shows one sticky toast per failure. Its id is derived from the
  message, so retrying into the same failure updates that toast instead of
  stacking new ones. Update and restart stays available for a retry when the
  error is retryable.
- `autoInstallOnAppQuit` is always false (asserted in
  `ElectronUpdaterAdapter.test.ts`), so closing the window, quitting, `SIGINT`
  or an OS session end never runs the installer.

## Verification

Automated (vitest): `UpdateService.install.test.ts` (install contract with the
real coordinator and fakes: validation, update-reason tokens only, not-ready,
superseded, commit through the coordinator, dispose skipped while installing,
non-retryable failure after the installer started, retryable failure before,
disabled builds, scheduled checks postponed during a shutdown, background
download turned on while available, missing / non-file / wrong-size /
unreported installer back to `available`, no install from other operations),
`ElectronUpdaterAdapter.test.ts` (silent install flags, synchronous failure,
downloaded file and feed size, `autoInstallOnAppQuit` off), `updatePreferences.test.ts` (including the
first-run channel freeze), `SettingsStore.test.ts` (defaults, sanitize, no
migration), `updateFlow.test.ts` (token released on a state mismatch or an IPC
throw, one toast per failure, pending and open-flow guards),
`updateThrottle.test.ts`, `updateChannel.test.ts`, `releaseNotes.test.ts` and
`shutdownFlow.test.ts` (expired lease).

Manual checklist, pending. Run it with the local feed server and update-test
build ([update-testing.md](update-testing.md)) in a disposable Windows environment,
never against the live install:

- [ ] Keyboard only: Tab reaches the sidebar indicator and every Settings >
  Updates control; Enter/Space activates them; Escape closes Settings and the
  shutdown dialog.
- [ ] Progress: background download shows the bar in the sidebar and Settings
  without flicker; the percentage advances in steps.
- [ ] Errors: offline check shows "Could not reach the update server" with
  Retry; a failed download shows Retry; a non-retryable error shows no Retry.
- [ ] Opt-out: with background downloads off, an available update shows
  Download and nothing downloads until it is clicked; turning the toggle back
  on starts the download.
- [ ] Later hides the indicator; it comes back when the state changes.
- [ ] Channel changes: stable to alpha finds the newer alpha; alpha to stable on
  an alpha build explains the wait and offers nothing older; the choice survives
  a restart.
- [ ] Shutdown decisions for reason update: no blockers restarts directly;
  active turn Wait, then Stop; terminal listed as closed; dirty file Save,
  Discard, and a failing save cancels; Cancel returns to normal use; timeout
  Force stop and Cancel; leaving the timeout dialog open for 120 s closes it
  with a message.
- [ ] A superseded update (new version published while the dialog is open)
  cancels the restart and restores services.
- [ ] Missing installer: delete the cached installer under
  `%LOCALAPPDATA%\@cw-codedesktop-updater\pending` (or the update-test build's
  cache) before clicking Update and restart. cw-code does not close; the
  indicator shows "The downloaded update is missing; download it again" with
  Download, and after downloading, Update and restart works.
- [ ] Successful silent update: no installer window appears, cw-code closes,
  reopens by itself on the new version (from `--force-run`), and projects,
  settings and resume cursors are intact; interrupted turns are not resent.
  Record how long the gap between close and reopen is.
- [ ] Silent upgrade keeps the install scope and directory: repeat for a
  per-user install in the default folder, a per-user install in a custom
  folder, and a per-machine install. After the update, the uninstall entry is
  still under the same hive (HKCU / HKLM) and `InstallLocation` is unchanged.
- [ ] Per-machine install: Update and restart shows the UAC prompt. Accepting
  it updates and relaunches cw-code. Declining it: nothing is installed,
  cw-code stays closed; starting it by hand shows the old version, still
  `ready`, and the next Update and restart works. If cw-code is still open
  after 30 s, the indicator shows "The installer was started; restart cw-code
  if it is still open".
- [ ] Leave cw-code running after a restart that did not exit (block the quit):
  after 30 s there is no Try again, and Check for updates reports the same
  message until cw-code is restarted.
- [ ] First start of an alpha build with no saved channel: `cw-settings.json`
  gets `"updateChannel": "alpha"`; a later stable build installed through alpha
  keeps offering alphas.
