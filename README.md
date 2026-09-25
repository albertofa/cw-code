<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/brand/assets/lockup-primary.svg">
  <img src="design/brand/assets/lockup-dark.svg" alt="cw-code" width="280">
</picture>

# cw-code

A desktop workspace for Claude Code, OpenCode, and Codex.

Run sessions across projects, inspect files and Git diffs, and open real CLI
terminals. cw-code uses your installed CLIs and their authentication. Each CLI
handles inference, model access, and session continuation.

**Windows · Open source · Alpha**

[Releases](https://github.com/albertofa/cw-code/releases) ·
[Report an issue](https://github.com/albertofa/cw-code/issues) ·
[Contributing](CONTRIBUTING.md)

Alpha installers are on the [releases page](https://github.com/albertofa/cw-code/releases).
You can also build from source using the instructions below.

## Updating cw-code

In-app updates start with the first updater-enabled release, which is not
published yet. This section describes how it will work once it is.

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

- Windows for the packaged application.
- Node.js 24.x and pnpm 11.5.3 for development.
- At least one supported CLI installed and authenticated:
  - Claude Code `2.1.260` or newer (`claude`)
  - OpenCode `1.18.23` or newer (`opencode`)
  - Codex `0.153.4` or newer (`codex`)

The providers are optional. The app reports missing or outdated CLIs in its
settings instead of bundling them or their credentials.

## Development

```powershell
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm dist
```

`pnpm dist` creates the Windows installer. Native PTY support is loaded lazily;
if its binary does not match the Electron runtime, the app continues without
PTY tabs and shows a degraded-state message. To rebuild `node-pty` locally:

```powershell
pnpm --filter @cw-code/desktop exec electron-rebuild -f -w node-pty
```

## Architecture

- `apps/desktop` contains the Electron main process, preload bridge, and React
  renderer.
- `packages/contracts` contains shared types without runtime logic.
- CLI integrations implement the `CliDriver` seam and are isolated from UI
  orchestration.
- The renderer communicates with the main process only through the typed
  preload bridge.
- App-owned files live under `~/.cw-code`: session metadata as atomic JSON
  in `userdata/`, paste/preview attachments in `userdata/attachments/`,
  logs in `logs/`, worktrees in `worktrees/`.
  CLI-native transcripts are read only for best-effort history.

Claude turns use the CLI's stream JSON output. OpenCode runs a managed server
per project root and attaches turns to it. Codex uses its app-server protocol.
Interactive PTY tabs launch the real installed binaries for permissions,
commands, and features that headless output cannot represent.

## Privacy and security

cw-code runs local commands with access to the project directory and can display
their output in the application. Review CLI permissions and provider account
settings before using it with sensitive repositories. Never commit credentials,
transcripts, `.env` files, or generated output. OpenCode's optional
`OPENCODE_SERVER_PASSWORD` is read from the local environment and is not stored
by this project.

cw-code is not affiliated with Anthropic, OpenAI, or the OpenCode project.
Their names and products remain the property of their respective owners.

## Current limitations

- The editor is currently a plain textarea.
- Session title changes are local metadata only; there is no delete action.
- Git integration currently shows the working-tree diff without checkpoint
  revert.
- History rendering is best-effort and may omit thinking blocks or provider
  bookkeeping when provider formats change.
- The packaged target is Windows; other platforms may require adjustments.

## Branding and website

The selected identity is **Console C** with a violet app icon and an Inter
wordmark. See the [brand suite](design/brand/README.md),
[visual brand sheet](design/brand/brand-sheet.png).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local workflow and expectations.
Bug reports and focused pull requests are welcome.

## License

cw-code is available under the [MIT License](LICENSE).
