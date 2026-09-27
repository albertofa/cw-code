export type FeedFault =
  | { type: "unavailable"; path: string; mode: "503" | "reset"; times: number | null }
  | { type: "missing"; path: string; times: number | null }
  | { type: "truncate"; path: string; bytes: number; times: number | null }
  | { type: "corrupt"; path: string; offset: number; length: number; times: number | null }
  | { type: "stale-manifest"; path: string; serve: string; times: number | null }
  | { type: "slow"; path: string; bytesPerSecond: number; times: number | null };

export type FeedFaultType = FeedFault["type"];

const FAULT_TYPES: readonly FeedFaultType[] = ["unavailable", "missing", "truncate", "corrupt", "stale-manifest", "slow"];
const PATH_PATTERN = /^[A-Za-z0-9*][A-Za-z0-9._*/-]*$/;

function describe(index: number): string {
  return `faults[${index}]`;
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string, where: string, fallback?: number): number {
  const value = record[key] ?? fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where}.${key} must be a non-negative integer`);
  }
  return value;
}

function readTimes(record: Record<string, unknown>, where: string): number | null {
  if (record.times === undefined || record.times === null) return null;
  const times = readNonNegativeInteger(record, "times", where);
  if (times === 0) throw new Error(`${where}.times must be at least 1 when set`);
  return times;
}

function readPath(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || !PATH_PATTERN.test(value) || value.split("/").some((segment) => segment === "" || segment === "..")) {
    throw new Error(`${where}.${key} must be a feed-relative path or pattern without "..", got ${JSON.stringify(value)}`);
  }
  return value;
}

function parseFault(raw: unknown, index: number): FeedFault {
  const where = describe(index);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !FAULT_TYPES.includes(type as FeedFaultType)) {
    throw new Error(`${where}.type must be one of ${FAULT_TYPES.join(", ")}`);
  }
  const path = readPath(record, "path", where);
  const times = readTimes(record, where);
  switch (type as FeedFaultType) {
    case "unavailable": {
      const mode = record.mode ?? "503";
      if (mode !== "503" && mode !== "reset") throw new Error(`${where}.mode must be "503" or "reset"`);
      return { type: "unavailable", path, mode, times };
    }
    case "missing":
      return { type: "missing", path, times };
    case "truncate":
      return { type: "truncate", path, bytes: readNonNegativeInteger(record, "bytes", where), times };
    case "corrupt": {
      const length = readNonNegativeInteger(record, "length", where, 1);
      if (length === 0) throw new Error(`${where}.length must be at least 1`);
      return { type: "corrupt", path, offset: readNonNegativeInteger(record, "offset", where, 0), length, times };
    }
    case "stale-manifest": {
      const serve = readPath(record, "serve", where);
      if (serve.includes("*")) throw new Error(`${where}.serve must be a file path, not a pattern`);
      return { type: "stale-manifest", path, serve, times };
    }
    case "slow": {
      const bytesPerSecond = readNonNegativeInteger(record, "bytesPerSecond", where);
      if (bytesPerSecond === 0) throw new Error(`${where}.bytesPerSecond must be at least 1`);
      return { type: "slow", path, bytesPerSecond, times };
    }
  }
}

export function parseFaults(raw: unknown): FeedFault[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("faults must be a JSON array");
  return raw.map((entry, index) => parseFault(entry, index));
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`);
}

export class FaultPlan {
  private readonly entries: Array<{ fault: FeedFault; matcher: RegExp; remaining: number | null }>;

  constructor(faults: FeedFault[]) {
    this.entries = faults.map((fault) => ({ fault, matcher: patternToRegExp(fault.path), remaining: fault.times }));
  }

  take(relativePath: string): FeedFault | null {
    for (const entry of this.entries) {
      if (!entry.matcher.test(relativePath)) continue;
      if (entry.remaining === 0) continue;
      if (entry.remaining !== null) entry.remaining -= 1;
      return entry.fault;
    }
    return null;
  }
}

export function corruptChunk(chunk: Buffer, chunkOffset: number, fault: { offset: number; length: number }): Buffer {
  const start = Math.max(fault.offset, chunkOffset);
  const end = Math.min(fault.offset + fault.length, chunkOffset + chunk.length);
  if (start >= end) return chunk;
  const copy = Buffer.from(chunk);
  for (let position = start; position < end; position++) copy[position - chunkOffset] ^= 0xff;
  return copy;
}
