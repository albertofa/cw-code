import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type FeedFault, type FeedFaultType, FaultPlan, corruptChunk } from "./feedFaults.ts";
import { type ByteRange, contentRange, multipartLayout, parseRangeHeader, rangeLength } from "./feedRange.ts";
import { feedSegments, resolveFeedFile } from "./feedSandbox.ts";

export const FEED_HOST = "127.0.0.1";

export interface FeedRequestLogEntry {
  at: string;
  method: string;
  path: string;
  servedPath: string | null;
  range: string | null;
  status: number;
  bytes: number;
  fault: FeedFaultType | null;
  durationMs: number;
}

export interface FeedServerOptions {
  root: string;
  port?: number;
  faults?: FeedFault[];
  onRequest?: (entry: FeedRequestLogEntry) => void;
}

export interface FeedServer {
  url: string;
  port: number;
  requests(): FeedRequestLogEntry[];
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface FeedTransferSummary {
  path: string;
  requests: number;
  rangeRequests: number;
  bytes: number;
  statuses: number[];
}

type BodySegment = Buffer | ByteRange;

interface BodyPlan {
  status: number;
  headers: Record<string, string>;
  segments: BodySegment[];
}

const CHUNK_BYTES = 64 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  return host === `${FEED_HOST}:${port}` || host === `localhost:${port}`;
}

