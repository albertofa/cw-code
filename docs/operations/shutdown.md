# Shutdown, quit and restart coordination

cw-code runs real CLI processes on the user's behalf. Quitting the app, and
later restarting to install an update, must not lose unsaved edits, must say
which work gets interrupted, and must stop only processes cw-code started. One
coordinator handles both cases: `apps/desktop/src/main/shutdown/ShutdownCoordinator.ts`.

## Owned process inventory

Every child process cw-code creates, and how it is stopped.

| Process | Owner | Lifetime | Graceful stop (`shutdown`) | Forced stop (`dispose`) |
| --- | --- | --- | --- | --- |
| `claude -p --input-format stream-json` per session | `ClaudeCliDriver.processes` | Kept alive between turns, evicted after idle | stdin closed, wait for exit | `taskkill /PID <pid> /T /F` (POSIX: SIGTERM) by PID, skipped once the process has exited so a reused PID is never hit |
| `claude` title turn (`title:<session>`) | same map, `maxTurns: 1` | One turn, terminated on `turn.done` | same as above | same as above |
| `claude` probes (slash commands, account usage) | `claudeCommands.ts`, `claudeAccountUsage.ts` | Short-lived, 30 s (commands) and 20 s (usage) timeouts | not tracked; bounded by their own timeout | own kill on timeout |
| `opencode serve` (shared root `userdata/cw-opencode-server`) | `OpencodeServerPool.servers` | Idle eviction after 5 min, max 4 | running turns aborted over HTTP (`POST /session/:id/abort`), wait for the aborts, then pool disposed | pool `stop()` kills the tree by PID |
| OpenCode per-session work | runs inside the managed server | per turn | `abort` request, see above | server stop |
| `opencode models` listing | `opencodeModels.ts` via `execCliFile` | Short-lived, 20 s timeout | not tracked | execFile timeout |
| `codex app-server` (one per app) | `CodexAppServer.proc` | Started on first request | stdin closed, wait for exit; while still starting it reports a timeout and leaves the kill to `dispose` | tree kill by PID |
| PTY terminals (`shell`, `claude`, `opencode`, `codex`) | `PtyPool.ptys` | Until the tab kills it or it exits | none (a terminal is treated as possibly busy) | node-pty `kill()` on the owned handle |
| `git` / `gh` calls | `GitService`, `PullRequestService` | Short-lived, every call has an execFile timeout (10 s default) | not tracked | execFile timeout |
| `--version` checks | `cliVersions.ts`, `binaryDiscovery.ts` | Short-lived, 15 s timeout | not tracked | execFile timeout |
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
  `regenerateTitle`, title turns, worktree recovery and new terminals fail with
  "cw-code is preparing to restart; try again after it finishes or is
  cancelled". `startTurn` checks the reservation again after its awaits, so a
  turn that was already starting cannot slip in. With active turns and
  `stopActiveTurns: false`, or with a turn that is not in `approvedTurnIds` (work
  that started after the user chose Stop), it releases the reservation and
  returns `blocked`; new work is never stopped silently.
  Otherwise it interrupts the turns, cancels title work, flushes buffered deltas
  and the usage ledger (session metadata is written synchronously on every
  change), closes terminals, and runs the drivers' graceful shutdown.
- A graceful stop that does not finish in time returns `timeout` with the
  pending drivers and a token. The caller chooses `force(token)` (dispose the
  remaining owned processes) or `cancel(token)`.
- `commit(token, action)` runs the quit or install action once; repeated calls
  with the same token share the same promise. If the action throws, or the
  process is still alive after 30 s, the coordinator recovers and returns a
  failure message.
- A prepared or timed-out token is a 120 s lease: if it is not committed,
  forced or cancelled in time (for example the renderer reloaded or hung), the
  coordinator recovers on its own. Force renews the lease.
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

## Quit path (main process)

