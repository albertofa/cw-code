import { useState } from "react";
import { Check, ShieldAlert } from "lucide-react";
import type { ApprovalDecision, ApprovalRequest } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";

function ApprovalPanel({ request, position, total }: { request: ApprovalRequest; position: number; total: number }) {
  const respond = useAppStore((s) => s.respondApproval);
  const [chosen, setChosen] = useState<ApprovalDecision | null>(null);

  const act = (decision: ApprovalDecision) => {
    if (chosen !== null) return;
    setChosen(decision);
    void respond(request.requestId, decision).catch(() => setChosen(null));
  };

  return (
    <section className="approval-panel" aria-label="Approval needed">
      <header className="approval-panel-head">
        <ShieldAlert size={15} className="approval-panel-icon" />
        <span className="approval-panel-title">Approval needed</span>
        <span className="approval-panel-count chip">
          {total > 1 ? `${position} of ${total} approvals` : "1 approval"}
        </span>
        <span className="approval-kind chip">{request.kind}</span>
      </header>
      <div className="approval-panel-body">
        <div className="approval-title">{request.title}</div>
        {request.toolName ? (
          <div className="approval-meta">
            {request.toolName}
            {request.cwd ? ` · ${request.cwd}` : ""}
          </div>
        ) : request.cwd ? (
          <div className="approval-meta">{request.cwd}</div>
        ) : null}
        {request.permission ? <div className="approval-meta">{request.permission}</div> : null}
        {request.reason && <div className="approval-reason">{request.reason}</div>}
        {request.details && <pre className="approval-details">{request.details}</pre>}
        {request.patterns && request.patterns.length > 0 && (
          <ul className="approval-patterns">
            {request.patterns.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {request.always && request.always.length > 0 && (
          <div className="approval-always">Always would allow: {request.always.join(", ")}</div>
        )}
      </div>
      <footer className="approval-panel-foot">
        <span className="approval-status">{chosen !== null ? "Responding…" : "Waiting for approval"}</span>
        <div className="approval-actions">
          {request.decisions.includes("accept") && (
            <button className="btn approval-submit" onClick={() => act("accept")} disabled={chosen !== null}>
              <Check size={14} />
              Allow once
            </button>
          )}
          {request.decisions.includes("acceptForSession") && (
            <button className="btn" onClick={() => act("acceptForSession")} disabled={chosen !== null}>
              Allow session
            </button>
          )}
          {request.decisions.includes("acceptGlobal") && (
            <button className="btn" onClick={() => act("acceptGlobal")} disabled={chosen !== null}>
              Always allow
            </button>
          )}
          {request.decisions.includes("decline") && (
            <button className="btn approval-decline" onClick={() => act("decline")} disabled={chosen !== null}>
              Reject
            </button>
          )}
          {request.decisions.includes("cancel") && (
            <button className="btn" onClick={() => act("cancel")} disabled={chosen !== null}>
              Cancel
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

const NO_REQUESTS: ApprovalRequest[] = [];

export function ApprovalDock({ sessionId }: { sessionId: string }) {
  const requests = useAppStore((s) => s.pendingApprovals[sessionId] ?? NO_REQUESTS);
  const current = requests[0];
  if (!current) return null;
  return (
    <div className="approval-dock">
      <ApprovalPanel key={current.requestId} request={current} position={1} total={requests.length} />
    </div>
  );
}
