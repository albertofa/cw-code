import { useEffect, useMemo, useRef, useState } from "react";
import type { DriverName } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { useUsageStore } from "../stores/usageStore.js";
import { usePrStore } from "../stores/prStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { UsageMeter } from "./UsageMeter.js";
import { UsageBalanceRow } from "./UsageBalanceRow.js";
import { unavailableTitle } from "./UsagePlanCard.js";
import { useNow, formatCostUsd } from "./usageFormat.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { formatTokensShort } from "./subagents.js";
import { formatDuration } from "./toolSummaries.js";
import { harnessLabel } from "./toolTabs.js";
import { totals } from "./usageModel.js";

const RING_CIRCUMFERENCE = 2 * Math.PI * 7.5;

export function ContextRing({ sessionId, driver }: { sessionId: string; driver: DriverName }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const context = useAppStore((s) => s.turnUsageBySession[sessionId]?.context);
  const lastTurn = useAppStore((s) => s.turnUsageBySession[sessionId]?.lastTurn);
  const snapshot = useUsageStore((s) => s.accountByDriver[driver]);
  const accountLoading = useUsageStore((s) => !!s.accountLoading[driver]);
  const accountError = useUsageStore((s) => s.accountError[driver]);
  const refreshAccount = useUsageStore((s) => s.refreshAccount);
  const ensureSessionRows = useUsageStore((s) => s.ensureSessionRows);
  const sessionRows = useUsageStore((s) => s.sessionRowsById[sessionId]);
  const sessionLoading = useUsageStore((s) => !!s.sessionLoading[sessionId]);
  const sessionError = useUsageStore((s) => s.sessionError[sessionId]);
  const openUsage = usePrStore((s) => s.openUsage);
  const now = useNow();

  useEffect(() => {
    setOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    void refreshAccount([driver], false);
    void ensureSessionRows(sessionId);
  }, [open, driver, sessionId, refreshAccount, ensureSessionRows]);

  useEffect(() => {
    if (!open) return;
    const off = window.cw.onTurnEvent((msg) => {
      if (msg.event.type !== "turn.done" || msg.sessionId !== sessionId) return;
      void ensureSessionRows(sessionId);
    });
    return off;
  }, [open, sessionId, ensureSessionRows]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sessTotals = useMemo(() => totals(sessionRows ?? []), [sessionRows]);

  const percent = context ? Math.min(1, context.usedTokens / Math.max(1, context.windowTokens)) : null;
  const severityClass = percent === null ? "" : percent >= 0.95 ? " danger" : percent >= 0.8 ? " warn" : "";
  const title = percent === null ? "No context data yet" : `Context window · ${Math.round(percent * 100)}% used`;
  const dashArray = percent === null ? `0 ${RING_CIRCUMFERENCE.toFixed(1)}` : `${Math.max(0, percent * RING_CIRCUMFERENCE).toFixed(1)} ${RING_CIRCUMFERENCE.toFixed(1)}`;

  const lastTurnTokens = lastTurn
    ? lastTurn.inputTokens + lastTurn.cacheReadTokens + lastTurn.cacheWriteTokens + lastTurn.outputTokens
    : 0;

  return (
    <div className="context-ring-wrap" ref={rootRef}>
      <button
        type="button"
        className={`context-ring${open ? " open" : ""}${severityClass}`}
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width={18} height={18} viewBox="0 0 20 20">
          <circle cx={10} cy={10} r={7.5} fill="none" stroke="var(--border)" strokeWidth={2.5} />
          {percent !== null && (
            <circle
              cx={10}
              cy={10}
              r={7.5}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray={dashArray}
              transform="rotate(-90 10 10)"
            />
          )}
        </svg>
      </button>
      {open && (
        <div className={`context-dock ${driver}`}>
          <section className="context-dock-sec">
            <div className="context-dock-h">Context window</div>
            {context ? (
              <>
                <div className="context-dock-big">{Math.round((percent ?? 0) * 100)}% used</div>
                <div className="context-dock-sub context-dock-mono">
                  {formatTokensShort(context.usedTokens)} / {formatTokensShort(context.windowTokens)} tokens
                </div>
                <div className="usage-track thin">
                  <i style={{ width: `${Math.round((percent ?? 0) * 100)}%` }} />
                </div>
              </>
            ) : (
              <div className="context-dock-sub">No context data yet.</div>
            )}
          </section>
          <section className="context-dock-sec">
            <div className="context-dock-h">This session</div>
            {sessionLoading && !sessionRows ? (
              <div className="context-dock-sub">Loading…</div>
            ) : sessionError && !sessionRows ? (
              <div className="context-dock-sub context-dock-error">Couldn&apos;t load session usage: {sessionError}</div>
            ) : (
              <div className="context-dock-grid">
                <span>Turns</span>
                <b>{sessTotals.turns}</b>
                <span>Input</span>
                <b>{formatTokensShort(sessTotals.inputTokens)}</b>
                <span>Cache read</span>
                <b>{formatTokensShort(sessTotals.cacheReadTokens)}</b>
                <span>Output</span>
                <b>{formatTokensShort(sessTotals.outputTokens)}</b>
                <span>API-equivalent cost</span>
                <b>{formatCostUsd(sessTotals.costUsd)}</b>
                <span>Last turn</span>
                <b>
                  {lastTurn
                    ? `${formatTokensShort(lastTurnTokens)} tok${lastTurn.durationMs !== undefined ? ` · ${formatDuration(lastTurn.durationMs)}` : ""}`
                    : "—"}
                </b>
              </div>
            )}
          </section>
          <section className="context-dock-sec">
            <div className="context-dock-plan">
              <DriverIcon driver={driver} size={14} />
              <b>{harnessLabel(driver)}</b>
              {snapshot?.state.status === "ok" && snapshot.state.plan && (
                <span className="usage-plan-chip">{snapshot.state.plan}</span>
              )}
            </div>
            {snapshot?.state.status === "ok" ? (
              <>
                <div className="usage-meters">
                  {snapshot.state.windows.map((w) => (
                    <UsageMeter key={w.id} window={w} />
                  ))}
                </div>
                {snapshot.state.balances.map((b) => (
                  <UsageBalanceRow key={b.id} balance={b} />
                ))}
              </>
            ) : !snapshot && accountLoading ? (
              <div className="context-dock-sub">Loading plan limits…</div>
            ) : !snapshot && accountError ? (
              <div className="context-dock-sub context-dock-error">Couldn&apos;t load plan limits: {accountError}</div>
            ) : snapshot?.state.status === "unavailable" ? (
              <div className="context-dock-sub">
                <b>{unavailableTitle(snapshot.state.reason)}</b> {snapshot.state.message}
              </div>
            ) : snapshot?.state.status === "error" ? (
              <div className="context-dock-sub context-dock-error">
                <b>Couldn&apos;t load plan limits</b> {snapshot.state.message}
              </div>
            ) : (
              <div className="context-dock-sub">Loading plan limits…</div>
            )}
          </section>
          <div className="context-dock-foot">
            <span className="usage-pulse" aria-hidden="true" />
            <span>{snapshot ? `Updated ${formatRelativeAge(snapshot.fetchedAt, now)} ago` : "Not refreshed yet"}</span>
            <a
              className="context-dock-link"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setOpen(false);
                openUsage();
              }}
            >
              Open usage →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
