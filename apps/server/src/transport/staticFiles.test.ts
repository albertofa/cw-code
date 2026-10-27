import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentTypeFor, resolveStaticPath } from "./staticFiles.js";

let uiDir: string;

beforeAll(() => {
  uiDir = mkdtempSync(join(tmpdir(), "cw-static-"));
  mkdirSync(join(uiDir, "assets"));
  writeFileSync(join(uiDir, "index.html"), "<html></html>");
  writeFileSync(join(uiDir, "assets", "x.js"), "export {}");
  writeFileSync(join(uiDir, "favicon.ico"), "ico");
});

afterAll(() => rmSync(uiDir, { recursive: true, force: true }));

describe("resolveStaticPath", () => {
  test("serves index.html at the root", () => {
    expect(resolveStaticPath(uiDir, "/")).toEqual({ kind: "file", path: join(uiDir, "index.html"), immutable: false });
  });

  test("marks files under /assets/ immutable", () => {
    expect(resolveStaticPath(uiDir, "/assets/x.js")).toEqual({ kind: "file", path: join(uiDir, "assets", "x.js"), immutable: true });
    expect(resolveStaticPath(uiDir, "/favicon.ico")).toMatchObject({ kind: "file", immutable: false });
  });

  test("rejects traversal, backslashes, NUL and drive paths", () => {
    for (const pathname of ["/../x", "/assets/../../x", "/%2e%2e/x", "/%2E%2E%2Fx", "/a\\b", "/a%5Cb", "/a%00b", "/C:/Windows/win.ini", "/%E0%A4%A"]) {
      expect(resolveStaticPath(uiDir, pathname)).toEqual({ kind: "bad-request" });
    }
  });

  test("answers not-found for unknown paths and directories", () => {
    expect(resolveStaticPath(uiDir, "/missing.js")).toEqual({ kind: "not-found" });
    expect(resolveStaticPath(uiDir, "/assets")).toEqual({ kind: "not-found" });
    expect(resolveStaticPath(uiDir, "/assets/")).toEqual({ kind: "not-found" });
  });
});

describe("contentTypeFor", () => {
  test("maps known extensions and falls back to octet-stream", () => {
    expect(contentTypeFor("a/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("a/x.MJS")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("a/font.woff2")).toBe("font/woff2");
    expect(contentTypeFor("a/x.wasm")).toBe("application/wasm");
    expect(contentTypeFor("a/x.bin")).toBe("application/octet-stream");
  });
});
