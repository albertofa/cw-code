# Shutdown, quit and restart coordination

cw-code runs real CLI processes on the user's behalf. Quitting the app, and
later restarting to install an update, must not lose unsaved edits, must say
which work gets interrupted, and must stop only processes cw-code started. One
coordinator handles both cases: `apps/server/src/shutdown/ShutdownCoordinator.ts`.

## Owned process inventory

Every child process cw-code creates, and how it is stopped.

| Process | Owner | Lifetime | Graceful stop (`shutdown`) | Forced stop (`dispose`) |
| --- | --- | --- | --- | --- |
| `claude -p --input-format stream-json` per session | `ClaudeCliDriver.processes` | Kept alive between turns, evicted after idle | stdin closed, wait for exit | `taskkill /PID <pid> /T /F` (POSIX: SIGTERM) by PID, skipped once the process has exited so a reused PID is never hit |
| `claude` title turn (`title:<session>`) | same map, `maxTurns: 1` | One turn, terminated on `turn.done` | same as above | same as above |
| `claude` probes (slash commands, account usage) | `claudeCommands.ts`, `claudeAccountUsage.ts` | Short-lived, 30 s (commands) and 20 s (usage) timeouts | not tracked; bounded by their own timeout | own kill on timeout |
| `opencode serve` (shared root `userdata/cw-opencode-server`; v2 runs `serve --stdio`, which exits when its stdin closes) | `OpencodeServerPool.servers` | Idle eviction after 5 min, max 4 | running turns aborted over HTTP (v1 `POST /session/:id/abort`, v2 `POST /api/session/:id/interrupt`), wait for the aborts, then pool disposed | pool `stop()` kills the tree by PID; on v2 it first interrupts every session in `GET /api/session/active` so the user's background service does not resume them |
| OpenCode per-session work | runs inside the managed server | per turn | `abort` request, see above | server stop |
| `opencode models` listing (v1 only; v2 lists `GET /api/model` on the managed server) | `opencodeModels.ts` via `execCliFile` | Short-lived, 20 s timeout | not tracked | execFile timeout |
| `codex app-server` (one per app) | `CodexAppServer.child` (tracked from spawn until exit, including while it initializes) | Started on first request; a child that fails to initialize is killed by handle | stdin closed, wait for exit; requests made while it waits are rejected and never written to the child; reports a timeout while the child is still alive, even if it never finished initializing | tree kill by PID of the tracked child; exit and error events from a child that is no longer the latest one are ignored, so they never reject a retry's requests |
| PTY terminals (`shell`, `claude`, `opencode`, `codex`) | `PtyPool.ptys` | Until the tab kills it or it exits | none (a terminal is treated as possibly busy); closed only after the drivers stopped, or on force | node-pty `kill()` on the owned handle; an open that was in flight across a dispose is refused and its PTY killed by handle |
| `git` / `gh` calls | `GitService`, `PullRequestService` | Short-lived, every call has an execFile timeout (10 s default) | not tracked | execFile timeout |
| `--version` checks | `cliVersions.ts`, `binaryDiscovery.ts` | Short-lived, 15 s timeout | not tracked | execFile timeout |
| Harness update commands (`claude update`, `npm install -g …`, …) | `harnessUpdates/runUpdateCommand.ts` | One per install lock, 5 min timeout | not tracked; left to finish, since stopping an install halfway can leave a broken CLI | tree kill on timeout |
| PowerShell / `ps` process listing | `orphanServers.ts` at startup | Short-lived, 20 s timeout | not tracked | execFile timeout |

The in-process OpenCode ask bridge is an HTTP server, not a child process; it is
closed with the driver.

`reapOrphanedServers()` runs once at startup and kills `opencode serve` /
`codex app-server` processes whose parent process no longer exists (left over
from a crashed run). It is the only code that selects processes by command
line, and it never touches a process with a live parent. The shutdown path
never kills by name: drivers stop only the handles they spawned.

## Lifecycle hooks on `CliDriver`

