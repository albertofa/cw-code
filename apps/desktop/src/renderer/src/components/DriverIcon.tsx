import { Code, Orbit, Sparkles } from "lucide-react";
import type { DriverName } from "../cw.js";

const ICONS: Record<DriverName, typeof Sparkles> = {
  claude: Sparkles,
  opencode: Code,
  codex: Orbit
};

export function DriverIcon({ driver, size = 13 }: { driver: DriverName; size?: number }) {
  const Icon = ICONS[driver];
  return <Icon size={size} className={`driver-icon ${driver}`} aria-label={driver} role="img" />;
}
