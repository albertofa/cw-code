import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type ClientRequest, type IncomingMessage, type RequestOptions, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { type BlockMap, CancellationToken, type DownloadOptions, HttpExecutor, configureRequestOptions, configureRequestUrl } from "builder-util-runtime";
import { GenericDifferentialDownloader } from "electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadElectronBuilderBlockMap } from "./blockMapBuilder.ts";
import { parseFaults } from "./feedFaults.ts";
import { type FeedServer, startFeedServer, summarizeTransfers } from "./feedServer.ts";

const DESKTOP_PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/desktop/package.json");
const OLD_NAME = "app-Setup-1.0.0-alpha.1-x64.exe";
const NEW_NAME = "app-Setup-1.0.0-alpha.2-x64.exe";

class NodeHttpExecutor extends HttpExecutor<ClientRequest> {
  createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest {
    return httpRequest(options, callback);
  }

  download(url: URL, destination: string, options: DownloadOptions): Promise<string> {
    return options.cancellationToken.createPromise<string>((resolvePromise, rejectPromise, onCancel) => {
      const requestOptions: RequestOptions = { headers: options.headers ?? undefined };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(
        requestOptions,
        { destination, options, onCancel, responseHandler: null, callback: (error) => (error ? rejectPromise(error) : resolvePromise(destination)) },
        0
      );
    });
  }
}

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function sha512(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

async function readBlockMap(path: string): Promise<BlockMap> {
  return JSON.parse(gunzipSync(await readFile(path)).toString("utf8")) as BlockMap;
}

describe("feed server against electron-updater 6.8.9 download code", () => {
  let dir: string;
  let oldBytes: Buffer;
  let newBytes: Buffer;
  let oldBlockMap: BlockMap;
  let newBlockMap: BlockMap;
  const executor = new NodeHttpExecutor();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cw-feed-contract-"));
    oldBytes = randomBytes(3 * 1024 * 1024);
    newBytes = Buffer.concat([oldBytes.subarray(0, 1_000_000), randomBytes(150_000), oldBytes.subarray(1_100_000, 2_400_000), randomBytes(40_000), oldBytes.subarray(2_400_000)]);
    await writeFile(join(dir, OLD_NAME), oldBytes);
    await writeFile(join(dir, NEW_NAME), newBytes);
    const blockMap = loadElectronBuilderBlockMap(DESKTOP_PACKAGE_JSON);
    await blockMap.build(join(dir, OLD_NAME), join(dir, `${OLD_NAME}.blockmap`));
    await blockMap.build(join(dir, NEW_NAME), join(dir, `${NEW_NAME}.blockmap`));
    oldBlockMap = await readBlockMap(join(dir, `${OLD_NAME}.blockmap`));
    newBlockMap = await readBlockMap(join(dir, `${NEW_NAME}.blockmap`));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function withFeed<T>(faults: unknown, run: (feed: FeedServer) => Promise<T>): Promise<T> {
    const feed = await startFeedServer({ root: dir, faults: parseFaults(faults) });
    try {
      return await run(feed);
    } finally {
      await feed.close();
    }
  }

  function differential(feed: FeedServer, output: string, multipleRanges: boolean): Promise<unknown> {
    const downloader = new GenericDifferentialDownloader({ size: newBytes.length, sha512: sha512(newBytes) }, executor, {
      newUrl: new URL(NEW_NAME, feed.url),
      oldFile: join(dir, OLD_NAME),
      newFile: output,
      logger: silentLogger,
      requestHeaders: null,
      isUseMultipleRangeRequest: multipleRanges,
      cancellationToken: new CancellationToken()
    });
    return downloader.download(oldBlockMap, newBlockMap);
  }

  it.each([
    ["multipart range requests", true],
    ["one range per request", false]
  ])("rebuilds the new installer differentially with %s", async (_label, multipleRanges) => {
    await withFeed([], async (feed) => {
      const output = join(dir, `differential-${String(multipleRanges)}.exe`);
      await differential(feed, output, multipleRanges);
      expect(sha512(await readFile(output))).toBe(sha512(newBytes));
      await feed.idle();
      const [transfer] = summarizeTransfers(feed.requests());
      expect(transfer.path).toBe(NEW_NAME);
      expect(transfer.statuses).toEqual([206]);
      expect(transfer.bytes).toBeGreaterThan(190_000);
      expect(transfer.bytes).toBeLessThan(newBytes.length / 4);
    });
  });

  it("fails the differential download when ranges arrive corrupted", async () => {
    await withFeed([{ type: "corrupt", path: NEW_NAME, offset: 1_050_000, length: 4 }], async (feed) => {
      await expect(differential(feed, join(dir, "differential-corrupt.exe"), true)).rejects.toThrow(/sha512 checksum mismatch/);
    });
  });

  it("fails the differential download when a range response is cut short", async () => {
    await withFeed([{ type: "truncate", path: NEW_NAME, bytes: 50_000 }], async (feed) => {
      await expect(differential(feed, join(dir, "differential-truncated.exe"), false)).rejects.toThrow();
    });
  });

  it("downloads and verifies the full installer", async () => {
    await withFeed([], async (feed) => {
      const output = join(dir, "full.exe");
      await executor.download(new URL(NEW_NAME, feed.url), output, { sha512: sha512(newBytes), cancellationToken: new CancellationToken() });
      expect(sha512(await readFile(output))).toBe(sha512(newBytes));
      await feed.idle();
      expect(summarizeTransfers(feed.requests())[0].bytes).toBe(newBytes.length);
    });
  });

  it.each([
    ["corrupted", [{ type: "corrupt", path: NEW_NAME, offset: 10, length: 1 }]],
    ["truncated", [{ type: "truncate", path: NEW_NAME, bytes: 100_000 }]],
    ["missing", [{ type: "missing", path: NEW_NAME }]],
    ["unavailable", [{ type: "unavailable", path: NEW_NAME }]]
  ])("rejects a %s full download", async (_label, faults) => {
    await withFeed(faults, async (feed) => {
      await expect(
        executor.download(new URL(NEW_NAME, feed.url), join(dir, "full-fault.exe"), { sha512: sha512(newBytes), cancellationToken: new CancellationToken() })
      ).rejects.toThrow();
    });
  });
});
