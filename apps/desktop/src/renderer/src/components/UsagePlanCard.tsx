import { useState } from "react";
import type { AccountUsageSnapshot, AccountUsageUnavailableReason, DriverName } from "../cw.js";
import { DriverIcon } from "./DriverIcon.js";
import { UsageMeter } from "./UsageMeter.js";
import { UsageBalanceRow } from "./UsageBalanceRow.js";
import { useNow } from "./usageFormat.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { useAppStore } from "../stores/appStore.js";
import { useUsageStore } from "../stores/usageStore.js";
import { ipcErrorMessage } from "./ipcError.js";
import { useNotifs } from "./Notifications.js";

function cardTitle(driver: DriverName, snapshot: AccountUsageSnapshot | undefined): string {
  if (driver === "claude") return "Claude Code";
  if (driver === "codex") return "Codex";
  if (snapshot?.state.status === "unavailable" && snapshot.state.reason === "no-subscription") return "OpenCode";
  return "OpenCode Go";
}

export function unavailableTitle(reason: AccountUsageUnavailableReason): string {
  switch (reason) {
    case "api-key":
      return "No plan limits for this login";
    case "no-subscription":
      return "No OpenCode Go subscription";
    case "logged-out":
      return "Signed out";
    case "unsupported-version":
      return "Update to see plan limits";
    case "not-installed":
      return "Not installed";
    case "consent-required":
      return "Plan limits need your permission";
    case "key-rejected":
      return "OpenCode rejected the stored key";
    default:
      return "Plan limits unavailable";
  }
}

export function UsagePlanCard({
  driver,
  snapshot,
  loading,
  error,
  onOpenSettings
}: {
  driver: DriverName;
  snapshot: AccountUsageSnapshot | undefined;
  loading: boolean;
  error?: string;
  onOpenSettings?: (driver: DriverName) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [allowing, setAllowing] = useState(false);
  const refreshAccount = useUsageStore((s) => s.refreshAccount);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const now = useNow();

  const title = cardTitle(driver, snapshot);
  const state = snapshot?.state;

  const retry = async () => {
    setRetrying(true);
    try {
      await refreshAccount([driver], true);
    } finally {
      setRetrying(false);
    }
  };

  const allow = async () => {
    setAllowing(true);
    try {
      await saveSettings({ opencodeGoUsage: true });
      await refreshAccount([driver], true);
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title: "Could not save the setting", message: ipcErrorMessage(err) });
    } finally {
      setAllowing(false);
    }
  };

  return (
    <article className={`usage-card ${driver}`}>
      <div className="usage-card-head">
        <span className="usage-dicon">
          <DriverIcon driver={driver} size={14} />
        </span>
        <span className="usage-card-name">{title}</span>
        {state?.status === "ok" && state.plan && <span className="usage-plan-chip">{state.plan}</span>}
      </div>
      {!snapshot && loading && <div className="usage-empty-line">Loading plan limits…</div>}
      {!snapshot && !loading && error && (
        <div className="usage-empty-block">
          <div className="usage-empty">
            <span className="usage-empty-ic" aria-hidden="true">
              !
            </span>
            <div>
              <b>Couldn&apos;t load plan limits</b>
              {error}
            </div>
          </div>
          <button className="usage-btn" onClick={() => void retry()} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {!snapshot && !loading && !error && <div className="usage-empty-line">No data yet.</div>}
      {snapshot && state?.status === "ok" && (
        <>
          <div className="usage-meters">
            {state.windows.map((w) => (
              <UsageMeter key={w.id} window={w} />
            ))}
          </div>
          {state.balances.length > 0 && (
            <>
              <div className="usage-card-div" />
              {state.balances.map((b) => (
                <UsageBalanceRow key={b.id} balance={b} />
              ))}
            </>
          )}
          {state.notes.length > 0 && <div className="usage-note">{state.notes.join(" ")}</div>}
          <div className="usage-card-foot">
            <span className="usage-pulse" aria-hidden="true" />
            <span>Updated</span>
            <span className="usage-when">{formatRelativeAge(snapshot.fetchedAt, now)} ago</span>
          </div>
        </>
      )}
      {state?.status === "unavailable" && (
        <div className="usage-empty-block">
          <div className="usage-empty">
            <span className="usage-empty-ic" aria-hidden="true">
              ⓘ
            </span>
            <div>
              <b>{unavailableTitle(state.reason)}</b>
              {state.message}
            </div>
          </div>
          {state.reason === "consent-required" && (
            <button className="usage-btn" onClick={() => void allow()} disabled={allowing}>
              {allowing ? "Allowing…" : "Allow"}
            </button>
          )}
          {state.reason === "not-installed" && onOpenSettings && (
            <button className="usage-btn" onClick={() => onOpenSettings(driver)}>
              Open settings
            </button>
          )}
        </div>
      )}
      {state?.status === "error" && (
        <div className="usage-empty-block">
          {snapshot?.lastGood && (
            <div className="usage-meters usage-stale">
              {snapshot.lastGood.state.windows.map((w) => (
                <UsageMeter key={w.id} window={w} />
              ))}
            </div>
          )}
          <div className="usage-empty">
            <span className="usage-empty-ic" aria-hidden="true">
              !
            </span>
            <div>
              <b>
                {snapshot?.lastGood
                  ? `Couldn't refresh · showing data from ${formatRelativeAge(snapshot.lastGood.fetchedAt, now)} ago`
                  : "Couldn't load plan limits"}
              </b>
              {state.message}
            </div>
          </div>
          <button className="usage-btn" onClick={() => void retry()} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
    </article>
  );
}
