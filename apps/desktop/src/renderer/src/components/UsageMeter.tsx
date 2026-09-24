import type { UsageWindow } from "../cw.js";
import { formatResetsAt } from "./usageFormat.js";

export function UsageMeter({ window }: { window: UsageWindow }) {
  const severityClass = window.severity === "blocked" ? " block" : window.severity === "warning" ? " warn" : "";
  const percent = Math.min(100, Math.max(0, window.percent));
  return (
    <div className={`usage-meter${severityClass}`}>
      <div className="usage-meter-top">
        <span className="usage-meter-label">{window.label}</span>
        {window.severity === "blocked" && <span className="usage-tag block">■ Limit reached</span>}
        {window.severity === "warning" && <span className="usage-tag warn">▲ Near limit</span>}
        <span className="usage-meter-val">{Math.round(window.percent)}%</span>
      </div>
      <div className="usage-track">
        <i style={{ width: `${percent}%` }} />
      </div>
      {window.resetsAt !== undefined && (
        <div className="usage-meter-sub">
          <span>{formatResetsAt(window.resetsAt)}</span>
          {window.active && <span>· limiting now</span>}
        </div>
      )}
    </div>
  );
}
