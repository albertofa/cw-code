import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cspFor, handleHttp, type HttpRoutesOptions } from "./httpRoutes.js";

const TOKEN = "a".repeat(64);
const HOST = "cw.test:8080";
let uiDir: string;
let stops = 0;

function options(dir: string | null): HttpRoutesOptions {
  return { uiDir: dir, info: { app: "cw-code", version: "1.2.3", protocol: 3 }, ownerToken: TOKEN, stop: () => void (stops += 1) };
}

async function call(path: string, init: RequestInit = {}, dir: string | null = uiDir): Promise<Response> {
  const req = new Request(`http://${HOST}${path}`, { ...init, headers: { Host: HOST, ...(init.headers as Record<string, string>) } });
  const response = await handleHttp(req, options(dir));
  if (!response) throw new Error("expected a response");
  return response;
}

beforeAll(() => {
  uiDir = mkdtempSync(join(tmpdir(), "cw-http-"));
  mkdirSync(join(uiDir, "assets"));
  writeFileSync(join(uiDir, "index.html"), "<html>hi</html>");
  writeFileSync(join(uiDir, "assets", "x.js"), "export {}");
});

afterAll(() => rmSync(uiDir, { recursive: true, force: true }));

describe("handleHttp", () => {
  test("leaves /ws to the upgrade path", () => {
    expect(handleHttp(new Request(`http://${HOST}/ws`), options(uiDir))).toBeNull();
  });

  test("serves index.html with CSP and security headers", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>hi</html>");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(cspFor(HOST));
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("serves assets as immutable without CSP", async () => {
    const response = await call("/assets/x.js");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  test("answers HEAD without a body", async () => {
    const response = await call("/", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-length")).toBe("15");
  });

  test("rejects traversal with 400 and unknown paths with 404", async () => {
    expect((await call("/%2e%2e%2fsecret")).status).toBe(400);
    expect((await call("/nope.js")).status).toBe(404);
  });

  test("rejects non-read methods on static paths with 405", async () => {
    const response = await call("/", { method: "PUT" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  test("explains a missing UI bundle at the root", async () => {
    const response = await call("/", {}, null);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("web UI is not bundled");
  });
});

describe("/api/info", () => {
  test("returns the server info without caching", async () => {
    const response = await call("/api/info");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ app: "cw-code", version: "1.2.3", protocol: 3 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("rejects POST with 405", async () => {
    expect((await call("/api/info", { method: "POST" })).status).toBe(405);
  });
});

describe("/api/stop", () => {
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  test("rejects missing and wrong tokens with 401, including different lengths", async () => {
    stops = 0;
    expect((await call("/api/stop", { method: "POST" })).status).toBe(401);
    expect((await call("/api/stop", { method: "POST", headers: bearer("b".repeat(64)) })).status).toBe(401);
    expect((await call("/api/stop", { method: "POST", headers: bearer("short") })).status).toBe(401);
    expect(stops).toBe(0);
  });

  test("rejects a cross-origin request with 403 even with the right token", async () => {
    stops = 0;
    const response = await call("/api/stop", { method: "POST", headers: { ...bearer(TOKEN), Origin: "https://evil.example" } });
    expect(response.status).toBe(403);
    expect(stops).toBe(0);
  });

  test("accepts the owner token, same-origin or without Origin, with 202", async () => {
    stops = 0;
    expect((await call("/api/stop", { method: "POST", headers: bearer(TOKEN) })).status).toBe(202);
    expect((await call("/api/stop", { method: "POST", headers: { ...bearer(TOKEN), Origin: `http://${HOST}` } })).status).toBe(202);
    expect(stops).toBe(2);
  });

  test("rejects GET with 405", async () => {
    expect((await call("/api/stop")).status).toBe(405);
  });
});

describe("cspFor", () => {
  test("lists the host for websockets and drops it when the host is malformed", () => {
    expect(cspFor("a.test:1")).toContain("connect-src 'self' ws://a.test:1 wss://a.test:1;");
    expect(cspFor("a; script-src *")).toContain("connect-src 'self';");
  });
});
