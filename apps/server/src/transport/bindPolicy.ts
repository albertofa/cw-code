export const DEFAULT_BIND_HOST = "127.0.0.1";

const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export type BindDecision =
  | { kind: "listen"; host: string }
  | { kind: "refuse"; host: string; reason: string }
  | { kind: "fallback"; host: string; ignoredHost: string; reason: string };

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

export function decideBindHost(flag: string | null, setting: string | undefined, deviceCount: number): BindDecision {
  if (flag !== null) {
    const reason = bindRefusal(flag, deviceCount);
    return reason ? { kind: "refuse", host: flag, reason } : { kind: "listen", host: flag };
  }
  const host = setting?.trim() || DEFAULT_BIND_HOST;
  if (!bindRefusal(host, deviceCount)) return { kind: "listen", host };
  const reason = `ignoring the serverBindHost setting ${host}: no device tokens exist; listening on ${DEFAULT_BIND_HOST} instead`;
  return { kind: "fallback", host: DEFAULT_BIND_HOST, ignoredHost: host, reason };
}