`packages/contracts/src/provider.ts` adds two optional methods:

- `activity(): DriverActivity` returns every session the driver is busy for
  (including internal ones such as title generation) and the number of owned
  processes. Drivers know nothing about title turns; `SessionManager` counts
  background work from its own title-turn map and ignores busy ids that are not
  stored sessions.
- `shutdown({ timeoutMs }): Promise<{ timedOut }>` asks every owned process to
  exit and waits up to `timeoutMs`. It never force-kills; anything still alive
  is left for `dispose()`.

A driver without `shutdown` is disposed directly. `TracingCliDriver` passes both
through and traces the outcome. A new CLI only has to implement these on its
driver; the coordinator and UI do not change.

## Coordinator phases

```
idle ──prepare──▶ preparing ──▶ prepared ──commit──▶ committing ──▶ (process exits)
  ▲                  │  │            │                    │
  │           blocked│  └─timeout─▶ timeout ──force──▶ prepared
  │                  ▼               │                    │
  └──────── recover ◀── cancel ◀─────┘◀── commit failed / did not exit
```

- `assess()` lists active turns in every session (not only the focused one),
  background title work, and open terminals.
- `prepare({ reason, stopActiveTurns, timeoutMs })` is single-flight: a second
  call while a flow is in progress returns `busy`. It reserves `SessionManager`
  and `PtyPool` first, so `startTurn`, `createSession`, `retryConnection`,
  `regenerateTitle`, title turns, worktree recovery, new terminals and the
  driver CLI probes (`listCommands*`, `listModels*`, `listPermissionModes*`,
  account usage through `driversForProbe()`) fail with "cw-code is preparing
  to restart; try again after it finishes or is cancelled"; the OpenCode model
  warmup is skipped with a warning. `startTurn`, `createSession` and worktree recovery check the
  reservation again after every await that precedes starting a process or
  creating a worktree, so work that was already starting cannot slip in. A
  terminal whose open was in flight when the pool was disposed is refused even
  if the pool was reopened meanwhile (the pool generation changed). With active
  turns and `stopActiveTurns: false`, or with a turn that is not in
  `approvedTurnIds` (work that started after the user chose Stop), it releases
  the reservation and returns `blocked`; new work is never stopped silently.
  Otherwise it interrupts the turns, cancels title work, flushes buffered deltas
  and the usage ledger (session metadata is written synchronously on every
  change) and runs the drivers' graceful shutdown. Terminals are closed only
  after every driver stopped in time. The `ok` and `timeout` results carry
  `stoppedTurnIds`: the turns this prepare interrupted, taken from its own
  assessment, never from the renderer's.
- A graceful stop that does not finish in time returns `timeout` with the
  pending drivers and a token; terminals are still open. The caller chooses
  `force(token)` (dispose the remaining owned processes, then close terminals)
  or `cancel(token)` (drivers are rebuilt and the terminals were never closed).
- `commit(token, action)` runs the quit or install action once; repeated calls
  with the same token share the same promise. If the action throws, the
  coordinator recovers and returns a failure message. The server's
  `shutdown.quit` disposes services as its action and exits right after
  replying, so the "still alive after 30 s" check runs in the Electron shell
  instead: an update install stays pending until the app exits, and after 30 s
  the shell restarts its server, reconnects, and reports the failure.
- A prepared or timed-out token is a 120 s lease: if it is not committed,
  forced or cancelled in time (for example the renderer reloaded or hung), the
  coordinator recovers on its own and calls `onExpired(reason)`; main then
  sends `shutdown.expired { reason }` so a dialog still waiting on that token
  (the timeout choice) closes with "waited too long for a decision" instead of
  offering buttons that would fail. Force renews the lease.
- `recover()` / `cancel()` rebuild the drivers through the `SessionManager`
  driver factory (old drivers are disposed first; events from the old
  generation are ignored), reopen the PTY pool and clear both reservations. It
  is idempotent. Sessions interrupted for the shutdown are published again
  after the rebuild. If the driver factory throws, the reservations are still
  cleared, `SessionManager` refuses new work with a "quit and reopen" message,
  and main shows a native error dialog.

