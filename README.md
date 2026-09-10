# cw-code

cw-code is an open-source Windows desktop shell for working with local AI coding
CLIs. Every prompt is executed by the installed CLI, so the CLI remains the
source of truth for authentication, subscriptions, sessions, and model access.
The application does not make SDK or hosted AI API calls for inference.

## Features

- Projects with multiple isolated sessions in one window.
- Chat history with tool-call cards, usage, and cost information.
- File editor, working-tree Git diff, and an embedded terminal.
- Headless turns plus a PTY fallback for interactive CLI features.
- Claude Code, OpenCode, and Codex drivers behind one application interface.

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
- App-owned session metadata is stored as atomic JSON in Electron's `userData`
  directory. CLI-native transcripts are read only for best-effort history.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local workflow and expectations.
Bug reports and focused pull requests are welcome.

## License

cw-code is available under the [MIT License](LICENSE).
