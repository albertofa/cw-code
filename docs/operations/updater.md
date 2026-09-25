# Auto-updater

cw-code checks GitHub Releases of `albertofa/cw-code` for newer Windows builds
and downloads them with `electron-updater` 6.8.9. The main process runs the
updater. The renderer can only read state and ask for actions through the
preload bridge. It never passes a feed URL, a file path, or an executable.

Nothing in the app runs an installer yet. `quitAndInstall` exists on the
adapter interface and is never called. The safe-install flow (shutdown
coordinator, user confirmation) arrives in step 05.

## Architecture

All updater code is in `apps/desktop/src/main/updates/`:

| File | Role |
| --- | --- |
| `updateState.ts` | Pure reducer `reduceUpdate(state, event)` plus version helpers (`compareVersions`, `channelOfVersion`, `isEligible`), release-notes normalization. No I/O. |
| `UpdateService.ts` | Serialized operation queue, request dedupe, disabled detection, scheduling, typed action results, redacted logging. The clock, scheduler, random source, file checks and adapter are injected. |
| `ElectronUpdaterAdapter.ts` | The only file that imports `electron-updater`. Implements the `UpdaterAdapter` interface the service depends on. |
| `updateLog.ts` | Log and error redaction, error classification (retryable or not). |

The contract types live in `packages/contracts/src/updates.ts`.

`main/index.ts` creates the service in `createServices()`, so it exists only in
normal startup. Recovery mode never creates it. The service is disposed on
`before-quit`. The adapter, and with it the `NsisUpdater` instance, is created
lazily on the first check, so disabled builds never create an updater object.

### IPC

| Channel | Direction | Payload |
| --- | --- | --- |
| `updates.state` | invoke | returns `UpdateState` |
| `updates.check` | invoke | returns `UpdateActionResult` |
| `updates.download` | invoke | returns `UpdateActionResult` |
| `updates.setChannel` | invoke `{ channel }` | returns `UpdateActionResult`; anything other than `"stable"`/`"alpha"` returns code `invalid` |
| `updates.changed` | main → renderer event | `UpdateState` |

Renderer: `window.cw.updates.{getState, check, download, setChannel, onChanged}`
and the `appStore` fields `updates`, `subscribeUpdates()`, `applyUpdateState()`,
`checkForUpdates()`, `downloadUpdate()`, `setUpdateChannel()`.
`subscribeUpdates()` subscribes to `updates.changed` first and then fetches the
snapshot. Every state carries a `seq` that increases on each change. The store
drops any state whose `seq` is lower than the one it holds, so a late snapshot
cannot overwrite a newer event. Action results carry a state and go through the
same rule.

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
| `installing` | Reserved for step 05. Never entered in this step. |
| `error` | The last check or download failed; `error.context` is `check` or `download` and `error.retryable` says whether retrying can help. |

Rules the reducer enforces:

- A ready download survives later failed checks, empty checks, and checks that
  report an older version. The phase stays `ready`. A failed check still sets
  `error` so the UI can show it.
- A newer version found while one is ready moves the phase to `available`. The
  older `downloadedVersion` stays usable. If downloading the newer one fails,
  the phase returns to `ready`.
- Results that do not fit the current phase (a check result when not checking,
  progress when not downloading, a download result for a different version) are
  ignored without changing `seq`.
- Changing the channel drops `availableVersion` and `downloadedVersion` when
  the new channel does not allow them, and clears progress and error.

`UpdateActionResult` codes: `disabled`, `busy` (a download holds the lock),
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
- A check requested while a download is queued or running returns `busy`
  immediately instead of waiting behind a long download.
- A download requested during a check waits for the check and then evaluates
  the fresh state.
- `setChannel` bumps a channel generation and cancels the active download
  immediately through its `CancellationToken`, then queues the channel change.
  A download that was queued under the old generation returns `superseded`
  without starting. Progress that arrives after the cancel is dropped, because
  it no longer matches an active download operation. After the change, the
  service queues a check on the new channel.
- Setting the channel that is already active returns `ok` and cancels nothing.

## Channels

| Channel | `allowPrerelease` | `electron-updater` channel | Accepts |
| --- | --- | --- | --- |
| `stable` | false | `latest` | Stable `X.Y.Z` newer than the running version |
| `alpha` | true | `alpha` | Stable or `X.Y.Z-alpha.N` newer than the running version |

- The default channel is derived from the running version
  (`0.0.1-alpha.21` → `alpha`). Step 05 persists the user's choice; in this step
  `setChannel` is in memory only.
- The adapter sets `allowDowngrade = false` after setting `channel`, because the
  `electron-updater` channel setter turns downgrades on. A unit test fails if
  that order is reversed.
- On top of the library's own checks, the service runs `isEligible()` on every
  reported version: a prerelease on stable, a version at or below the running
  one, or a version that is neither `X.Y.Z` nor `X.Y.Z-alpha.N` is logged and
  treated as "no update". An alpha user who switches to stable therefore waits
  until a stable release newer than the running alpha exists.
- `autoDownload`, `autoInstallOnAppQuit`, `forceDevUpdateConfig` and
  `fullChangelog` are all false. Signature and checksum verification and
  differential download keep the library defaults (`verifyUpdateCodeSignature`
  is not touched).

How the GitHub provider resolves releases (from the 6.8.9 source):

