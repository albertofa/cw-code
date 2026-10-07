export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

const ALERT_MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i;

const ALERT_KINDS: Partial<Record<string, AlertKind>> = {
  note: "note",
  tip: "tip",
  important: "important",
  warning: "warning",
  caution: "caution"
};

export function parseAlertMarker(firstLine: string): { kind: AlertKind; rest: string } | null {
  const match = ALERT_MARKER.exec(firstLine);
  const kind = match ? ALERT_KINDS[match[1].toLowerCase()] : undefined;
  if (!match || !kind) return null;
  return { kind, rest: match[2] };
}