Interrupted turns keep the existing marking: the session becomes `holding`
(`working` / `input-required` also become `holding` on the next load). Nothing is
resent automatically and no process is resurrected; continuing a session
resumes it through the CLI's own resume cursor.

## Quit path (Electron shell)

- `app.requestSingleInstanceLock()` runs before any store is opened. A second
  instance quits immediately; the first instance restores and focuses its
  window. The lock is keyed on Electron `userData`. Packaged builds keep
  `%APPDATA%/@cw-code/desktop`; unpackaged (`bun run dev`) builds switch to
  `%APPDATA%/@cw-code/desktop-dev` first (unless `--user-data-dir` is passed), so
  dev and the installed app each hold their own lock and can run side by side.
  They still share `~/.cw-code` (projects, sessions, settings) unless
  `CW_CODE_HOME` is set for dev: two instances writing the same stores can
  overwrite each other's changes, so point dev at its own `CW_CODE_HOME` when
  both run.
- The coordinator lives in the cw-code server (`apps/server`); the Electron
  shell (`apps/desktop/src/main`) only owns the window and the quit decision.
- On Windows and Linux, closing the main window is intercepted while the server
  link is open (and, with keep-running on, hides the window instead; see below): the
  shell sends `shutdown.requested { reason: "quit", scope }` to the
  renderer. If the renderer does not acknowledge (it does so when it calls
  `shutdown.assess` or `shutdown.prepare` on the server) within 5 s (hung or
  crashed renderer), the shell stops the server gracefully (`server.stop`, which
  flushes and disposes) and quits. On macOS closing the window keeps the
  previous behaviour (the app stays running); the coordinated flow runs on
  `before-quit` (Cmd+Q) instead.
- `shutdown.quit` on the server commits the token, disposes services, replies
  and exits; the renderer then sends `app.quit` to the shell, which quits.
- `before-quit` is re-entrancy safe: it prompts only while no quit is approved;
  once approved it waits for the server process to stop (graceful, then kill)
  before the app exits.
- OS session end (`session-end` on Windows, `powerMonitor` `shutdown`
  elsewhere) and `SIGINT` / `SIGTERM` approve the quit and stop the server
  without the dialog; they never install anything. The server also exits on its
  own when the shell's process disappears (`--parent-pid`).
- If the renderer process dies or reloads while a flow is prepared or timed out,
  its WebSocket closes and the server recovers the coordinator (and detaches
  terminals when no other UI client is connected), so the reloaded window is
  usable.
- Recovery mode (broken metadata, see `metadata-migrations.md`) has no
  services and no coordinator; the window closes and the app quits normally.

Server methods: `shutdown.assess`, `shutdown.status`, `shutdown.prepare`,
`shutdown.force`, `shutdown.cancel`, `shutdown.quit` (all argument-validated in
the server) and the `shutdown.expired` / `shutdown.changed` events; the shell
sends `shutdown.requested` to the renderer. The renderer API is
`window.cw.shutdown.*`.
`updates.install` commits a token through the same coordinator (see
`updater.md`).

## Scopes, tray and the background server

A quit request carries a scope (`ShutdownScope` in `packages/contracts/src/shutdown.ts`).

- `server`: the full flow above. The coordinator assesses and prepares, the renderer commits
  with `shutdown.quit`, and the shell stops the server before the app exits. This is the scope
  on the local profile.
- `window`: used on a remote profile, where the server is not the shell's to stop. The dialog
  appears only when editor buffers are dirty (Save all, Discard all, or per file). No turn is
  stopped, no terminal is closed and no token is taken; the renderer calls the shell's
  `quit` (`cw.shutdown.quitWindow()`) and the server keeps running.

