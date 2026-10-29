# Linux packaging

cw-code ships to Linux x64 as an AppImage and a .deb built with electron-builder, in the
same gated GitHub release as the Windows installer. This document is the maintained
reference for the Linux packages: what they contain, how the launcher decides about
Chromium's sandbox, how the app handles the environment and its child processes on
Linux, and how CI verifies a build. The release flow is in [releases.md](releases.md),
the in-app updater in [updater.md](updater.md#linux-updates), Windows in
[windows-packaging.md](windows-packaging.md). Only x64 is built; there is no arm64
package and no macOS package.

## Artifacts

| File | Contents |
| --- | --- |
| `cw-code-<version>-x86_64.AppImage` | Self-contained build, runs from anywhere the user can execute it |
| `cw-code-<version>-amd64.deb` | Installs to `/opt/cw-code`, launcher at `/usr/bin/cw-code`, desktop entry and icons |
| `latest-linux.yml` | electron-updater channel file: the AppImage first (`path`, top-level `sha512`), the deb second |
| `alpha-linux.yml` | Byte copy of `latest-linux.yml`, added by `stage-release-set` (see [releases.md](releases.md#the-release-set)) |

The names come from `appImage.artifactName` and `deb.artifactName` in
`apps/desktop/electron-builder.yml`, and `releaseAssets.ts` expects exactly them. A
pre-release version keeps its hyphen in the file names; dpkg sees it as a tilde
(`0.0.1-alpha.23` installs as `0.0.1~alpha.23`), so a later stable version sorts above
its alphas.

Linux packages are not signed. Their integrity is the sha512 and size in
`latest-linux.yml`, which `electron-updater` checks on download; `signing.json` never
lists them.

## Building

```sh
bun install
bun --filter @cw-code/desktop dist:linux   # UI build + server compile + electron-vite build + AppImage and deb, --publish never
```

Build on Linux x64. `dist:linux` is `bun --filter @cw-code/ui build && bun --filter @cw-code/server compile
&& electron-vite build && electron-builder --linux AppImage deb --x64 --publish never`; output goes to
`apps/desktop/dist/`, the unpacked tree to `apps/desktop/dist/linux-unpacked/`.

The server compile step runs `apps/server/scripts/compile.ts`; the server's plain `build`
script only bundles `src/index.ts` into `apps/server/out/` as a quick check. All operations
run in that server, a Bun executable compiled with `bun build --compile --external node-pty`,
and the Electron shell spawns it. The compile step writes `apps/server/dist/cw-code-server` plus
the node-pty sidecar `apps/server/dist/node_modules/node-pty` (`package.json`,
`LICENSE`, `lib/` without `*.test.js` and `*.js.map`, and `build/Release/pty.node`).
electron-builder ships both through `extraResources` to `resources/server/`, outside
`app.asar`; node-pty is no longer inside `app.asar`. The shell
starts `resources/server/cw-code-server` and sets `CW_NODE_PTY` to
`resources/server/node_modules/node-pty/lib/index.js`.

The web UI ships once, at `resources/server/ui/`: `bun --filter @cw-code/ui build` writes
`apps/ui/dist`, and the compile step copies it to `apps/server/dist/ui` (and fails if
`apps/ui/dist/index.html` is missing). The packaged shell loads `resources/server/ui/index.html`
over `file://`; the server serves the same directory to browsers, finding `ui/` next to
`cw-code-server`. `app.asar` carries only the shell's main and preload bundles.

**Prerequisites for contributors.** `node-pty` 1.1.0 ships prebuilds for Windows and
macOS only, so on Linux `bun install` compiles it from source with `node-gyp`. You need
a C++ toolchain and Python 3 (`sudo apt-get install build-essential python3` on Debian
and Ubuntu) and Bun 1.4.4. This is the only place a native compile
happens: installs on Windows and macOS are unaffected. `electron-builder.yml` sets
`npmRebuild: false`, so packaging never recompiles; the server compile step copies the
`build/Release/pty.node` that the install produced, and it fails if that file is missing.

`apps/desktop/build/afterPack.cjs` runs for the Linux targets only and does two things.
It fails the build with "cw-code server file missing from the package" if
`resources/server/cw-code-server`, `resources/server/node_modules/node-pty/build/Release/pty.node`
or `resources/server/ui/index.html` is absent, so a package without a server, a terminal backend
or a UI can never be produced, and it
makes the server binary executable (`chmod 755`). It also installs the launcher described
under [Launcher and sandbox](#launcher-and-sandbox).

**glibc baseline.** The release builds on `ubuntu-22.04`, so both packages need glibc 2.35
or newer, and `pty.node` is linked against it. A distribution older than Ubuntu 22.04 or
Debian 12 will not run them. Building on a newer machine raises that floor; the CI and
release builds are the reference.

## AppImage

- **Runtime.** `toolsets.appimage: "1.0.3"` in `electron-builder.yml` selects the static
  AppImage runtime, so the AppImage needs no `libfuse2` on the host. It still mounts
  through FUSE when `/dev/fuse` and `fusermount3` or `fusermount` are usable; where they
  are not (a container, a minimal server), run it in extract-and-run mode, which
  `APPIMAGE_EXTRACT_AND_RUN=1` forces. `verify-linux-package.mjs` makes that choice
  itself and records which mode it used.
- **First launch.** The AppImage shows a license dialog the first time it runs
  (electron-builder embeds the license file it finds in `resources/`, here
  `LICENSE.txt`). Setting
  `APPIMAGE_SILENT_INSTALL` skips it; the updater's relaunch of the new AppImage and the
  package verifier both set it.
- **Environment.** AppRun exports `APPIMAGE`, `APPDIR`, `ARGV0`, `OWD` and prepends the
  mount to `PATH`, `LD_LIBRARY_PATH` and other variables. The app removes those before
  starting any child (see [Environment for child processes](#environment-for-child-processes)),
  and relaunches itself from the `APPIMAGE` path, because the executable inside the old
  mount is gone after a restart (`resolveAppImageRelaunch` in `appImage.ts`).
- **Updates.** See [updater.md](updater.md#linux-updates): the file is replaced in place,
  and renamed when its name carries a version.

## .deb

- **Layout.** Files go to `/opt/cw-code`. The post-install script links `/usr/bin/cw-code`
  (through `update-alternatives`) to `/opt/cw-code/cw-code`, which is the launcher below.
  The desktop entry is `cw-code.desktop`. `resources/package-type` inside the install says
  `deb`, which is how the updater knows to prefer the deb updater.
- **Depends** (`deb.depends`): `libasound2t64 | libasound2`, `libgtk-3-0t64 | libgtk-3-0`,
  `libnss3`, `libsecret-1-0`, `xdg-utils`, `libnotify4`, `libxss1`, `libxtst6`. The
  alternatives cover the t64 renames in Ubuntu 24.04 and Debian 13.
- **Metadata.** `maintainer` and `category: Development` come from the `linux` block.
- **Install and remove.** `apt-get install ./cw-code-<version>-amd64.deb` pulls the
  dependencies. `remove` deletes `/opt/cw-code/cw-code-bin` and the launcher; `purge`
  deletes the install directory. `~/.cw-code` is never touched.
- **AppArmor and the sandbox helper.** electron-builder's post-install script does two
  things that matter for the sandbox. If the host has no working user namespaces it sets
  `chrome-sandbox` to root 4755; otherwise it sets 0755, so on current distributions the
  helper is not setuid. If AppArmor is enabled and understands the bundled profile
  (AppArmor ABI 4.0, Ubuntu 24.04 and later), it installs the `cw-code` profile at
  `/etc/apparmor.d/cw-code`; the profile is `flags=(unconfined)` with a `userns` rule and
  attaches to `/opt/cw-code/cw-code`, so the launcher runs with user namespaces
  allowed. On Ubuntu 22.04 no profile is installed. The remove script unloads and deletes
  it. `verify-linux-package.mjs` records which mechanism the installed deb ended up with
  (`setuid-root`, `apparmor-profile` or `user-namespaces`).

## Launcher and sandbox

`afterPack.cjs` renames the real executable to `cw-code-bin` and writes `cw-code` as a
short POSIX `sh` script that decides one thing, whether to pass `--no-sandbox`, and then
`exec`s `cw-code-bin` with the original arguments. The deb's `/usr/bin/cw-code` link, the
desktop entry and the AppArmor profile all point at the script, not at `cw-code-bin`. The switch has to be on the command line before Chromium starts, and the
answer depends on the host (kernel sysctl, helper mode, AppArmor label), so it cannot
be decided inside the app.

The wrapper adds `--no-sandbox` only when all three of these hold:

1. its own AppArmor label (`/proc/$$/attr/apparmor/current`, or
   `/proc/$$/attr/current`) does not start with `cw-code ` (the process is not running
   under the deb's `cw-code` profile);
2. `chrome-sandbox` next to it is not owned by root with mode 4755;
3. `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` is `1`.

In every other case the sandbox stays on. This is the only situation where Chromium's
user-namespace sandbox is denied (Ubuntu 23.10 and later restrict unprivileged user
namespaces for programs without an AppArmor profile) and no setuid helper can take over:
without the flag the app would not start at all. Under the deb's profile the namespace
is allowed, and with a root-owned 4755 helper Chromium uses the helper, so neither
needs the flag. A user-run AppImage can have neither, because a FUSE mount or an
extracted tree never honours setuid and it has no AppArmor profile.

The AppImage has a second, independent rule: AppRun adds `--no-sandbox` itself when
`unshare -Ur true` fails on the host. The two rules do not coordinate, so an AppImage
can run unsandboxed for either reason; the package verifier checks both (below).

The packaged app records what happened (`probe.sandbox.noSandboxSwitch` and its own
AppArmor label), because Chromium rewrites its process title and `/proc/<pid>/cmdline`
cannot tell whether the flag was passed.

## Desktop identity

The window class is `cw-code` (`app.commandLine.appendSwitch("class", "cw-code")`), the
desktop name is `cw-code.desktop` (`app.setDesktopName`) and the desktop entry carries
`StartupWMClass: cw-code`, so the shell groups the window with its launcher and shows the
right icon. The icons are `apps/desktop/resources/icons/{16,32,48,64,128,256,512}` PNGs;
the window itself loads `icon.png` on Linux.

## Environment for child processes

- **Login-shell capture.** An app started from a desktop launcher has the session's
  environment, not the user's shell profile, so `PATH` and the CLIs the user installed
  there are missing. The capture runs in the server, not in Electron. On Linux and macOS,
  when the server was not started from a terminal (neither its stdout nor its stdin is a
  TTY; the shell starts it with piped output, so this holds for every launch from the
  shell), `shellEnvironment.ts` runs `$SHELL -ilc env` once, in its own process group,
  with a 5 second timeout (SIGTERM, then SIGKILL after 1 second). The server awaits it
  before it starts listening. It tries the account shell and `/bin/bash` next only when `$SHELL`
  cannot be spawned; a shell that starts and fails is not retried. The login `PATH` is
  merged in front of the current one (de-duplicated); `SSH_AUTH_SOCK`,
  `DBUS_SESSION_BUS_ADDRESS`, `WAYLAND_DISPLAY`, `XDG_*`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
  `NODE_EXTRA_CA_CERTS` and the proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`,
  `ALL_PROXY`, upper and lower case) are copied only when they are missing. A failure is
  reported in the crash log (prefix `[shell-env]`) with the tail of the shell's stderr,
  never silently.
- **AppImage sanitizing.** Every child the server starts (the CLIs, git, terminal PTYs, the
  login shell, `ps`) gets `sanitizedChildEnv(process.env, platform)`: on Linux it drops
  `APPIMAGE`, `APPDIR`, `ARGV0`, `OWD` and `CHROME_DESKTOP`, and, when both `APPIMAGE`
  and `APPDIR` were set, removes every `PATH`, `LD_LIBRARY_PATH`, `XDG_DATA_DIRS` and
  `GSETTINGS_SCHEMA_DIR` entry under the mount. Without it a CLI would load the app's
  bundled libraries or see the mount on its `PATH`. The same function is applied to
  the startup probe's PTY.

## Child processes

- **Process groups.** On POSIX, children are spawned detached, so each is a process
  group leader (`detachProcessGroup` in `processTree.ts`). Stopping one sends SIGTERM to
  the whole group, falls back to the single pid if the group is gone, and sends SIGKILL
  3 seconds later if anything in the group is still alive. A child that already exited
  (exit code or signal recorded) is never signalled, so a reused pid is never hit.
  Windows keeps `taskkill /T /F`.
- **Orphaned CLI servers.** OpenCode and Codex run as managed servers (`opencode serve`,
  `codex app-server`). Every one the cw-code server starts gets
  `CW_CODE_OWNER_PID=<cw-code server pid>` in its environment. When the cw-code server
  starts it lists processes with `ps -eo pid=,ppid=,args=`, reads `/proc/<pid>/environ`
  for the matching CLI servers, and kills one that has an owner pid and does not descend
  from it: the owner is gone, so it is an orphan of a crashed or killed instance. A CLI
  server owned by another running instance descends from that instance and is left alone,
  and one with no owner pid (started by hand) is never touched. Windows still reaps by
  missing parent.
- **Signals.** SIGINT and SIGTERM quit the shell through the existing no-dialog path, which
  stops the server; the server also stops itself on either signal.

## How CI verifies the packages

`scripts/verify-linux-package.mjs` is the install-and-start check for one build:

```sh
bun scripts/verify-linux-package.mjs --desktop-dir apps/desktop --dist apps/desktop/dist [--install-deb] --disposable-environment
```

It runs only on Linux, as a non-root user (Chromium refuses to start as root with the
sandbox on; `--install-deb` also needs passwordless `sudo`), needs `xvfb-run` and
`xauth`, and refuses to run without `--disposable-environment`. With `--install-deb` it
also refuses when a `cw-code` deb is already installed. It:

1. checks that the AppImage, the deb and `latest-linux.yml` exist, that the feed's
   version matches `apps/desktop/package.json`, and that `linux-unpacked/resources/server/`
   holds an executable `cw-code-server`, `node_modules/node-pty/build/Release/pty.node` and `ui/index.html`;
2. starts the AppImage under `xvfb-run` (FUSE mount, or extract-and-run when FUSE is not
   usable) with the packaged startup probe;
3. with `--install-deb`: `apt-get install`s the deb, checks the dpkg version, the
   `chrome-sandbox` file, `resources/package-type` and the launcher, starts
   `/usr/bin/cw-code` the same way, then `apt-get remove`s and `purge`s it and checks that
   nothing is left behind.

A launch passes when the app exits 0, the probe reports platform `linux`, the expected
`appVersion`, a loaded renderer, `startupMode: ready` and a node-pty that spawned and
exited 0 (measured by the server through `debug.packageProbe`), and every process in the app's process group is gone after the run (the
harness SIGKILLs the group).

The sandbox check compares what the app reported with what the host implies. The evidence
file `verify-linux-package.json`, written to `--dist` even when the run aborts, records
per launch `sandbox.app` (`noSandboxSwitch`, `apparmorLabel`), `sandbox.host`
(`apparmorRestrictUnprivilegedUserns`, `unprivilegedUsernsUsable`, and the owner and mode
of `chrome-sandbox`, or a note that it is inside the AppImage) and `sandbox.decision`
(`underAppProfile`, `setuidHelper`, `wrapperAddsNoSandbox`, `appRunAddsNoSandbox`,
`expectNoSandbox`, `consistent`, and a `verdict` such as "enabled: user namespaces under
the AppArmor profile" or "disabled: --no-sandbox (...)"). A launch where
`--no-sandbox` is present without a rule that explains it, or absent where a rule
requires it, fails the run.

Where it runs:

- `ci.yml`, job `linux`, a matrix of `ubuntu-22.04` and `ubuntu-24.04` (45 minutes, one
  run per OS): install, typecheck, test, build, `dist:linux`, the production-bundle
  assertion on `linux-unpacked/resources/app.asar`, then `verify-linux-package.mjs
  --install-deb`. Stock 24.04 restricts unprivileged user namespaces, 22.04 does not,
  so the two entries exercise the different sandbox paths; the evidence file shows what
  each runner actually had. It uploads `linux-package-<os>` for 7 days.
- `release.yml`, job `build-linux` (`ubuntu-22.04`, source checkout of the plan's SHA):
  the same steps, with the production-bundle gate taken from the workflow commit's
  tooling, then uploads the AppImage, the deb, `latest-linux.yml` and
  `verify-linux-package.json` for 30 days. `verify-candidate` copies that evidence into
  the release evidence.

Upgrades are tested separately, by the Linux production-bytes gate in
[update-testing.md](update-testing.md#linux-production-bytes).

## Local checks

On a Linux machine you do not use for work, or a VM:

```sh
bun --filter @cw-code/desktop dist:linux
bun scripts/verify-linux-package.mjs --desktop-dir apps/desktop --dist apps/desktop/dist --disposable-environment
```

Without `--install-deb` only the AppImage is started. Add it only where installing and
purging a `cw-code` package is acceptable. Do not run the verifier on a machine where you
use cw-code: the probe starts the packaged app.
