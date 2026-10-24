export const DEFAULT_BIND_HOST = "127.0.0.1";

const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function resolveBindHost(flag: string | null, setting: string | undefined): string {
  return flag ?? (setting?.trim() || DEFAULT_BIND_HOST);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || IPV4_LOOPBACK.test(normalized);
}

export function connectHost(bindHost: string): string {
  if (bindHost === "0.0.0.0") return "127.0.0.1";
  if (bindHost === "::" || bindHost === "[::]") return "::1";
  return bindHost;
}

export function bindRefusal(host: string, deviceCount: number): string | null {
  if (isLoopbackHost(host) || deviceCount > 0) return null;
  return `refusing to listen on ${host}: no device tokens exist; create a device token while bound to ${DEFAULT_BIND_HOST} first`;
}
