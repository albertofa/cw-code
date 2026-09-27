import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFaults } from "./feedFaults.ts";
import { type FeedServer, FEED_HOST, startFeedServer, summarizeTransfers } from "./feedServer.ts";

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  aborted: boolean;
}

function fetchRaw(server: FeedServer, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: FEED_HOST, port: server.port, path, method: options.method ?? "GET", headers: options.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        let aborted = false;
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("aborted", () => {
          aborted = true;
        });
        res.on("error", () => {
          aborted = true;
        });
        res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), aborted: aborted || !res.complete }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function parseMultipart(body: Buffer, boundary: string): Array<{ contentRange: string; data: Buffer }> {
  const text = body.toString("latin1");
  const delimiter = `--${boundary}`;
  const pieces = text.split(delimiter).slice(1);
  const parts: Array<{ contentRange: string; data: Buffer }> = [];
  for (const piece of pieces) {
    if (piece.startsWith("--")) break;
    const headerEnd = piece.indexOf("\r\n\r\n");
    const headers = piece.slice(2, headerEnd);
    const data = piece.slice(headerEnd + 4).replace(/\r\n$/, "");
    const contentRange = /Content-Range: (.+)/.exec(headers)?.[1] ?? "";
    parts.push({ contentRange, data: Buffer.from(data, "latin1") });
  }
  return parts;
}