**Keep-running.** With the owner-only `keepServerRunning` setting on, the local profile shows
a tray icon (Open cw-code, Stop server and quit; on Windows a click also opens the window;
the tooltip carries the attention count) and closing the window hides it
instead of quitting. Turns, terminals and the server keep going. The tray is removed when the
setting is turned off (a hidden window is shown again), and on quit. macOS keeps its own
close behaviour (the app stays running); the tray menu and Cmd+Q still apply.
Without the setting, closing the window runs the `server` flow as before.

"Stop server and quit" in the tray, or in the app, shows the `server` dialog (turns,
terminals, dirty buffers) and then stops the server. Quitting by any other route (Cmd+Q, the
dialog on close without a tray) also stops it: only closing the window keeps the server up.

**Starting against a running server.** The shell passes `--launcher-id <installId>` to the
server it spawns (`install-id` in the Electron user data) and the server records it in
`userdata/server.json`. On start the shell reads that file, confirms the process is live and
decides (`decideServerStart` in `apps/desktop/src/main/serverAttach.ts`):

| Running server | Decision |
| --- | --- |
| none, or not answering | spawn a new one |
| same launcher id, same version and protocol | attach: reuse it; the shell then calls `server.setParent` so the server watches the new shell, not the dead one |
| same launcher id, other version or protocol | replace: the shell asks "Restart it with version X?" (declining quits); on confirm it calls `POST /api/stop` with the owner token, waits 15 s for the pid to exit, then kills the pid and waits 3 s more |
| other or missing launcher id | foreign: the shell asks "Stop it and start this app's own server?" (Quit exits 0); on Stop and restart it takes the replace path with the owner token from the same `CW_CODE_HOME` |

**Kill fallback.** Stopping a server the shell attached to sends `server.stop` (over the link,
or `POST /api/stop` when there is none), gives the call 3 s, waits 3 s for the pid to exit and
then kills it by pid. For a child the shell spawned it is `server.stop` (or SIGTERM when there is
no link), 3 s to close, then SIGKILL. A failed stop is logged and the quit continues. If the
server's parent disappears and `keepServerRunning` is off, the server stops itself
(`--parent-pid`); with it on it keeps running and drops the parent watch.

**Remote mode.** When the active profile is remote the shell never spawns, attaches to,
stops or replaces a server, never shows the tray, and ignores stop-server-and-quit. Closing
the window or quitting uses the `window` scope. Update installs also skip the server
coordinator: the UI runs the window flow (`runWindowShutdownFlow`) before the installer. Switching profiles runs the
quit flow with the current profile's scope, then relaunches on the new profile.

## Updating or installing by hand

With keep-running on, the server (`cw-code-server`) can be alive with no window. The in-app
update runs the `server` flow, so it stops the server first. A manual install over the same
folder should start with "Stop server and quit" from the tray; otherwise the old server can
still hold files in the install directory.

## Renderer flow

`apps/ui/src/stores/shutdownFlow.ts` exports `runShutdownFlow(reason)`, which resolves to
`{ token }` once the app is prepared or `null` when the user cancels. Quit
calls `cw.shutdown.quit(token)` afterwards.

Update and restart (`stores/updateFlow.ts`) runs the same flow with reason
`"update"` before anything is installed, and only once the installer is
already downloaded. The dialog then also explains that cw-code closes, installs the
update silently in the background and reopens, that sessions keep their context and that live
terminals stop. With the token it re-reads the update state; if the download
changed it cancels the token, otherwise it calls
`cw.updates.install({ version, channel, token })` right away, well within the
lease.

- `handleShutdownExpired()` (wired to `shutdown.expired`) closes the dialog
  only when the flow holds a token; a dialog still in review has no lease and
  stays open.

- No dialog when there is nothing to decide (no active turns, no terminals, no
  dirty editor buffers): it prepares immediately.
- `ShutdownDialog` otherwise lists active turns from all sessions (Wait, which
  re-assesses when a turn ends and can be stopped, or Stop), terminals that
  will be closed, and files with unsaved edits (Save all, Discard all, or per
  file). A failed save cancels the flow with an error and stops nothing.
