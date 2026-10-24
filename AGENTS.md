# cw-code — Agent Guidance

## Product

cw-code is a T3-Code-style desktop shell where every prompt executes in the real
`claude` / `opencode` / `codex` CLI binaries, preserving subscription billing. No
SDK or AI-API calls for inference.

Layout is a single window: left sidebar with projects grouping their sessions,
center chat thread with tool-call cards and a usage/cost footer, right pane with
file editor, git diff view, and live terminal tabs embedding the real interactive
CLIs as a fallback for anything the headless chat cannot render.

Core behaviors:

- One window multiplexes unlimited parallel sessions; one active turn per session.
- The CLI is always the source of truth. The app stores only its own metadata
  (projects, titles, resume cursors). The app manages only sessions it created or the user
  explicitly imported through the session importer; it never adopts CLI-native sessions on
  its own, and the importer hides sessions cw-code already manages or started.
- History display is best-effort (local transcripts / server API); continuing a
  session always resumes full CLI context, independent of what history shows.

## Architecture

- `apps/server` (`@cw-code/server`): standalone Bun process that owns every operation —
  CLI drivers, sessions, git, GitHub, files, terminals, settings, shutdown. It serves one
  WebSocket (`/ws`) and is the only place business logic lives. Packaged as a
  `bun build --compile` binary with `node-pty` as a sidecar (`CW_NODE_PTY`).
- `apps/desktop`: Electron shell only — spawns and supervises its own server (never attaches
  to another instance's), owns the window, zoom, attention badge, native dialogs, OS
  open/reveal and auto-updates, and exposes them to the renderer as `window.cwDesktop` (`DesktopApi`).
- `apps/desktop/src/renderer`: the UI. Talks to the server only through `@cw-code/client`
  (`window.cw` is built from it in `renderer/src/server/createCwApi.ts`) and to the shell only
  through `window.cwDesktop`. It never spawns processes, touches the filesystem, or imports
  server code.
- `packages/contracts`: shared types only, no runtime values (resolves to `dist` at runtime).
  `packages/shared`: source-only runtime helpers usable by server, shell and UI
  (`@cw-code/shared/<module>`, incl. protocol constants). `packages/client`: `ServerClient`.
- Protocol: client sends `hello` (owner token from `~/.cw-code/userdata/server-token`,
  `PROTOCOL_VERSION`), then `call`s (method names like `sessions.create`; no id =
  fire-and-forget); the server answers `result`s and broadcasts `event`s. Payloads are JSON —
  no `Map`/`Set`/`Date`/binary (send base64). The server writes `userdata/server.json` and
  prints `CW_SERVER_READY <json>` when listening; a second server on the same home prints
  `CW_SERVER_RUNNING <json>` and exits 3 (the shell retries for ~6 s, then fails startup).

## Stack

- Bun monorepo (package manager, script and test runtime). UI: React 19 + zustand + xterm.js.
- Session metadata persists as atomic JSON under `~/.cw-code/userdata`.
  Logs live in `~/.cw-code/logs`, paste/preview attachments in
  `~/.cw-code/userdata/attachments`, worktrees in `~/.cw-code/worktrees`.
- Tests run on `bun test`; use `bun run test` (packages run sequentially; each sets its own flags and preload, helpers in `apps/*/tests`); builds via electron-vite, the server compile script, and electron-builder (Windows NSIS; Linux AppImage and deb).

## Guidelines

- Follow the `CliDriver` seam for anything CLI-related. Supporting a new CLI
  means adding a driver, never changing UI or orchestration code.
- New behavior goes in the server; the UI renders server state and sends intents. Keep a
  contract change in sync across all four layers: contracts type, server handler/event,
  client adapter (`createCwApi` / `CwApi`), store. Shell features follow the same rule with
  `DesktopApi`, shell IPC and preload.
- Assume several clients may be connected: server state changes must be broadcast, never
  returned only to the caller.
- Never parse CLI-internal file formats as truth; use them for display only and
  degrade gracefully when shapes drift.
- Normalize filesystem paths at storage boundaries; resolve executables through
  platform conventions before spawning; never auto-mutate user-visible state.
- Surface failures where the user can see them (in-tab/in-thread messages, dev
  log warnings). Silent empty results are bugs.
- Respect the native-module constraint: no dependency requiring C++ compilation
  (`node-pty`, compiled on Linux installs, is the one exception), and native-backed
  features must load lazily with a clear degraded message.
- Tests cover stable contracts only: parsers and mappers, session routing and
  isolation, filesystem sandboxing, path and binary resolution helpers.
  UI components and wiring are verified by typecheck and build, not unit tests.
- Never commit plans, mockups or design notes; keep them in the OS temp `agents-scratchpad`.
- Before finishing work: typecheck, full test suite, and production bundle build
  must all pass. Reproduce reported bugs against live state (stored metadata,
  real CLI behavior) before changing code.