function requestPath(rawUrl: string | undefined): string | null {
  if (rawUrl === undefined || !rawUrl.startsWith("/")) return null;
  const end = rawUrl.search(/[?#]/);
  return end === -1 ? rawUrl : rawUrl.slice(0, end);
}

function planBody(file: { path: string; size: number; mtimeMs: number }, rangeHeader: string | undefined): BodyPlan {
  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    ETag: `"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`,
    "Last-Modified": new Date(file.mtimeMs).toUTCString()
  };
  const contentType = contentTypeOf(file.path);
  const request = parseRangeHeader(rangeHeader, file.size);
  if (request.kind === "unsatisfiable") {
    return { status: 416, headers: { ...headers, "Content-Range": `bytes */${file.size}`, "Content-Length": "0" }, segments: [] };
  }
  if (request.kind === "full") {
    const segments = file.size === 0 ? [] : [{ start: 0, end: file.size - 1 }];
    return { status: 200, headers: { ...headers, "Content-Type": contentType, "Content-Length": String(file.size) }, segments };
  }
  if (request.ranges.length === 1) {
    const [range] = request.ranges;
    return {
      status: 206,
      headers: { ...headers, "Content-Type": contentType, "Content-Range": contentRange(range, file.size), "Content-Length": String(rangeLength(range)) },
      segments: [range]
    };
  }
  const boundary = `cw-feed-${randomBytes(12).toString("hex")}`;
  const layout = multipartLayout(request.ranges, file.size, boundary, contentType);
  const segments: BodySegment[] = [];
  for (const part of layout.parts) segments.push(Buffer.from(part.prefix), part.range);
  segments.push(Buffer.from(layout.epilogue));
  return {
    status: 206,
    headers: { ...headers, "Content-Type": `multipart/byteranges; boundary=${boundary}`, "Content-Length": String(layout.contentLength) },
    segments
  };
}

async function writeChunk(response: ServerResponse, chunk: Buffer): Promise<void> {
  if (!response.write(chunk)) await once(response, "drain");
}

async function* segmentChunks(path: string, segment: BodySegment, chunkBytes: number): AsyncGenerator<{ data: Buffer; fileOffset: number | null }> {
  if (Buffer.isBuffer(segment)) {
    yield { data: segment, fileOffset: null };
    return;
  }
  let fileOffset = segment.start;
  for await (const chunk of createReadStream(path, { start: segment.start, end: segment.end, highWaterMark: chunkBytes })) {
    const data = chunk as Buffer;
    yield { data, fileOffset };
    fileOffset += data.length;
  }
}

async function streamBody(response: ServerResponse, path: string, plan: BodyPlan, fault: FeedFault | null): Promise<{ written: number; complete: boolean }> {
  const limit = fault?.type === "truncate" ? fault.bytes : Number.POSITIVE_INFINITY;
  const rate = fault?.type === "slow" ? fault.bytesPerSecond : null;
  const chunkBytes = rate === null ? CHUNK_BYTES : Math.max(1, Math.min(CHUNK_BYTES, Math.floor(rate / 4)));
  const startedAt = Date.now();
  let written = 0;
  for (const segment of plan.segments) {
    for await (const { data, fileOffset } of segmentChunks(path, segment, chunkBytes)) {
      if (response.destroyed) return { written, complete: false };
      let chunk = fault?.type === "corrupt" && fileOffset !== null ? corruptChunk(data, fileOffset, fault) : data;
      if (written + chunk.length > limit) {
        chunk = chunk.subarray(0, limit - written);
        response.flushHeaders();
        if (chunk.length > 0) await new Promise<void>((resolveWrite) => response.write(chunk, () => resolveWrite()));
        return { written: written + chunk.length, complete: false };
      }
      await writeChunk(response, chunk);
      written += chunk.length;
      if (rate !== null) await sleep(Math.max(0, (written / rate) * 1000 - (Date.now() - startedAt)));
    }
  }
  return { written, complete: true };
}

export function summarizeTransfers(entries: FeedRequestLogEntry[]): FeedTransferSummary[] {
  const byPath = new Map<string, FeedTransferSummary>();
  for (const entry of entries) {
    const key = entry.servedPath ?? entry.path;
    const summary = byPath.get(key) ?? { path: key, requests: 0, rangeRequests: 0, bytes: 0, statuses: [] };
    summary.requests += 1;
    if (entry.range !== null) summary.rangeRequests += 1;
    summary.bytes += entry.bytes;
    if (!summary.statuses.includes(entry.status)) summary.statuses.push(entry.status);
    byPath.set(key, summary);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function startFeedServer(options: FeedServerOptions): Promise<FeedServer> {
  const plan = new FaultPlan(options.faults ?? []);
  const log: FeedRequestLogEntry[] = [];
  let port = options.port ?? 0;

  const record = (entry: Omit<FeedRequestLogEntry, "at" | "durationMs">, startedAt: number): void => {
    const full: FeedRequestLogEntry = { at: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, ...entry };
    log.push(full);
    options.onRequest?.(full);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const startedAt = Date.now();
    const method = request.method ?? "GET";
    const rawPath = requestPath(request.url) ?? String(request.url);
    const rangeHeader = typeof request.headers.range === "string" ? request.headers.range : undefined;
    const base = { method, path: rawPath, range: rangeHeader ?? null };
    const reply = (status: number, servedPath: string | null, fault: FeedFaultType | null, extra: Record<string, string> = {}): void => {
      response.writeHead(status, { "Content-Length": "0", "Cache-Control": "no-store", ...extra });
      record({ ...base, servedPath, status, bytes: 0, fault }, startedAt);
      response.end();
    };

    if (!isAllowedHost(request.headers.host, port)) return reply(403, null, null);
    if (method !== "GET" && method !== "HEAD") return reply(405, null, null, { Allow: "GET, HEAD" });
    const path = requestPath(request.url);
    const segments = path === null ? null : feedSegments(path);
    if (segments === null || !segments.ok) return reply(400, null, null);
    const relativePath = segments.segments.join("/");
    const fault = plan.take(relativePath);

    if (fault?.type === "unavailable" && fault.mode === "reset") {
      record({ ...base, servedPath: relativePath, status: 0, bytes: 0, fault: fault.type }, startedAt);
      request.socket.destroy();
      return;
    }
    if (fault?.type === "unavailable") return reply(503, relativePath, fault.type, { "Retry-After": "1" });
    if (fault?.type === "missing") return reply(404, relativePath, fault.type);

    const servedPath = fault?.type === "stale-manifest" ? fault.serve : relativePath;
    const file = await resolveFeedFile(options.root, `/${servedPath}`);
    if (!file.ok) return reply(file.status, servedPath, fault?.type ?? null);

    const body = planBody(file, rangeHeader);
    response.writeHead(body.status, body.headers);
    const streamed = method === "HEAD" ? { written: 0, complete: true } : await streamBody(response, file.path, body, fault);
    record({ ...base, servedPath: file.relativePath, status: body.status, bytes: streamed.written, fault: fault?.type ?? null }, startedAt);
    if (streamed.complete) response.end();
    else response.destroy();
  };

  const inflight = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const task: Promise<void> = handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Length": "0" });
        response.end();
      } else {
        response.destroy();
      }
    });
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  });

  server.listen(port, FEED_HOST);
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://${FEED_HOST}:${port}/`,
    port,
    requests: () => [...log],
    idle: async () => {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolve())));
    }
  };
}