- Stable (`allowPrerelease` false): `https://github.com/albertofa/cw-code/releases/latest`,
  that is, the newest non-prerelease, non-draft release. That release's
  `latest.yml` is fetched. If no stable release exists, the check fails
  with `ERR_UPDATER_LATEST_VERSION_NOT_FOUND` and the state shows a retryable
  error.
- Alpha (`allowPrerelease` true): the releases Atom feed. It takes the newest
  release whose tag is valid semver and whose prerelease tag is empty, `alpha`
  or `beta`, then fetches `alpha.yml` from that release. If `alpha.yml` is
  missing, it falls back to `latest.yml`.

## Schedule

- First check: 45 s ± 15 s after `start()` (called right after IPC is
  registered).
- After a successful check: every 6 h ± 10 %.
- After a failed check: exponential backoff 5 min, 10 min, 20 min, ... capped at
  6 h (± 10 % jitter, never above the cap). A success resets it.
- A manual check skips the schedule but not the lock, and resets the timer.
- A timer that fires while a download holds the lock reschedules itself for the
  regular interval.
- `dispose()` cancels the timer and any active download, detaches adapter
  listeners, disposes the adapter and stops publishing state.

`autoDownload` is a policy flag on the service (`setAutoDownload`). It is false
in this step. When true, a check that finds an available update queues a
download. Step 05 feeds it from the persisted setting.

## Disabled cases

Checked once at construction, in this order:

| Condition | `disabledReason` |
| --- | --- |
| `!app.isPackaged` (dev, `electron-vite dev`) | Updates are disabled in development builds |
| `process.resourcesPath/app-update.yml` missing | No update feed is configured for this build |
| No `Uninstall cw-code.exe` next to `process.execPath` (portable copy, `win-unpacked`) | This copy of cw-code was not installed with the Windows installer |

Every action then returns code `disabled` with that message.

## Logging and redaction

Updater lines go to the main-process console with an `[updates]` prefix.
`electron-updater`'s own logger is routed through the same sink with an
`electron-updater:` prefix. Every line passes through `redactUpdateText`, which:

- removes URL credentials, query strings and fragments;
- masks GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`),
  `Bearer`/`Basic` values and `authorization|token|password|secret = value` pairs;
- replaces the home directory (either slash style) with `~`, and any other
  `X:\Users\<name>` with `X:\Users\<user>`;
- caps each line at 2,000 characters (the GitHub provider can dump a whole
  releases feed into an error).

Error messages shown in state use the first line only, redacted, capped at 300
characters. Chromium network errors (`net::ERR_INTERNET_DISCONNECTED`, name
resolution, timeouts, proxy failures) become "Could not reach the update
server (...). Check your connection and try again." Invalid signature, invalid
version, invalid or unsupported provider configuration, and disabled web
installer are not retryable. Everything else is.

Download progress is logged only at 25/50/75/100 %.

## Release notes

`releaseNotes` from the feed can be a string, an array of `{ version, note }`,
or missing. The service normalizes it to a plain string or `null`: array entries
become `## <version>\n\n<note>` blocks, malformed entries are skipped, CRLF is
normalized, NUL characters are removed, and the result is capped at 20,000
characters. The service stores the text as data and never evaluates it. With the GitHub
provider and no notes in `latest.yml`, the library takes the notes from the
releases Atom feed, which is HTML. Step 05 renders notes as Markdown with raw
HTML disabled.

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
  publisher check and only verifies the sha512. Step 07 injects `publisherName`
  at the signed build.
- `updaterCacheDirName` comes from the package name `@cw-code/desktop`.
  Downloads are cached under `%LOCALAPPDATA%\@cw-codedesktop-updater\pending`.

`dist/` update files:

- `latest.yml` with `version: 0.0.1-alpha.21`,
  `files[0].url: cw-code-Setup-0.0.1-alpha.21-x64.exe` (matches `nsis.artifactName`
  `${productName}-Setup-${version}-${arch}.${ext}`), `sha512` (base64, matches
  the installer bytes), `size`, `path`, `releaseDate`.
- `cw-code-Setup-0.0.1-alpha.21-x64.exe.blockmap` next to the installer.
  `electron-updater` looks for `<installer url>.blockmap` in both the old and
  the new release to do a differential download, and falls back to a full
  download if it cannot.
- No `alpha.yml`, even for an alpha version and with
  `generateUpdatesFilesForAllChannels: true`. In app-builder-lib 26.15.3,
  `computeChannelNames` returns only `publish.channel || "latest"` when
  `provider === "github"`, and the channel is not derived from the version for
  the GitHub provider. Alpha clients still work: they ask for `alpha.yml`, get a
  404, and fall back to `latest.yml` in the same release. The setting does
  apply to the generic provider (the step 06 loopback feed builds). The release
  pipeline (steps 08/09) decides whether alpha releases should also upload a
  copy of `latest.yml` as `alpha.yml` to avoid the extra 404.

## What step 05 adds

- `AppSettings.updateChannel` (null = derive from the running version) and
  `updateBackgroundDownload` (default true), sanitized in `SettingsStore`. The
  channel feeds `setChannel`; the download setting feeds `setAutoDownload`.
- `updates.install({ version, channel, token })`: validates the phase is
  `ready` and the version and channel still match (otherwise `superseded`),
  then runs the shutdown coordinator flow with reason `update` and calls
  `adapter.quitAndInstall(false, true)` inside `commit`. On failure it
  recovers and returns to `ready` with an error.
- UI: Settings "Updates" section, sidebar footer indicator, release notes
  rendered with raw HTML disabled and https-only links, throttled progress.
