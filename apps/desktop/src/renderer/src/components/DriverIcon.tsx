import type { DriverName } from "../cw.js";

function ClaudeMark({ size }: { size: number }) {
  return (
    <svg className="driver-icon claude" width={size} height={size} viewBox="0 0 20 20" aria-label="claude" role="img">
      <circle cx="10" cy="10" r="9" fill="#f36b2f" />
      <path
        d="M5.6 10h8.8M10 5.6v8.8M6.9 6.9l6.2 6.2M13.1 6.9l-6.2 6.2"
        stroke="#4d170d"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity=".75"
        fill="none"
      />
    </svg>
  );
}

function OpencodeMark({ size }: { size: number }) {
  return (
    <svg className="driver-icon opencode" width={size} height={size} viewBox="0 0 20 20" fill="none" aria-label="opencode" role="img">
      <path d="M13.6 5.1A6.9 6.9 0 1 0 16.9 11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M11.6 8a3.6 3.6 0 1 0 1.7 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function CodexMark({ size }: { size: number }) {
  return (
    <svg className="driver-icon codex" width={size} height={size} viewBox="0 0 20 20" aria-label="codex" role="img">
      <defs>
        <radialGradient id="cw-codex-sphere" cx="35%" cy="28%" r="80%">
          <stop offset="0%" stopColor="#e9edf8" />
          <stop offset="55%" stopColor="#98a3c2" />
          <stop offset="100%" stopColor="#4c5570" />
        </radialGradient>
      </defs>
      <circle cx="10" cy="10" r="8.4" fill="url(#cw-codex-sphere)" />
    </svg>
  );
}

export function DriverIcon({ driver, size = 13 }: { driver: DriverName; size?: number }) {
  if (driver === "claude") return <ClaudeMark size={size} />;
  if (driver === "opencode") return <OpencodeMark size={size} />;
  return <CodexMark size={size} />;
}
