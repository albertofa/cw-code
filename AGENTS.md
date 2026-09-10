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
  (projects, titles, resume cursors). CLI-native sessions are never auto-imported;
  they appear in a separate discovered section and enter the app via explicit import.
- History display is best-effort (local transcripts / server API); continuing a
  session always resumes full CLI context, independent of what history shows.

## Stack

- pnpm monorepo: `apps/desktop` (Electron + React 19 + zustand + xterm.js),
  `packages/contracts` (shared types only, no runtime logic).
- Main/preload/renderer communicate exclusively through the typed preload bridge;
  the renderer never spawns processes or touches the filesystem.
- Session metadata persists as atomic JSON in the Electron userData directory.
- Tests run on vitest; builds via electron-vite and electron-builder (Windows NSIS).

## Guidelines

- Follow the `CliDriver` seam for anything CLI-related. Supporting a new CLI
  means adding a driver, never changing UI or orchestration code.
- Keep the main↔renderer contract in sync across all four layers whenever it
  changes: IPC handler, preload bridge, renderer types, store.
- Never parse CLI-internal file formats as truth; use them for display only and
  degrade gracefully when shapes drift.
- Normalize filesystem paths at storage boundaries; resolve executables through
  platform conventions before spawning; never auto-mutate user-visible state.
- Surface failures where the user can see them (in-tab/in-thread messages, dev
  log warnings). Silent empty results are bugs.
- Respect the native-module constraint: no dependency requiring C++ compilation,
  and native-backed features must load lazily with a clear degraded message.
- Tests cover stable contracts only: parsers and mappers, session routing and
  isolation, filesystem sandboxing, path and binary resolution helpers.
  UI components and wiring are verified by typecheck and build, not unit tests.
- Before finishing work: typecheck, full test suite, and production bundle build
  must all pass. Reproduce reported bugs against live state (stored metadata,
  real CLI behavior) before changing code.