- Re-assessment is single-flight: overlapping refreshes (turn events, the poll,
  another close request) share one run and queue at most one more, and a flow
  calls `shutdown.prepare` at most once at a time, so a duplicate refresh can
  never get a `busy` result that cancels the flow.
- Stop sends the ids of the turns the user saw as `approvedTurnIds`; turns that
  started afterwards make prepare return `blocked` and the dialog shows them.
  The renderer marks interrupted only the turns listed in the result's
  `stoppedTurnIds`; a turn the dialog showed that had already ended is left
  alone.
- A timeout offers Force stop or Cancel. Cancel always returns to normal use,
  with terminals still running.
- Composer drafts and workspace selection are not touched.

Dirty tracking lives in `stores/editorBuffers.ts`: `FilePanel` registers the
open file with its saved text, edits update the buffer, a successful save marks
it saved, and switching files, switching sessions or unmounting unregisters it.
Unregistering releases a clean buffer; a dirty buffer is kept, with its edits,
until it is saved or discarded (the quit dialog lists it by its own path), and
reopening that file shows the unsaved content. Several panels showing the same
file share one buffer. Save always writes the buffer to the buffer's own path;
while another file is loading (or failed to load) the editor is empty and
read-only and the previous file's buffer, with its unsaved edits, stays
registered.

## Verification

Automated (bun test): `ShutdownCoordinator.test.ts` (ordering, session isolation,
cancellation, timeout, ownership, re-entry, installer-start failure and retry),
`SessionManager.shutdown.test.ts`, `PtyPool.test.ts`, driver shutdown tests for
Claude, Codex, OpenCode and the tracing wrapper, `codexAppServer.test.ts`
(stop while starting by closing stdin, timeout only while the child is alive), `editorBuffers.test.ts`,
`shutdownFlow.test.ts` (including lease expiry) and
`UpdateService.install.test.ts` (update commits through the coordinator).

Pending manual evidence (needs a real Windows desktop session, an isolated test
project and a disposable `CW_CODE_HOME`; never the developer's live install):

1. Start a long Claude turn in a background session, open a shell terminal and
   leave a file edited but unsaved. Close the window: the dialog lists all
   three. Cancel, confirm the app still works and the turn is still running.
2. Close again, save the file, choose Stop: the turn is marked interrupted, the
   terminal closes, the app exits. Check Task Manager that no `claude`,
   `opencode serve`, `codex app-server` or PTY shell started by cw-code
   remains, and that a CLI started by hand in another terminal is still alive.
3. Repeat with OpenCode and Codex sessions.
4. Confirm that `claude` exits on stdin close and `codex app-server` exits on
   stdin close within the 10 s timeout; otherwise record the timeout dialog
   and the Force stop result.
5. Launch a second cw-code instance: it exits and the first window is focused.
6. Kill the renderer (DevTools crash or `process.crash()`) while the dialog is
   open: the window reloads and new turns can start.
7. Reach the timeout dialog, then press Ctrl+R: after the reload, closing the
   window shows the dialog again (not "already in progress").
8. Run `bun run dev` while the installed app is open: both windows stay up.
9. Open file A, edit it, then click a file that fails to load: the editor is
   empty and read-only, Save is hidden, and the quit dialog still lists A.
10. Reach the timeout dialog and wait 120 s without choosing: the dialog closes
    with "waited too long for a decision" and new turns can start.
11. Start a Codex session and close the window while the app-server is still
    starting: stdin is closed at once and the quit exits without a timeout dialog
    (unless the app-server ignores stdin close for 10 s).
12. Update and restart, with the update-specific checks, is in the manual
    checklist of `updater.md`.
13. Open file A, edit it, open file B, then reopen A: the unsaved edits are
    shown, and the quit dialog lists A while B is open.
14. Reach the timeout dialog with a shell terminal open and choose Cancel: the
    terminal is still running and accepts input.
