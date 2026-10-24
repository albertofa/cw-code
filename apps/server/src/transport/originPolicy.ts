const FILE_ORIGIN = "file://";
const NULL_ORIGIN = "null";
const MAX_LOGGED_REJECTED_ORIGINS = 20;

function sameOrigin(origin: string, hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.host.toLowerCase() === hostHeader.trim().toLowerCase();
}

function normalizeAllowedOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === NULL_ORIGIN) return NULL_ORIGIN;
  try {
    const origin = new URL(trimmed).origin;
    if (origin !== NULL_ORIGIN) return origin.toLowerCase();
  } catch {
  }
  console.warn(`ignoring invalid --allow-origin value ${JSON.stringify(value)}`);
  return null;
}

export function createOriginPolicy(extra: string[]): (origin: string | null, hostHeader: string | null) => boolean {
  const allowed = new Set([FILE_ORIGIN, ...extra.flatMap((value) => normalizeAllowedOrigin(value) ?? [])]);
  return (origin, hostHeader) => {
    if (origin === null) return true;
    return allowed.has(origin.toLowerCase()) || sameOrigin(origin, hostHeader);
  };
}

export function createRejectedOriginLogger(
  record: (entry: string) => void,
  limit = MAX_LOGGED_REJECTED_ORIGINS
): (origin: string | null) => void {
  const seen = new Set<string | null>();
  return (origin) => {
    if (seen.has(origin) || seen.size >= limit) return;
    seen.add(origin);
    record(`rejected websocket upgrade from origin ${JSON.stringify(origin)}`);
  };
}
