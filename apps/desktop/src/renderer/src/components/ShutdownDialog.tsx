import { useEffect, useId, useMemo } from "react";
import type { ShutdownReason } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import {
  shutdownCancel,
  shutdownDiscardAll,
  shutdownDiscardFile,
  shutdownForce,
  shutdownProceed,
  shutdownSaveAll,
  shutdownSaveFile,
  shutdownStopWaiting,
  shutdownWait
} from "../stores/shutdownFlow.js";

const TERMINAL_LABELS: Record<string, string> = {
  shell: "Shell",
  claude: "Claude terminal",
  opencode: "OpenCode terminal",
  codex: "Codex terminal"
};

function verb(reason: ShutdownReason): { title: string; action: string } {
  return reason === "update"
    ? { title: "Restart to update cw-code", action: "Restart" }
    : { title: "Quit cw-code", action: "Quit" };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function elapsed(startedAt: number): string {
  if (startedAt <= 0) return "running";
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `running for ${seconds}s`;
  return `running for ${Math.round(seconds / 60)}m`;
}

export function ShutdownDialog() {
  const state = useAppStore((s) => s.shutdown);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const titleId = useId();
  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of Object.values(sessionsByProject).flat()) map.set(session.id, session.title);
    return map;
  }, [sessionsByProject]);

  const busy = state?.phase === "saving" || state?.phase === "preparing";

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void shutdownCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state, busy]);

  if (!state) return null;
  const { title, action } = verb(state.reason);
  const { activeTurns, terminals, backgroundTasks } = state.assessment;
  const review = state.phase === "review";
  const waiting = state.phase === "waiting";
  const timedOut = state.phase === "timeout";
  const blockedByFiles = state.dirty.length > 0;
  const primaryLabel = activeTurns.length > 0 ? `Stop ${plural(activeTurns.length, "turn")} and ${action.toLowerCase()}` : action;

  return (
    <div className="confirm-backdrop">
      <div className="confirm-card shutdown-card" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy}>
        <div className="confirm-title" id={titleId}>
          {title}
        </div>

        {timedOut ? (
          <div className="confirm-message">
            Some CLI processes did not stop in time ({state.pending.join(", ")}). Force stop ends only the processes cw-code
            started; their turns stay marked as interrupted and can be resumed later. Cancel keeps cw-code running.
          </div>
        ) : (
          <>
            {state.reason === "update" && (
              <div className="confirm-message">
                cw-code will close, run the installer and reopen. Your projects, sessions and settings are kept, and sessions
                resume their CLI context afterwards. Live terminals are stopped, and nothing is resent automatically.
              </div>
            )}
            {activeTurns.length > 0 && (
              <section className="shutdown-section" aria-label="Active turns">
                <div className="shutdown-section-title">{plural(activeTurns.length, "turn")} still running</div>
                <ul className="shutdown-list">
                  {activeTurns.map((turn) => (
                    <li key={`${turn.sessionId}:${turn.turnId}`} className="shutdown-row">
                      <span className="shutdown-row-name">{turn.title || titles.get(turn.sessionId) || turn.sessionId}</span>
                      <span className="shutdown-row-meta">{elapsed(turn.startedAt)}</span>
                    </li>
                  ))}
                </ul>
                <div className="shutdown-hint">
                  Stopping marks these turns as interrupted. Nothing is resent automatically; you can continue them after the
                  {state.reason === "update" ? " restart" : " next start"}.
                </div>
                {waiting ? (
                  <div className="shutdown-row-actions">
                    <span className="shutdown-hint">Waiting for them to finish…</span>
                    <button type="button" className="btn" onClick={shutdownStopWaiting}>
                      Stop waiting
                    </button>
                  </div>
                ) : (
                  <div className="shutdown-row-actions">
                    <button type="button" className="btn" disabled={!review} onClick={shutdownWait}>
                      Wait for them
                    </button>
                  </div>
                )}
              </section>
            )}

            {terminals.length > 0 && (
              <section className="shutdown-section" aria-label="Open terminals">
                <div className="shutdown-section-title">{plural(terminals.length, "terminal")} will be closed</div>
                <ul className="shutdown-list">
                  {terminals.map((terminal) => (
                    <li key={terminal.ptyId} className="shutdown-row">
                      <span className="shutdown-row-name">{TERMINAL_LABELS[terminal.kind] ?? terminal.kind}</span>
                      <span className="shutdown-row-meta">{titles.get(terminal.sessionId) ?? terminal.sessionId}</span>
                    </li>
                  ))}
                </ul>
                <div className="shutdown-hint">Anything still running in these terminals will be stopped.</div>
              </section>
            )}

            {state.dirty.length > 0 && (
              <section className="shutdown-section" aria-label="Unsaved files">
                <div className="shutdown-section-title">{plural(state.dirty.length, "file")} with unsaved changes</div>
                <ul className="shutdown-list">
                  {state.dirty.map((buffer) => (
                    <li key={buffer.key} className="shutdown-row">
                      <span className="shutdown-row-name" title={buffer.path}>
                        {buffer.path}
                      </span>
                      <span className="shutdown-row-actions">
                        <button type="button" className="btn" disabled={!review} onClick={() => void shutdownSaveFile(buffer.key)}>
                          Save
                        </button>
                        <button type="button" className="btn btn-danger" disabled={!review} onClick={() => shutdownDiscardFile(buffer.key)}>
                          Discard
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="shutdown-row-actions">
                  <button type="button" className="btn" disabled={!review} onClick={() => void shutdownSaveAll()}>
                    Save all
                  </button>
                  <button type="button" className="btn btn-danger" disabled={!review} onClick={shutdownDiscardAll}>
                    Discard all
                  </button>
                </div>
              </section>
            )}

            {backgroundTasks > 0 && (
              <div className="shutdown-hint">{plural(backgroundTasks, "background title task")} will be cancelled.</div>
            )}
          </>
        )}

        {state.error && (
          <div className="shutdown-error" role="alert">
            {state.error}
          </div>
        )}
        {state.phase === "saving" && <div className="shutdown-hint">Saving…</div>}
        {state.phase === "preparing" && <div className="shutdown-hint">Stopping CLI work and closing terminals…</div>}

        <div className="confirm-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void shutdownCancel()}
            autoFocus={!timedOut && (!review || blockedByFiles)}
          >
            Cancel
          </button>
          {timedOut ? (
            <button type="button" className="btn btn-danger-solid" onClick={() => void shutdownForce()} autoFocus>
              Force stop
            </button>
          ) : (
            <button
              type="button"
              className={activeTurns.length > 0 ? "btn btn-danger-solid" : "btn btn-primary"}
              disabled={!review || blockedByFiles}
              title={blockedByFiles ? "Save or discard the files above first" : undefined}
              onClick={() => void shutdownProceed()}
              autoFocus={review && !blockedByFiles}
            >
              {primaryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
