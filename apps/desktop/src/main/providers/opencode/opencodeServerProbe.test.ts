import { afterEach, describe, expect, it, vi } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "../../../../tests/testing.js";
import {
  UnsupportedOpencodeServerError,
  basicAuthHeader,
  identifyServer,
  parseStdioServerUrl,
  parseV1Health,
  parseV2Info,
  protocolOfVersion,
  serverAuthEnv,
  waitForServerIdentity
} from "./opencodeServerProbe.js";

afterEach(() => {
  unstubAllGlobals();
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function html(status = 200): Response {
  return new Response("<!doctype html><html></html>", { status, headers: { "content-type": "text/html" } });
}

describe("health response parsing", () => {
  it("reads the v2 /api/info version only from JSON", () => {
    expect(parseV2Info("application/json", { version: "2.0.32", pid: 1, urls: [] })).toBe("2.0.32");
    expect(parseV2Info("text/html", { version: "2.0.32" })).toBeNull();
    expect(parseV2Info("application/json", { pid: 1 })).toBeNull();
  });

  it("requires healthy:true on the v1 /global/health body", () => {
    expect(parseV1Health("application/json; charset=utf-8", { healthy: true, version: "1.19.3" })).toBe("1.19.3");
    expect(parseV1Health("application/json", { healthy: false, version: "1.19.3" })).toBeNull();
    expect(parseV1Health("text/html", { healthy: true, version: "1.19.3" })).toBeNull();
  });

  it("maps a version to its wire protocol by major", () => {
    expect(protocolOfVersion("1.19.3")).toBe("v1");
    expect(protocolOfVersion("v2.0.32")).toBe("v2");
    expect(protocolOfVersion("3.1.0")).toBe("v2");
    expect(protocolOfVersion("dev")).toBeNull();
  });

  it("reads the port from the --stdio address line", () => {
    expect(parseStdioServerUrl('{"url":"http://127.0.0.1:55973"}')).toBe(55973);
    expect(parseStdioServerUrl("server listening on http://127.0.0.1:1")).toBeNull();
    expect(parseStdioServerUrl('{"url":"not a url"}')).toBeNull();
  });
});

describe("server credentials", () => {
  it("builds a Basic header for the opencode user", () => {
    expect(basicAuthHeader("s3cret")).toBe(`Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
  });

  it("passes the password only under the name each version reads", () => {
    expect(serverAuthEnv("pw", "v1")).toEqual({ OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "pw" });
    expect(serverAuthEnv("pw", "v2")).toEqual({ OPENCODE_PASSWORD: "pw" });
  });
});

describe("identifyServer", () => {
  it("detects v2 from /api/info", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ version: "2.0.32", pid: 4, urls: [] }));
    stubGlobal("fetch", fetchMock);
    await expect(identifyServer(4100, "Basic x")).resolves.toEqual({ protocol: "v2", version: "2.0.32" });
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:4100/api/info");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Basic x" });
  });

  it("falls back to /global/health for v1, whose /api/info is the web app", async () => {
    stubGlobal(
      "fetch",
      vi.fn((url: string) => Promise.resolve(url.endsWith("/api/info") ? html() : json({ healthy: true, version: "1.19.3" })))
    );
    await expect(identifyServer(4100, "Basic x")).resolves.toEqual({ protocol: "v1", version: "1.19.3" });
  });

  it("rejects a server that only answers HTML instead of passing the check", async () => {
    stubGlobal("fetch", vi.fn(() => Promise.resolve(html())));
    await expect(identifyServer(4100, "Basic x")).rejects.toBeInstanceOf(UnsupportedOpencodeServerError);
  });

  it("gives up early when a live server keeps answering without a supported protocol", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({ _tag: "UnauthorizedError" }, 401)));
    stubGlobal("fetch", fetchMock);
    await expect(waitForServerIdentity(4100, "Basic x", 60_000, 1)).rejects.toThrow(/GET \/api\/info answered 401/);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("keeps waiting while the port refuses connections", async () => {
    let calls = 0;
    stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        return calls < 3 ? Promise.reject(new TypeError("fetch failed")) : Promise.resolve(json({ version: "2.0.32" }));
      })
    );
    await expect(waitForServerIdentity(4100, "Basic x", 60_000, 1)).resolves.toEqual({ protocol: "v2", version: "2.0.32" });
  });
});
