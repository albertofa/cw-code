import { RefreshCw } from "lucide-react";
import { usePanelStore } from "../stores/panelStore.js";
import { usePrStore } from "../stores/prStore.js";
import { PanelToggles } from "./PanelToggles.js";
import { prKey } from "./prInbox.js";

export function PrInboxView() {
  const inbox = usePrStore((s) => s.inbox);
  const loading = usePrStore((s) => s.inboxLoading);
  const error = usePrStore((s) => s.inboxError);
  const refreshInbox = usePrStore((s) => s.refreshInbox);
  const openPr = usePrStore((s) => s.openPr);
  const rightVisible = usePanelStore((s) => s.rightVisible);
  const items = inbox?.items ?? [];
  const failure = error ?? inbox?.error ?? null;

  return (
    <div className="thread-col pr-view">
      <div className="head-seg main-seg" onDoubleClick={() => window.cw.toggleMaximizeWindow()}>
        <div className="head-col col-left">
          <div className="titlebar-crumb">
            <strong>Pull requests</strong>
            {inbox?.account && <span className="pr-view-account">{inbox.account.login}</span>}
          </div>
        </div>
        <div className="head-col col-mid" />
        <div className="head-col col-right">
          <button
            className="icon-btn"
            onClick={() => void refreshInbox(true)}
            disabled={loading}
            title="Refresh pull requests"
            aria-label="Refresh pull requests"
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          {!rightVisible && <PanelToggles />}
        </div>
      </div>
      <div className="pr-view-body">
        {failure && <div className="pr-view-error" role="alert">{failure}</div>}
        {loading && items.length === 0 && <div className="pr-view-empty">Loading pull requests…</div>}
        {!loading && !failure && inbox && items.length === 0 && <div className="pr-view-empty">No open pull requests involve you.</div>}
        {items.length > 0 && (
          <ul className="pr-view-list">
            {items.map((pr) => (
              <li key={prKey(pr.ref)}>
                <button className="pr-view-row" onClick={() => openPr(pr.ref)} title={pr.url}>
                  <span className="pr-view-title">{pr.title}</span>
                  <span className="pr-view-meta">{pr.ref.owner}/{pr.ref.repo} #{pr.ref.number}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