describe("startFeedServer", () => {
  let root: string;
  let server: FeedServer | null = null;
  const payload = randomBytes(300_000);
  const INSTALLER = "cw-code-updatetest-Setup-1.0.0-alpha.2-x64.exe";

  async function start(faults: unknown = []): Promise<FeedServer> {
    server = await startFeedServer({ root, faults: parseFaults(faults) });
    return server;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cw-feed-server-"));
    await writeFile(join(root, INSTALLER), payload);
    await writeFile(join(root, "alpha.yml"), "version: 1.0.0-alpha.2\n");
    await mkdir(join(root, "stale"));
    await writeFile(join(root, "stale", "alpha.yml"), "version: 1.0.0-alpha.1\n");
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await rm(root, { recursive: true, force: true });
  });

  it("binds to the loopback address only", async () => {
    const feed = await start();
    expect(feed.url).toBe(`http://127.0.0.1:${feed.port}/`);
  });

  it("serves full files with length, validators and range support advertised", async () => {
    const feed = await start();
    const response = await fetchRaw(feed, `/${INSTALLER}?noCache=abc`);
    expect(response.status).toBe(200);
    expect(response.body.equals(payload)).toBe(true);
    expect(response.headers["content-length"]).toBe(String(payload.length));
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers.etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(response.headers["last-modified"]).toBeTruthy();
  });

  it("answers HEAD with headers and no body", async () => {
    const feed = await start();
    const response = await fetchRaw(feed, `/${INSTALLER}`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers["content-length"]).toBe(String(payload.length));
    expect(response.body.length).toBe(0);
    await feed.idle();
    expect(feed.requests().at(-1)).toMatchObject({ method: "HEAD", bytes: 0 });
  });

  it("serves a single range as 206 with Content-Range", async () => {
    const feed = await start();
    const response = await fetchRaw(feed, `/${INSTALLER}`, { headers: { Range: "bytes=100-199" } });
    expect(response.status).toBe(206);
    expect(response.headers["content-range"]).toBe(`bytes 100-199/${payload.length}`);
    expect(response.body.equals(payload.subarray(100, 200))).toBe(true);
  });

  it("serves multiple ranges as multipart/byteranges in request order", async () => {
    const feed = await start();
    const response = await fetchRaw(feed, `/${INSTALLER}`, { headers: { Range: "bytes=5000-5099, 0-9, 299990-" } });
    expect(response.status).toBe(206);
    const boundary = /boundary=(.+)$/.exec(String(response.headers["content-type"]))?.[1] ?? "";
    expect(boundary).not.toBe("");
    expect(response.headers["content-length"]).toBe(String(response.body.length));
    const parts = parseMultipart(response.body, boundary);
    expect(parts.map((part) => part.contentRange)).toEqual([
      `bytes 5000-5099/${payload.length}`,
      `bytes 0-9/${payload.length}`,
      `bytes 299990-299999/${payload.length}`
    ]);
    expect(parts[0].data.equals(payload.subarray(5000, 5100))).toBe(true);
    expect(parts[1].data.equals(payload.subarray(0, 10))).toBe(true);
    expect(parts[2].data.equals(payload.subarray(299990))).toBe(true);
  });

  it("answers 416 with the file size for unsatisfiable ranges", async () => {
    const feed = await start();
    const response = await fetchRaw(feed, `/${INSTALLER}`, { headers: { Range: `bytes=${payload.length}-` } });
    expect(response.status).toBe(416);
    expect(response.headers["content-range"]).toBe(`bytes */${payload.length}`);
  });

  it("rejects traversal, foreign hosts and other methods", async () => {
    const feed = await start();
    expect((await fetchRaw(feed, "/../package.json")).status).toBe(400);
    expect((await fetchRaw(feed, "/%2e%2e/package.json")).status).toBe(400);
    expect((await fetchRaw(feed, "/C:/Windows/win.ini")).status).toBe(400);
    expect((await fetchRaw(feed, "/alpha.yml", { headers: { Host: "attacker.example" } })).status).toBe(403);
    expect((await fetchRaw(feed, "/alpha.yml", { method: "PUT" })).status).toBe(405);
    expect((await fetchRaw(feed, "/missing.yml")).status).toBe(404);
  });

  it("logs every request with the bytes actually sent", async () => {
    const feed = await start();
    await fetchRaw(feed, `/${INSTALLER}`, { headers: { Range: "bytes=0-99" } });
    await fetchRaw(feed, `/${INSTALLER}`);
    await fetchRaw(feed, "/alpha.yml");
    await feed.idle();
    const summary = summarizeTransfers(feed.requests());
    expect(summary).toEqual([
      { path: "alpha.yml", requests: 1, rangeRequests: 0, bytes: 23, statuses: [200] },
      { path: INSTALLER, requests: 2, rangeRequests: 1, bytes: 100 + payload.length, statuses: [206, 200] }
    ]);
  });

  describe("faults", () => {
    it("answers 503 for an unavailable feed, only as many times as configured", async () => {
      const feed = await start([{ type: "unavailable", path: "alpha.yml", times: 1 }]);
      const first = await fetchRaw(feed, "/alpha.yml");
      expect(first.status).toBe(503);
      expect(first.headers["retry-after"]).toBe("1");
      expect((await fetchRaw(feed, "/alpha.yml")).status).toBe(200);
      await feed.idle();
      expect(feed.requests().map((entry) => entry.fault)).toEqual(["unavailable", null]);
    });

    it("resets the connection when asked to", async () => {
      const feed = await start([{ type: "unavailable", path: "alpha.yml", mode: "reset" }]);
      await expect(fetchRaw(feed, "/alpha.yml")).rejects.toThrow();
      await feed.idle();
      expect(feed.requests()[0]).toMatchObject({ status: 0, fault: "unavailable" });
    });

    it("hides an existing file as missing", async () => {
      const feed = await start([{ type: "missing", path: "*.exe" }]);
      expect((await fetchRaw(feed, `/${INSTALLER}`)).status).toBe(404);
    });

    it("truncates the body after the configured number of bytes and drops the connection", async () => {
      const feed = await start([{ type: "truncate", path: "*.exe", bytes: 1000 }]);
      const response = await fetchRaw(feed, `/${INSTALLER}`);
      expect(response.status).toBe(200);
      expect(response.headers["content-length"]).toBe(String(payload.length));
      expect(response.body.length).toBe(1000);
      expect(response.aborted).toBe(true);
      await feed.idle();
      expect(feed.requests()[0]).toMatchObject({ bytes: 1000, fault: "truncate" });
    });

    it("truncates range responses too", async () => {
      const feed = await start([{ type: "truncate", path: "*.exe", bytes: 10 }]);
      const response = await fetchRaw(feed, `/${INSTALLER}`, { headers: { Range: "bytes=0-99" } });
      expect(response.body.length).toBe(10);
      expect(response.aborted).toBe(true);
    });

    it("corrupts bytes at fixed file offsets in full and range responses", async () => {
      const feed = await start([{ type: "corrupt", path: "*.exe", offset: 150, length: 2 }]);
      const full = await fetchRaw(feed, `/${INSTALLER}`);
      const expected = Buffer.from(payload);
      expected[150] ^= 0xff;
      expected[151] ^= 0xff;
      expect(full.body.equals(expected)).toBe(true);
      const range = await fetchRaw(feed, `/${INSTALLER}`, { headers: { Range: "bytes=100-199" } });
      expect(range.body.equals(expected.subarray(100, 200))).toBe(true);
    });

    it("serves an alternate manifest for a stale-manifest fault", async () => {
      const feed = await start([{ type: "stale-manifest", path: "alpha.yml", serve: "stale/alpha.yml" }]);
      const response = await fetchRaw(feed, "/alpha.yml");
      expect(response.body.toString()).toBe("version: 1.0.0-alpha.1\n");
      await feed.idle();
      expect(feed.requests()[0]).toMatchObject({ path: "/alpha.yml", servedPath: "stale/alpha.yml", fault: "stale-manifest" });
    });

    it("throttles slow responses to roughly the configured rate", async () => {
      const feed = await start([{ type: "slow", path: "alpha.yml", bytesPerSecond: 40 }]);
      const startedAt = Date.now();
      const response = await fetchRaw(feed, "/alpha.yml");
      expect(response.body.toString()).toBe("version: 1.0.0-alpha.2\n");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    });
  });
});
