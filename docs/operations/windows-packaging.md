# Windows packaging

cw-code ships to Windows x64 as an NSIS installer built with electron-builder. This
document is the maintained reference for that pipeline: installer identity, the
toolchain, the node-pty native binary, and how to package and verify a build.

## Installer identity

Audited from the released legacy installer `cw-code.Setup.0.0.1-alpha.21.exe`
(unsigned, published manually as a GitHub release asset) and its installed state,
read-only, without mutating the developer's live install:

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

Pinned in `apps/desktop/package.json`:

| Package | Version |
| --- | --- |
| electron | 36.9.5 |
| electron-builder | 26.15.3 (was 25.1.8) |
| electron-vite | 3.1.0 |
| node-pty | 1.1.0 |

`node-pty` ships N-API prebuilds for `win32-x64`, so `npmRebuild: false` never
requires a C++ toolchain to produce the Windows package. This is specific to the
`win32-x64` prebuilt binary path documented below — the Linux CI job (`verify`)
still compiles `node-pty` from source via `node-gyp` when it runs `pnpm install`,
since no Linux prebuild is bundled; that job is unaffected by `npmRebuild` (which
only governs `electron-builder`'s packaging step) and needs a working native
toolchain on the runner, which `ubuntu-latest` already provides.

### electron-builder 25 → 26 notes

Diffed `node_modules/app-builder-lib/scheme.json` between the two versions to find
config-schema changes relevant to this app:

- `win.sign`, `win.certificateFile`/`certificatePassword`/`certificateSha1`/
  `certificateSubjectName`, `win.publisherName`, `win.signDlls`,
  `win.signingHashAlgorithms`, `win.rfc3161TimeStampServer`/`timeStampServer`,
  `win.additionalCertificateFile` were all removed in favor of `win.signExecutable`
  and the broader `signtoolOptions`/Azure signing configuration. None of these were
  set in our config, so this was a no-op for step 01. Production signing does not
  use them either: electron-builder never signs (`win.signExecutable: false`), and
  only `signtoolOptions.publisherName` is injected in CI. See
  [windows-signing.md](windows-signing.md).
- Top-level `includeSubNodeModules` was removed; not used here.
- `includePdb` now defaults to `false` (previously PDB files could leak into the
  package unless manually filtered). This is why `*.pdb` files that ship alongside
  node-pty's prebuilds (`conpty.pdb`, `pty.pdb`, `winpty.pdb`, ...) do not need an
  explicit `files` exclusion — 26 already drops them.
- New `nativeRebuilder` option (`legacy` | `parallel` | `sequential`, default
  `sequential`) controls how native deps are rebuilt when `npmRebuild: true`. Not
  used here since `npmRebuild` stays `false`.
- NSIS gained `buildUniversalInstaller`, `customNsisResources`, and four
  `uninstallUrl*` keys; none required for this app yet.

All NSIS keys already used in `electron-builder.yml`
(`oneClick`, `perMachine`, `allowToChangeInstallationDirectory`, `differentialPackage`,
`artifactName`) are present unchanged in the 26.x schema.

## node-pty native binary

`node-pty`'s own loader (`lib/utils.js`) looks for a native module first in
`build/Release`, then `build/Debug`, then `prebuilds/<platform>-<arch>`. On a
`npmRebuild: false` install there is no compiled `build/Release/*.node`, so the
module that actually loads at runtime always comes from
`prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node`.

The native ConPTY backend (`src/win/conpty.cc`) resolves `conpty.dll` relative to
the *loaded* native module's own directory (`GetModuleFileNameW` on the addon,
then `conpty\conpty.dll`), so `prebuilds/win32-x64/conpty/{conpty.dll,
OpenConsole.exe}` must ship next to `prebuilds/win32-x64/conpty.node` — they are
unpacked together.

`electron-builder.yml` reflects this:

- `asarUnpack: ["node_modules/node-pty/prebuilds/win32-x64/**"]` forces the
  Windows x64 native binaries (and their nested `conpty/` folder) out of `app.asar`
  into `app.asar.unpacked`, since Windows cannot `LoadLibrary`/`CreateProcess` a
  DLL or EXE living inside an asar archive.
- Because electron-builder unpacks the *entire* containing package directory once
  any file under it is asar-unpacked, `files` carries explicit `!` excludes for
  `node-pty`'s `deps/`, `src/`, `third_party/`, `scripts/`, `binding.gyp`, `typings/`,
  the leftover `build/` directory (a stale, unused copy of the ConPTY DLL — the real
  one node-pty loads is under `prebuilds/win32-x64/`), `lib/**/*.test.js` (node-pty's
  own unit tests, never imported at runtime), `lib/**/*.js.map` (source maps, not
  needed to run), and the non-Windows (`darwin-arm64`, `darwin-x64`, `win32-arm64`)
  prebuilds. Without these, the unpacked package ships winpty/conpty source, build
  scripts, test files, and other-platform binaries that Windows never uses. The
  packaged startup probe (below) is what confirms none of these excludes broke
  node-pty's actual `require("node-pty")` / spawn path.

