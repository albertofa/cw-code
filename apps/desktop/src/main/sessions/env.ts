export function buildTurnEnv(
  processEnv: Record<string, string | undefined>,
  sessionVars: Record<string, string>,
  turnEnv?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string") out[key] = value;
  }
  for (const [key, value] of Object.entries(sessionVars)) {
    if (typeof value === "string") out[key] = value;
  }
  for (const [key, value] of Object.entries(turnEnv ?? {})) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