- `app.requestSingleInstanceLock()` runs before any store is opened. A second
  instance quits immediately; the first instance restores and focuses its
  window. The lock is keyed on Electron `userData`. Packaged builds keep
  `%APPDATA%/@cw-code/desktop`; unpackaged (`pnpm dev`) builds switch to
  `%APPDATA%/@cw-code/desktop-dev` first (unless `--user-data-dir` is passed), so
  dev and the installed app each hold their own lock and can run side by side.
  They still share `~/.cw-code` (projects, sessions, settings) unless
  `CW_CODE_HOME` is set for dev: two instances writing the same stores can
  overwrite each other's changes, so point dev at its own `CW_CODE_HOME` when
  both run.
- On Windows and Linux, closing the main window is intercepted while normal
  services run: main sends `shutdown.requested { reason: "quit" }` to the
  renderer. If the renderer does not call `shutdown.assess` or
  `shutdown.prepare` within 5 s of that request (hung or crashed renderer),
  main flushes, disposes and quits as before. On macOS closing the window keeps
  the previous behaviour (the app stays running); the coordinated flow runs on
  `before-quit` (Cmd+Q) instead.
- `before-quit` is re-entrancy safe: it prompts only while no quit is approved
  and no commit is running; otherwise it flushes and disposes services once.
- OS session end (`session-end` on Windows, `powerMonitor` `shutdown`
  elsewhere) flushes and disposes only; it never installs anything.
- `SIGINT` / `SIGTERM` quit without the dialog.
- If the renderer process dies or the main frame reloads or navigates (Ctrl+R,
  the error boundary's Reload) while a flow is prepared or timed out, main
  recovers the coordinator so the reloaded window is usable. If recovery happens
  after the window was already closed (a quit that never exited), main opens a
  new window.
- Recovery mode (broken metadata, see `metadata-migrations.md`) has no
  services and no coordinator; the window closes and the app quits normally.

IPC: `shutdown.assess`, `shutdown.prepare`, `shutdown.force`, `shutdown.cancel`,
`shutdown.quit` (all argument-validated in main) and the `shutdown.requested`
event. The renderer API is `window.cw.shutdown.*`.

## Renderer flow

`stores/shutdownFlow.ts` exports `runShutdownFlow(reason)`, which resolves to
`{ token }` once the app is prepared or `null` when the user cancels. Quit
calls `cw.shutdown.quit(token)` afterwards; the update install step reuses the
same flow with reason `"update"`.

- No dialog when there is nothing to decide (no active turns, no terminals, no
  dirty editor buffers): it prepares immediately.
- `ShutdownDialog` otherwise lists active turns from all sessions (Wait, which
  re-assesses when a turn ends and can be stopped, or Stop), terminals that
  will be closed, and files with unsaved edits (Save all, Discard all, or per
  file). A failed save cancels the flow with an error and stops nothing.
- Stop sends the ids of the turns the user saw as `approvedTurnIds`; turns that
  started afterwards make prepare return `blocked` and the dialog shows them.
  Stopped turns are marked interrupted in the renderer right away.
- A timeout offers Force stop or Cancel. Cancel always returns to normal use.
- Composer drafts and workspace selection are not touched.

Dirty tracking lives in `stores/editorBuffers.ts`: `FilePanel` registers the
open file with its saved text, edits update the buffer, a successful save marks
it saved, and switching files, switching sessions or unmounting unregisters it.
Several panels showing the same file share one buffer. Save always writes the
buffer to the buffer's own path; while another file is loading (or failed to
load) the editor is empty and read-only and the previous file's buffer, with
its unsaved edits, stays registered.

## Verification

Automated (vitest): `ShutdownCoordinator.test.ts` (ordering, session isolation,
cancellation, timeout, ownership, re-entry, installer-start failure and retry),
`SessionManager.shutdown.test.ts`, `PtyPool.test.ts`, driver shutdown tests for
Claude, Codex, OpenCode and the tracing wrapper, `editorBuffers.test.ts` and
`shutdownFlow.test.ts`.

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
8. Run `pnpm dev` while the installed app is open: both windows stay up.
9. Open file A, edit it, then click a file that fails to load: the editor is
   empty and read-only, Save is hidden, and the quit dialog still lists A.
