import { CheckCircle2, ShieldAlert, X, XCircle } from "lucide-react";
import type { ApprovalDecision, ApprovalRequest } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
const PRIMARY_LABELS: Record<ApprovalRequest["kind"], string> = {
  command: "Allow command",
  fileChange: "Apply changes",
  permissions: "Grant permissions"
};

export function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const respond = useAppStore((s) => s.respondApproval);

  const act = (decision: ApprovalDecision) => {
    void respond(request.requestId, decision).catch(() => {});
  };

  return (
    <div className="approval-card" role="alert" aria-label="Approval requested">
      <div className="approval-head">
        <ShieldAlert size={15} className="approval-icon" />
        <span className="approval-title">{request.title}</span>
      </div>
      {request.reason && <div className="approval-reason">{request.reason}</div>}
      {request.details && <pre className="approval-details">{request.details}</pre>}
      <div className="approval-actions">
        {request.decisions.includes("accept") && (
          <button className="btn approval-accept" onClick={() => act("accept")}>
            <CheckCircle2 size={14} />
            {PRIMARY_LABELS[request.kind]}
          </button>
        )}
        {request.decisions.includes("acceptForSession") && (
          <button className="btn" onClick={() => act("acceptForSession")}>
            <CheckCircle2 size={14} />
            Always this session
          </button>
        )}
        {request.decisions.includes("decline") && (
          <button className="btn approval-decline" onClick={() => act("decline")}>
            <XCircle size={14} />
            Deny
          </button>
        )}
        {request.decisions.includes("cancel") && (
          <button className="btn" onClick={() => act("cancel")}>
            <X size={14} />
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
