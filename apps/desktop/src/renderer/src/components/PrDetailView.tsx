import { ArrowLeft } from "lucide-react";
import type { PrRef } from "../cw.js";
import { usePanelStore } from "../stores/panelStore.js";
import { usePrStore } from "../stores/prStore.js";
import { PanelToggles } from "./PanelToggles.js";
import { prKey } from "./prInbox.js";

export function PrDetailView({ prRef }: { prRef: PrRef }) {
  const key = prKey(prRef);
  const detail = usePrStore((s) => s.detailByKey[key]);
  const loading = usePrStore((s) => s.detailLoadingByKey[key] ?? false);
  const error = usePrStore((s) => s.detailErrorByKey[key]);
  const openInbox = usePrStore((s) => s.openInbox);
  const loadDetail = usePrStore((s) => s.loadDetail);
  const rightVisible = usePanelStore((s) => s.rightVisible);

  return (
    <div className="thread-col pr-view">
      <div className="head-seg main-seg" onDoubleClick={() => window.cw.toggleMaximizeWindow()}>
        <div className="head-col col-left">
          <button className="pr-view-back" onClick={openInbox}>
            <ArrowLeft size={15} aria-hidden="true" />
            Back to inbox
          </button>
          <div className="titlebar-crumb">
            <span title={key}>
              {prRef.owner}/{prRef.repo} <span className="sep">/</span> <strong>#{prRef.number}</strong>
            </span>
          </div>
        </div>
        <div className="head-col col-mid" />
        <div className="head-col col-right">{!rightVisible && <PanelToggles />}</div>
      </div>
      <div className="pr-view-body">
        {error && (
          <div className="pr-view-error" role="alert">
            {error}
            <button className="pr-view-retry" onClick={() => void loadDetail(prRef)}>Retry</button>
          </div>
        )}
        {loading && !detail && <div className="pr-view-empty">Loading pull request…</div>}
        {detail && (
          <div className="pr-view-detail">
            <h2 className="pr-view-heading">{detail.title}</h2>
            <span className={`pr-view-state state-${detail.state.toLowerCase()}`}>{detail.isDraft ? "Draft" : detail.state.toLowerCase()}</span>
          </div>
        )}
      </div>
    </div>
  );
}
