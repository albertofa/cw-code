const FILE_ORIGIN = "file://";

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

export function createOriginPolicy(extra: string[]): (origin: string | null, hostHeader: string | null) => boolean {
  const allowed = new Set([FILE_ORIGIN, ...extra.map((origin) => origin.trim().toLowerCase().replace(/\/+$/, ""))]);
  return (origin, hostHeader) => {
    if (origin === null) return true;
    return allowed.has(origin.toLowerCase()) || sameOrigin(origin, hostHeader);
  };
}
