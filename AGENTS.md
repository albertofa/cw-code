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
  The same listener has a small HTTP surface (`transport/httpRoutes.ts`): `GET /api/info`
  (`{ app, version, protocol }`, unauthenticated), `POST /api/stop` (owner token as `Bearer`;
  rejects a cross-origin `Origin`) and, for every other path, the built UI as static files
  (read-only, no SPA fallback; unknown paths are 404). The UI directory is `--ui-dir`, else
  `ui/` next to the compiled binary, else `apps/ui/dist` when run from source; none found
  means no web UI (`ServerHost.webUi` is false). HTML responses carry a CSP built from the
  request `Host` (`script-src 'self'`, `connect-src` `'self'` plus that host's `ws:`/`wss:`).
- `apps/desktop`: Electron shell only — owns the window, zoom, attention badge, tray, native
  dialogs, OS open/reveal, connection profiles and auto-updates, and exposes them to the UI as
  `window.cwDesktop` (`DesktopApi`). On the local profile it spawns and supervises a server
  (see Keep-running); on a remote profile it only connects (see Connection profiles).
- `apps/ui` (`@cw-code/ui`): the UI, a standalone Vite + React app (`base: "./"`). Talks to
  the server only through `@cw-code/client` (`window.cw` is built from it in
  `src/server/createCwApi.ts`) and to the shell only through `window.cwDesktop`. It never
  spawns processes, touches the filesystem, or imports Electron, server code or `node:`
  built-ins (`src/boundaries.test.ts` enforces it). `window.cw.local` (open/reveal a path,
  data dir, native folder picker, harness trace) exists only when the UI runs in the shell on
  the local profile, and `window.cw.shell` (window controls, zoom, updates, connection
  profiles, stop-server-and-quit) only inside the shell; both are `null` otherwise, so
  local-only actions live in `cw.local`, shell-only ones in `cw.shell`, and the same UI also
  runs in a plain browser. The build (`apps/ui/dist`) ships once, at
  `resources/server/ui/`: `apps/server/scripts/compile.ts` copies it into the server dist and
  the packaged shell loads it from there over `file://`. In dev, electron-vite serves it with
  HMR as the shell's renderer.
- `packages/contracts`: shared types only, no runtime values (resolves to `dist` at runtime).
  `packages/shared`: source-only runtime helpers usable by server, shell and UI
  (`@cw-code/shared/<module>`, incl. protocol constants). `packages/client`: `ServerClient`
  and `TopicCache`.
- Protocol: client sends `hello` (owner token from `~/.cw-code/userdata/server-token`,
  `PROTOCOL_VERSION`), then `call`s (method names like `sessions.create`; no id =
  fire-and-forget); the server answers `result`s and pushes `patch`es and `event`s. Payloads
  are JSON — no `Map`/`Set`/`Date`/binary (send base64). The server writes
  `userdata/server.json` and prints `CW_SERVER_READY <json>` when listening; a second server
  on the same home prints `CW_SERVER_RUNNING <json>` and exits 3 (the shell then attaches,
  replaces or offers to stop a foreign one; see Keep-running). `PROTOCOL_VERSION` is 3; a mismatch closes the socket.
- Topics carry server state. `topics.subscribe` returns a `{ rev, data }` snapshot per topic
  (subscribing again returns a fresh one); after that the server pushes
  `{ t: "patch", topic, rev, ops }` with `upsert`/`remove`/`append`/`replace` ops, and a rev
  gap makes the client resubscribe. Topics: `app`, `sidebar`, `prs`, `usage`, `session/<id>`,
  `git/<id>`, `files/<id>`, `pty/<id>`, `github/meta`, `github/view:<kind>:<query>` (helpers
  in `packages/shared/src/topics.ts`, providers in `apps/server/src/topics/`). `TopicCache` is
  the only owner of `topics.subscribe`/`topics.unsubscribe` in a client: it ref-counts
  holders, applies patches, resubscribes after a reconnect and then bumps `epoch`.
- Ordering: patches that a call mutates directly are sent before that call's `result`.
  Derived recomputes (PrStore, auto follow-up, session PR extras, sidebar) are scheduled in a
  microtask or macrotask, so their patches may arrive after the `result`. A client must never
  assume derived topics are updated when a call resolves; wait for the topic to show the
  change.
- Multi-client: several clients (`desktop-ui`, `desktop-shell`, `web`) connect to one server.
  The few remaining events are routed by topic: `apps/server/src/app/eventTopics.ts` maps
  each channel to the topic whose subscribers receive it. A channel mapped to no topic
  (settings, startup/shutdown, `app.notice`) goes to every client, filtered by client kind
  (`eventAudience.ts`). Terminals are the exception: attach only through
  `pty.open`/`pty.reattach`/`pty.detach`; `topics.*` reject `pty/` topics.
  `pty.write`/`pty.resize` from a client that is not attached are ignored. The PTY size
  follows the client that most recently typed; resizes from other clients are recorded and
  applied when that client becomes the latest or is the first.
- Remote access: the server binds `127.0.0.1` by default. A non-loopback host is refused
  (exit 1) when it comes from `--host` and no device token exists. From the `serverBindHost`
  setting it falls back to `127.0.0.1` with a crash-log line and a shell notice; only the
  owner can set it. The WebSocket `Origin` is accepted when absent, `file://`, same-origin
  http(s) (checked against `Host`), or listed in `--allow-origin` (URL-normalized; literal
  `null` allows `Origin: null`). Rejected origins go to stderr and the crash log (deduped,
  capped).
- Devices: the owner token (`userdata/server-token`) authenticates the owner; device tokens
  (`userdata/devices.json`, SHA-256 hashes only) authenticate remote clients, which may only
  use the `web` client kind. Owner-only: `devices.create`/`devices.revoke`, `server.stop`,
  `server.setParent`, `shutdown.prepare`/`force`/`quit` and the `serverBindHost`,
  `serverPublicUrl` and `keepServerRunning` settings. That is not a security boundary: a
  device token still grants full remote control (terminals, sessions, files, all other settings). Treat it like a shell login.
  Per-method scopes are future work.
- Browser entry: a browser opens the server's own address (`/`) and pairs with a device
  token. The owner creates one in Settings (`devices.create`) and gets a link
  `<serverPublicUrl>/#token=<token>`; the UI reads the hash, removes it from the address bar and
  keeps the token in `localStorage` (`cw-code:deviceToken`). A rejected token returns to the
  login screen; `devices.revoke` closes that device's open sockets.
- Keep-running: with `keepServerRunning` (owner-only setting) closing the window hides it to
  a tray icon (Open cw-code, Stop server and quit) and the server outlives the shell. The shell
  passes `--launcher-id <installId>` (`install-id` in the Electron user data). On start it
  reads `userdata/server.json`, confirms the server is live, then decides: no server, spawn;
  same launcher id, version and protocol, attach (and `server.setParent` moves the server's
  parent watch to the new shell); same launcher id, other version or protocol, replace (ask the
  user, `POST /api/stop`, wait 15 s, then kill by pid); other or missing launcher id, foreign
  (ask to stop it and start this app's own server, then the replace path; declining quits). Without the setting the
  server exits when its parent is gone. Quit is scoped: `server` stops the server (the shell
  kills it after 3 s if it does not exit), `window` (remote profile) closes only the window.
- Connection profiles: `connections.json` in the Electron user data holds the active id
  and the remote profiles (name, URL, device token sealed with `safeStorage`; a base64 `plain`
  fallback when the OS has none). `local` always exists. The running profile is fixed at
  startup: switching runs the quit flow with the current profile's scope, then relaunches the
  app on the new one (leaving the local profile stops the local server). In remote mode the
  shell never spawns or stops a server, shows no tray, ignores stop-server-and-quit and
  installs updates without the server.

## Stack

- Bun monorepo (package manager, script and test runtime). UI: React 19 + zustand + xterm.js.
- Session metadata persists as atomic JSON under `~/.cw-code/userdata`.
  Logs live in `~/.cw-code/logs`, paste/preview attachments in
  `~/.cw-code/userdata/attachments`, worktrees in `~/.cw-code/worktrees`.
  The home is `CW_CODE_HOME` when set. Unpackaged runs (`bun run dev`) default to
  `~/.cw-code-dev`, so they never share a home with an installed instance.
- Tests run on `bun test`; use `bun run test` (packages run sequentially; each sets its own flags and preload, helpers in `apps/*/tests`); builds via Vite (`@cw-code/ui`, built before the server compile), electron-vite (main and preload only), the server compile script, and electron-builder (Windows NSIS; Linux AppImage and deb).

## Guidelines

- Follow the `CliDriver` seam for anything CLI-related. Supporting a new CLI
  means adding a driver, never changing UI or orchestration code.
- New behavior goes in the server; the UI renders server state and sends intents. The
  server owns the session status machine, auto follow-up, the sidebar layout and attention
  count, the PR engine, GitHub views, usage and workflows; the renderer never polls. Keep a
  contract change in sync across all four layers: contracts type, server handler/topic,
  client adapter (`createCwApi` / `CwApi`), store. Shell features follow the same rule with
  `DesktopApi`, shell IPC and preload.
- Assume several clients may be connected: server state changes must be published to a
  topic (or emitted as an event), never returned only to the caller.
- A new server event needs a topic in `eventTopics.ts` (or an explicit `broadcast` entry);
  an unmapped channel is broadcast to everyone with a warning.
- Visible = subscribed: a view holds its topics only while it is shown and the window is
  visible (hidden views release them), and the server computes and watches only what has
  subscribers. The renderer holds `session/<id>` only for the active thread and a few recent
  ones; notifications come from `sidebar` rows.
- Reconnecting never reloads the renderer: `TopicCache` resubscribes, and per-client inputs
  are re-sent when `useConnectionEpoch()` changes (FilePanel's watched paths, PtyTab's
  `pty.reattach`, which falls back to the exited state). Only `startup.changed` and the
  manual Reload in the lost state reload.
- `fs.setWatchedPaths` inputs are per client: they count only while that client is
  subscribed to `files/<id>` and are cleared on unsubscribe or disconnect.
- Dirty editor buffers live in each device's renderer; the quit dialog only knows its own
  device's buffers.
- A service's `dispose()` must be resumable: shutdown recovery reuses the same services, so
  dispose stops timers and flushes but never drops external listeners, and the service
  resumes on recovery.
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