## Packaging locally

```sh
pnpm --filter @cw-code/desktop dist       # electron-vite build + NSIS installer, --publish never
pnpm --filter @cw-code/desktop dist:dir   # same, but --dir (unpacked win-unpacked/ only, for diagnostics)
```

Both always pass `--publish never`; no credentials are read or required. Root
`pnpm dist` forwards to the desktop package's `dist` script.

Local builds are **unsigned and non-production**. `win.signExecutable: false` stops
electron-builder from signing any file. Without a certificate in the environment, no
`publisherName` is written to `app-update.yml`, so updater signature verification is
off in these builds. If `CSC_LINK`/`WIN_CSC_LINK` is set, electron-builder can still
read that certificate to fill in `publisherName`, even though it signs nothing. Keep them
unset locally. Signed releases only come from `.github/workflows/sign-windows.yml`; see
[windows-signing.md](windows-signing.md).

## Verifying a build

```sh
node scripts/verify-windows-package.mjs [--dist <dir>]
```

Defaults to `apps/desktop/dist`. It checks, and prints as JSON plus a human
summary (also written to `<dist>/verify-windows-package.json`):

- the installer `cw-code-Setup-<version>-x64.exe` and its `.blockmap` exist. The
  version is discovered from the installer filename actually present in `<dist>`
  (falling back to `apps/desktop/package.json` if that is ambiguous), so this
  works whether the build used the default version or a CI override such as
  `-c.extraMetadata.version=...` (see the upgrade tests below);
- `win-unpacked/cw-code.exe` exists;
- `app.asar` exists and contains `out/main/index.js` (via `@electron/asar` if it
  can be resolved from the installed toolchain; otherwise this check is skipped
  with a warning, never a hard failure);
- node-pty's `win32-x64` native binary is present under `app.asar.unpacked`;
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
main window's first `did-finish-load`, it loads `node-pty` (the same lazy dynamic
import `PtyPool` uses), spawns `cmd.exe /c exit 0`, waits up to 10s for it to
exit, and runs `checkCliVersions` (missing CLIs are reported in the result, never
thrown). It writes a JSON result — `{ appVersion, electron, platform, arch,
nodePty: { loaded, spawned, exitCode, error }, rendererLoaded, cliChecks,
durationMs }` — to `CW_PACKAGE_PROBE_OUT` and exits the process (`0` if the
renderer loaded, `1` otherwise). The result shape is pure and covered by
`packageProbe.test.ts`; the Electron glue in `main/index.ts` is a thin hook.

### CI-only install/upgrade modes

Two additional verifier modes install and uninstall the packaged app and refuse
to run unless `CI=true` (GitHub Actions sets this by default) or
`--disposable-environment` is passed explicitly — never on a developer machine.

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
- `--upgrade-from <legacy-installer.exe>` [`--custom-dir <dir>`] [`--per-machine`]:
  installs the legacy installer first (per-user default location, a caller-given
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
  empty pre-upgrade), and all four seeded files still exist with byte-identical
  content. This only runs safely because it's gated to a disposable environment —
  it writes to the real per-user cw-code data paths on the runner.

Because the legacy release and the default `apps/desktop/package.json` version
can be equal, the CI job packages the "new" installer for these tests with an
explicit, unambiguously higher version
(`pnpm --filter @cw-code/desktop exec electron-builder --win nsis --x64
--publish never -c.extraMetadata.version=0.0.2-ci.<run_number>`, applied only
in-memory during packaging — never committed to `package.json`), so the upgrade
assertions are meaningful. This calls `electron-builder` directly rather than
through the `dist` script: npm/pnpm only forward trailing `-- <args>` to a
script that references `"$@"`, and adding that to a `&&`-joined script would
break on Windows' `cmd.exe`, so passing extra electron-builder flags always goes
through `pnpm exec` instead of the `dist`/`dist:dir` scripts.

All of the above are exercised by the `windows` CI job
(`.github/workflows/ci.yml`): it builds the installer with the CI version
override, runs `--install`, downloads the legacy `v0.0.1-alpha.21` release asset
with the read-only `github.token`, then runs `--upgrade-from` three times (default
per-user path, `--custom-dir`, `--per-machine`) against it, and uploads the
installer, blockmap, and verifier JSON as a 7-day artifact. The job requests no
permissions beyond `contents: read`, never publishes, and has a 45-minute
timeout to bound the several install/uninstall cycles.
