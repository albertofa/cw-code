export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

const ALERT_MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i;

export function parseAlertMarker(firstLine: string): { kind: AlertKind; rest: string } | null {
  const match = ALERT_MARKER.exec(firstLine);
  if (!match) return null;
  return { kind: match[1].toLowerCase() as AlertKind, rest: match[2] };
}
