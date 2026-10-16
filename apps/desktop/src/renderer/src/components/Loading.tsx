import type { CSSProperties, ReactNode } from "react";
import "./loading.css";

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg className={`cw-spinner${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle className="cw-spinner-track" cx="8" cy="8" r="6.25" />
      <circle className="cw-spinner-arc" cx="8" cy="8" r="6.25" pathLength="100" />
    </svg>
  );
}

export function InlineLoading({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`cw-inline-loading${className ? ` ${className}` : ""}`} role="status">
      <Spinner size={13} />
      {label}…
    </span>
  );
}

export function Bone({
  w,
  h = 10,
  round,
  className
}: {
  w: number | string;
  h?: number;
  round?: boolean;
  className?: string;
}) {
  const style: CSSProperties = { width: w, height: h };
  return <span className={`skel-bone${round ? " round" : ""}${className ? ` ${className}` : ""}`} style={style} />;
}

export function SkeletonRegion({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={`skel-region${className ? ` ${className}` : ""}`} role="status">
      <span className="skel-label">{label}…</span>
      {children}
    </div>
  );
}

const CODE_WIDTHS = ["42%", "68%", "55%", "24%", "74%", "61%", "36%", "80%", "48%", "30%", "66%", "52%"];
const CODE_INDENT = [0, 1, 1, 2, 2, 1, 0, 1, 2, 2, 1, 0];

export function CodeLinesSkeleton({ lines = 10 }: { lines?: number }) {
  return (
    <div className="skel-code">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skel-code-line" style={{ paddingLeft: `${CODE_INDENT[i % CODE_INDENT.length] * 2}ch` }}>
          <Bone w={CODE_WIDTHS[i % CODE_WIDTHS.length]} h={8} />
        </div>
      ))}
    </div>
  );
}
