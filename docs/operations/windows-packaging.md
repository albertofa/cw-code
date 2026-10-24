# Windows packaging

cw-code ships to Windows x64 as an NSIS installer built with electron-builder. This
document is the maintained reference for that pipeline: installer identity, the
toolchain, the compiled server binary and its node-pty sidecar, and how to package and
verify a build.

## Installer identity

Audited from the legacy installer `cw-code.Setup.0.0.1-alpha.21.exe` (unsigned,
published manually as a GitHub release asset, removed from the releases page on
2026-09-29) and its installed state, read-only, without mutating the developer's
live install:

- `appId: com.cwcode.app`, `productName: cw-code`. Both are load-bearing: the NSIS
  upgrade GUID is a UUIDv5 electron-builder derives from `appId`.
- NSIS upgrade GUID `d6e18d04-bf35-5bfe-9145-b95301660833`, registered at
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\d6e18d04-bf35-5bfe-9145-b95301660833`
  (per-user scope; `UninstallString` carries `/currentuser`) and mirrored at
  `HKCU\Software\d6e18d04-bf35-5bfe-9145-b95301660833` (`InstallLocation`,
  `KeepShortcuts=true`, `ShortcutName=cw-code`). Never invent a new GUID or move
  this key — it is what lets a new installer upgrade in place instead of installing
  side by side.
- Executable `cw-code.exe`. Its `ProductName` VersionInfo field is `cw-code`;
  `CompanyName` was "GitHub, Inc." on the legacy build because neither `author` nor
  `copyright` were set in `apps/desktop/package.json` / `electron-builder.yml`, so
  Electron's own default metadata leaked through. Both are now set (see below).
- Electron `userData` resolves to `%APPDATA%\@cw-code\desktop`, derived from
  `apps/desktop/package.json`'s own `name` field (`@cw-code/desktop`), not from
  `productName`. Do not add a `productName`/`name` change that would move this path
  — it would orphan every existing user's session metadata.
- App-owned data lives under `~/.cw-code` (`userdata/{cw-code.db.json,
  cw-settings.json, skills.json, opencode-models.json, claude-commands.json,
  attachments/}`, `worktrees/`, `logs/`), independent of the Electron `userData`
  path and overridable with `CW_CODE_HOME`. The installer must never touch this
  tree; only the app itself reads and writes it.

### Per-user vs. per-machine

`nsis.perMachine` is explicit `false`: the installer stays an assisted (non-one-click)
installer that lets the user pick "only me" (per-user, HKCU, the common case audited
above) or "all users" (per-machine, HKLM, requires UAC elevation via the bundled
`elevate.exe`). Both paths existed on the legacy build and remain supported; this
config only makes the default explicit, it does not remove per-machine capability.
`allowToChangeInstallationDirectory: true` preserves custom install paths.

## Toolchain

Pinned in `apps/desktop/package.json` (node-pty is pinned in `apps/server/package.json`):

| Package | Version |
| --- | --- |
| electron | 36.9.5 |
| electron-builder | 26.15.3 (was 25.1.8) |
| electron-vite | 3.1.0 |
| node-pty | 1.1.0 |

The server is compiled with `bun build --compile`, so the Windows package does not rebuild
native modules against Electron: `npmRebuild: false` stays set, and
node-pty is never compiled for Electron's ABI. `node-pty` ships N-API prebuilds for
`win32-x64`, so producing the Windows package never requires a C++ toolchain. This is
specific to the `win32-x64` prebuilt binary path documented below — the Linux CI job
(`verify`) still compiles `node-pty` from source via `node-gyp` when it runs `bun install`,
since no Linux prebuild is bundled; that job needs a working native toolchain on the
runner, which `ubuntu-latest` already provides. The Linux packages are documented in
[linux-packaging.md](linux-packaging.md).

### electron-builder 25 → 26 notes

Diffed `node_modules/app-builder-lib/scheme.json` between the two versions to find
config-schema changes relevant to this app:

- `win.sign`, `win.certificateFile`/`certificatePassword`/`certificateSha1`/
  `certificateSubjectName`, `win.publisherName`, `win.signDlls`,
  `win.signingHashAlgorithms`, `win.rfc3161TimeStampServer`/`timeStampServer`,
  `win.additionalCertificateFile` were all removed in favor of `win.signExecutable`
  and the broader `signtoolOptions`/Azure signing configuration. None of these were
  set in our config, so this was a no-op for the electron-builder 26 upgrade. Production signing does not
  use them either: electron-builder never signs (`win.signExecutable: false`), and
  only `signtoolOptions.publisherName` is injected in CI. See
  [windows-signing.md](windows-signing.md).
- Top-level `includeSubNodeModules` was removed; not used here.
- `includePdb` now defaults to `false` (previously PDB files could leak into the
  package unless manually filtered). The `*.pdb` files that ship alongside node-pty's
  prebuilds (`conpty.pdb`, `pty.pdb`, `winpty.pdb`, ...) are dropped earlier, when
  `apps/server/scripts/compile.ts` copies the sidecar.
- New `nativeRebuilder` option (`legacy` | `parallel` | `sequential`, default
  `sequential`) controls how native deps are rebuilt when `npmRebuild: true`. Not
  used here since `npmRebuild` stays `false`.
- NSIS gained `buildUniversalInstaller`, `customNsisResources`, and four
  `uninstallUrl*` keys; none required for this app yet.

All NSIS keys already used in `electron-builder.yml`
(`oneClick`, `perMachine`, `allowToChangeInstallationDirectory`, `differentialPackage`,
`artifactName`) are present unchanged in the 26.x schema.

## Server binary and node-pty sidecar

All operations run in `apps/server`, a standalone Bun WebSocket server that the Electron
shell spawns (`apps/desktop/src/main/serverProcess.ts`). `bun run build` in `apps/server`
(`scripts/compile.ts`) writes `apps/server/dist/`:

- `cw-code-server.exe`, from `bun build src/index.ts --compile --external node-pty`.
  node-pty is kept external and ships next to the executable as the sidecar below.
- `node_modules/node-pty/`, the sidecar: `package.json`, `LICENSE`, `lib/` without
  `*.test.js` and `*.js.map`, and `prebuilds/win32-x64/` without `*.pdb`. The build fails
  if `pty.node`, `conpty.node`, `conpty/conpty.dll` or `conpty/OpenConsole.exe` is missing.

`node-pty`'s own loader (`lib/utils.js`) looks for a native module first in
`build/Release`, then `build/Debug`, then `prebuilds/<platform>-<arch>`. The sidecar has
no `build/` directory on Windows, so the module that loads at runtime always comes from
`prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node`.

The native ConPTY backend (`src/win/conpty.cc`) resolves `conpty.dll` relative to
the *loaded* native module's own directory (`GetModuleFileNameW` on the addon,
then `conpty\conpty.dll`), so `prebuilds/win32-x64/conpty/{conpty.dll,
OpenConsole.exe}` must ship next to `prebuilds/win32-x64/conpty.node`.

`electron-builder.yml` reflects this:

- `extraResources` copies `apps/server/dist` to `resources/server/` in the installed app,
  with the sidecar at `resources/server/node_modules/node-pty`. Both are plain files
  outside `app.asar`, so Windows can `LoadLibrary`/`CreateProcess` the DLLs and the
  EXE. node-pty is no longer inside `app.asar`, and the `files`
  list is only `out/**` and `package.json`.
- The shell starts `resources/server/cw-code-server.exe` and sets `CW_NODE_PTY` to
  `resources/server/node_modules/node-pty/lib/index.js`, which is where the server's
  `PtyPool` loads node-pty from.
- `apps/desktop/build/afterPack.cjs` fails the build if `cw-code-server.exe` or
  `node_modules/node-pty/prebuilds/win32-x64/pty.node` is missing from the packed
  `resources/server/`.

The `dist` and `dist:dir` scripts of `apps/desktop` build the server first, so
`apps/server/dist` always exists when electron-builder runs. Running electron-builder
alone on a clean checkout fails in `afterPack`.

The packaged startup probe (below) confirms that the sidecar loads and spawns a PTY.

## Packaging locally

```sh
bun --filter @cw-code/desktop dist       # server build + electron-vite build + NSIS installer, --publish never
bun --filter @cw-code/desktop dist:dir   # same, but --dir (unpacked win-unpacked/ only, for diagnostics)
```

Both always pass `--publish never`; no credentials are read or required. Root
`bun run dist` forwards to the desktop package's `dist` script.

Local builds are **unsigned and non-production**. `win.signExecutable: false` stops
electron-builder from signing any file. Without a certificate in the environment, no
`publisherName` is written to `app-update.yml`, so updater signature verification is
off in these builds. If `CSC_LINK`/`WIN_CSC_LINK` is set, electron-builder can still
read that certificate to fill in `publisherName`, even though it signs nothing. Keep them
unset locally. Signed releases only come from `.github/workflows/sign-windows.yml`; see
[windows-signing.md](windows-signing.md).

## Verifying a build

```sh
bun scripts/verify-windows-package.mjs [--dist <dir>]
```

Defaults to `apps/desktop/dist`. It checks, and prints as JSON plus a human
summary (also written to `<dist>/verify-windows-package.json`):

- the installer `cw-code-Setup-<version>-x64.exe` and its `.blockmap` exist. The
  version is discovered from the installer filename actually present in `<dist>`
  (falling back to `apps/desktop/package.json` if that is ambiguous), so this
  works whether the build used the default version or a CI override such as
  `-c.extraMetadata.version=...` (see the upgrade tests below);
- `win-unpacked/cw-code.exe` exists;
- `app.asar` exists and contains `out/main/index.js`, and does not contain node-pty (via
  `@electron/asar` if it can be resolved from the installed toolchain; otherwise this check
  is skipped with a warning, never a hard failure);
- `win-unpacked/resources/server/cw-code-server.exe` exists;
- node-pty's `win32-x64` `pty.node` is present under
  `win-unpacked/resources/server/node_modules/node-pty/prebuilds/win32-x64/`;
- installer and asar sizes;
- a packaged startup probe (see below) run against `win-unpacked/cw-code.exe`
  with an isolated `CW_CODE_HOME`/`--user-data-dir` (a fresh temp directory per
  run — the developer's real `~/.cw-code` and Electron `userData` are never
  touched) and a `PATH` trimmed to Windows system directories only, so `claude`,
  `opencode`, and `codex` are guaranteed absent. The verifier fails with a clear
  diagnostic if the renderer did not load or node-pty did not spawn.

### Packaged startup probe

`apps/desktop/src/main/debug/packageProbe.ts` runs inside the packaged app only
when `CW_PACKAGE_PROBE_OUT` (an absolute file path) is set. ~3 seconds after the
renderer load, the shell calls `debug.packageProbe` on the server
(`apps/server/src/debug/packageProbe.ts`). The server loads `node-pty` (the same lazy
loader `PtyPool` uses, so it is measured from the sidecar the packaged app actually
uses), spawns `cmd.exe /c exit 0`, waits up to 10s for it to exit, and runs
`checkCliVersions` (missing CLIs are reported in the result, never thrown). If the server
did not start or the call fails, `nodePty` is reported as not loaded, with the reason in `error`. The shell writes
a JSON result — `{ appVersion, electron, platform, arch,
nodePty: { loaded, spawned, exitCode, error }, rendererLoaded, cliChecks,
durationMs }` — to `CW_PACKAGE_PROBE_OUT` and exits the process (`0` if the
renderer loaded, `1` otherwise). The result shape is pure and covered by
`packageProbe.test.ts`; the Electron glue in `main/index.ts` is a thin hook.

### CI-only install/upgrade modes

Two additional verifier modes install and uninstall the packaged app and refuse
to run unless `--disposable-environment` is passed explicitly. `CI=true` alone is
not enough; the CI workflow passes the flag, and it is never passed on a
developer machine.

`InstallLocation` is registered by electron-builder's NSIS template at
`registryAddInstallInfo` (`WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"
InstallLocation "$INSTDIR"`), i.e. `HKCU\Software\d6e18d04-...` for a per-user
install or `HKLM\Software\d6e18d04-...` for a per-machine one — **not** the
`...\Uninstall\d6e18d04-...` key, which only carries `DisplayName`,
`DisplayVersion`, `Publisher` (present only once `author`/`copyright` metadata is
set — empty on the legacy build), `UninstallString`, etc. The verifier reads
`InstallLocation` from the correct key and fails with a diagnostic if it is
missing.

Uninstalling silently and synchronously requires the NSIS `_?=<installDir>`
switch: without it, the uninstaller copies itself to `%TEMP%` and relaunches
there, returning control to the caller before the actual removal finishes, which
races the next install reusing the same identity. The verifier always runs
`Uninstall cw-code.exe /S _?=<installDir>`, removes the uninstaller's own exe
(which cannot delete itself while running) and the install directory, and polls
`InstallLocation` at the relevant registry key until it clears (bounded timeout,
diagnostic on timeout) before returning.

- `--install`: silent per-user install (`/S /D=<dir>`) into a temp directory,
  measures install duration, runs the packaged startup probe against the
  installed exe — a renderer that failed to load or a node-pty that failed to
  spawn is recorded as a failure, not just logged — then uninstalls as above.
- `--upgrade-from <base-installer.exe>` [`--custom-dir <dir>`] [`--per-machine`]:
  installs the base installer first (per-user default location, a caller-given
  `--custom-dir`, or per-machine `/allusers` — never combined), reads
  `InstallLocation`/`DisplayVersion`/`Publisher` from the applicable registry
  keys, seeds cw-code's **real** default data locations with sanitized fixture
  content (`%USERPROFILE%\.cw-code\userdata\cw-code.db.json` and
  `cw-settings.json`, a `marker.txt` under a fake
  `%USERPROFILE%\.cw-code\worktrees\<id>\`, and a `marker.txt` under
  `%APPDATA%\@cw-code\desktop`), installs the new installer over it with the same
  scope/location arguments (no `/D` — a real upgrade must auto-detect the
  existing install), then asserts: `InstallLocation` unchanged (and equal to
  `--custom-dir` when given), `DisplayVersion` changed and now matches the new
  build, `Publisher` now matches `apps/desktop/package.json`'s `author` (it was
  empty pre-upgrade), and all four seeded files are byte-identical after the
  installer. It then runs the startup probe against the installed exe with the
  seeded `CW_CODE_HOME` and the default Electron userData (no `--user-data-dir`),
  requires exit 0 and a loaded renderer, and compares the data semantically:
  project ids/roots/names, session ids/projects/resume cursors/worktree
  paths/branches, the seeded settings and unknown keys must survive, while an
  added `schemaVersion` and new backup files are ignored; marker files stay
  byte-compared. Seeding refuses any existing target that isn't an exact verifier
  fixture (`_fixture` / marker line of the form `cw-verify-<uuid>`), and cleanup
  removes only the files the run wrote and the directories it created, when
  empty. This only runs safely because it's gated to a disposable environment —
  it writes to the real per-user cw-code data paths on the runner.

The `windows` CI job (`.github/workflows/ci.yml`) builds the canonical installer
(`bun --filter @cw-code/desktop dist`), rejects any update autotest path in the
packaged `app.asar`, runs `--install` (silent install, packaged startup probe,
uninstall), and uploads the installer, blockmap and verifier JSON as a 7-day
artifact. The job requests no permissions beyond `contents: read`, never
publishes, and has a 45-minute timeout.

`--upgrade-from` is not run in CI: installed upgrade coverage comes from
`upgrade-test.yml` (including the `custom-dir` and `per-machine` scenarios) and
from the release pipeline's N -> N+1 gate (`release.yml`). `--upgrade-from`
remains for manual runs on a disposable VM, and the installer it points at must
still be downloadable when the run starts.
