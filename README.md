<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/brand/assets/lockup-primary.svg">
  <img src="design/brand/assets/lockup-dark.svg" alt="cw-code" width="280">
</picture>

# cw-code

A desktop workspace for Claude Code, OpenCode, and Codex.

Run sessions across projects, inspect files and Git diffs, and open real CLI
terminals. cw-code uses your installed CLIs and their authentication. Each CLI
handles inference, model access, and session continuation.

**Windows · Linux · Open source · Alpha**

[Releases](https://github.com/albertofa/cw-code/releases) ·
[Report an issue](https://github.com/albertofa/cw-code/issues) ·
[Contributing](CONTRIBUTING.md)

Alpha builds are on the [releases page](https://github.com/albertofa/cw-code/releases).
You can also build from source using the instructions below.

## Installing

**Windows.** Run `cw-code-Setup-<version>-x64.exe`.

**Linux (x64).** Two packages, both on the releases page:

- **AppImage**, `cw-code-<version>-x86_64.AppImage`. Make it executable and run it:

  ```sh
  chmod +x cw-code-<version>-x86_64.AppImage
  ./cw-code-<version>-x86_64.AppImage
  ```

  It needs no `libfuse2`. On a system without a usable FUSE (a container, for
  example), start it with `APPIMAGE_EXTRACT_AND_RUN=1`. The first launch shows a
  license dialog. Updates replace the file in place and, when its name has a
  version in it, rename it to the new version's name, so point shortcuts at a
  copy named `cw-code.AppImage` if you want a stable path.
- **.deb**, `cw-code-<version>-amd64.deb`, for Debian and Ubuntu:

  ```sh
  sudo apt install ./cw-code-<version>-amd64.deb
  ```

  It installs to `/opt/cw-code` and adds a `cw-code` command and a launcher
  entry. Updating from inside the app asks for your password.

Both need glibc 2.35 or newer (Ubuntu 22.04, Debian 12 or later). The Linux
packages are not signed; check the sha512 in `latest-linux.yml` on the release
if you want to verify a download. Details are in
[linux-packaging.md](docs/operations/linux-packaging.md).

## Updating cw-code

In-app updates start with the first updater-enabled release, which is not
published yet. This section describes how it will work once it is. On Linux,
the AppImage and the .deb both update from inside the app (see
[Installing](#installing)).

- **Coming from v0.0.1-alpha.21 or older.** Those builds cannot update
  themselves. Download `cw-code-Setup-<version>-x64.exe` of the first
  updater-enabled release from the
  [releases page](https://github.com/albertofa/cw-code/releases) and run it
  once. It upgrades the existing install in place: same folder, same scope
  (only you or all users), and your projects, sessions, settings and worktrees
  in `~/.cw-code` stay as they are.
- **After that.** cw-code checks for updates in the background. Settings >
  Updates shows the installed version and lets you pick the Stable or Alpha
  channel and turn background downloads off. Alpha builds stay on the Alpha
  channel until you change it.
- **Installing.** Nothing installs until you click **Update and restart**.
  If turns are running, terminals are open or files are unsaved, cw-code lists
  them first and waits for your decision; Cancel keeps everything as it is. It then closes,
  installs silently and reopens on the new version. Interrupted turns are not
  resent. An install for all users asks for administrator approval.
- There is no automatic downgrade. Fixes always ship as a newer version.

## Features

- Run isolated sessions across projects in one window.
- Read conversations, tool output, and available usage/cost information.
- Inspect files and Git diffs.
- Open real CLI terminals for interactive features.
- Resume sessions using the CLI's saved context.

The app runs the installed CLIs rather than making SDK or hosted AI API calls
for inference. Provider usage limits and charges depend on your CLI and account
configuration.

## Requirements

- Windows or Linux (x64) for the packaged application.
- Bun 1.4.4 for development.
- At least one supported CLI installed and authenticated:
  - Claude Code `2.1.260` or newer (`claude`)
  - OpenCode v1 `1.18.31` or newer, or v2 `2.0.32` or newer (`opencode`).
    npm `opencode-ai` still ships v1; v2 comes from `npm i -g @opencode/cli` or
    the installer at `https://opencode.ai/v2/install`.
  - Codex `0.153.4` or newer (`codex`)

The providers are optional. The app reports missing or outdated CLIs in its
settings instead of bundling them or their credentials.

## Development

```powershell
bun install
bun run dev
bun run typecheck
bun run test
bun run build
bun run dist
```

`bun run dist` creates the Windows installer; on Linux,
`bun --filter @cw-code/desktop dist:linux` creates the AppImage and the .deb.
Both build the server first (`bun --filter @cw-code/server build`), which compiles
`apps/server` into `apps/server/dist/cw-code-server` with `node-pty` beside it as a
sidecar; the installers ship them under `resources/server/`.
On Linux, `bun install` compiles `node-pty` from source, so install a C++
toolchain and Python 3 first (`sudo apt-get install build-essential python3` on
Debian and Ubuntu). `node-pty` runs in the Bun server, not in Electron, so it is
never rebuilt for Electron. Native PTY support is loaded lazily; if the binary
fails to load, the app continues without PTY tabs and shows a degraded-state
message.

## Architecture

- `apps/server` is a standalone Bun WebSocket server that owns all operations:
  sessions, CLI drivers, PTYs, files, git, settings, and shutdown coordination.
- `apps/desktop` is the Electron shell (window, updater, native dialogs and a
  small set of IPC channels), the preload bridge, and the React renderer. The shell
  spawns the server and the renderer talks to it over the WebSocket.
- `packages/contracts` contains shared types without runtime logic;
  `packages/client` is the WebSocket client and `packages/shared` holds pure helpers
  used by more than one app or package.
- CLI integrations implement the `CliDriver` seam and are isolated from UI
  orchestration.
- The renderer reaches the server through the typed WebSocket client, and the
  Electron shell only through the typed preload bridge.
- App-owned files live under `~/.cw-code`: session metadata as atomic JSON
  in `userdata/`, paste/preview attachments in `userdata/attachments/`,
  logs in `logs/`, worktrees in `worktrees/`.
  CLI-native transcripts are read only for best-effort history.

Claude turns use the CLI's stream JSON output. OpenCode runs a managed server
per project root and attaches turns to it; the server's health check tells the
v1 and v2 wire protocols apart. On v2, cw-code loads a small plugin through
`OPENCODE_CONFIG_CONTENT` that adds the `todo` tool and, only where the native
question tool is denied, the `cw_ask` bridge. Codex uses its app-server protocol.
Interactive PTY tabs launch the real installed binaries for permissions,
commands, and features that headless output cannot represent.

## Privacy and security

cw-code runs local commands with access to the project directory and can display
their output in the application. Review CLI permissions and provider account
settings before using it with sensitive repositories. Never commit credentials,
transcripts, `.env` files, or generated output. Each managed OpenCode server
gets a random password for its lifetime; it is passed to the server process and
kept in memory, never written to disk.

cw-code is not affiliated with Anthropic, OpenAI, or the OpenCode project.
Their names and products remain the property of their respective owners.

## Current limitations

- The editor is currently a plain textarea.
- Session title changes are local metadata only; there is no delete action.
- Git integration currently shows the working-tree diff without checkpoint
  revert.
- History rendering is best-effort and may omit thinking blocks or provider
  bookkeeping when provider formats change.
- The packaged targets are Windows x64 and Linux x64 (AppImage and .deb); macOS
  and arm64 builds are not packaged.

## Branding and website

The selected identity is **Console C** with a violet app icon and an Inter
wordmark. See the [brand suite](design/brand/README.md),
[visual brand sheet](design/brand/brand-sheet.png).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local workflow and expectations.
Bug reports and focused pull requests are welcome.

## License

cw-code is available under the [MIT License](LICENSE).
