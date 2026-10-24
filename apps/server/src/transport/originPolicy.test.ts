import { describe, expect, test } from "bun:test";
import { createOriginPolicy, createRejectedOriginLogger } from "./originPolicy.js";

describe("createOriginPolicy", () => {
  const allowed = createOriginPolicy(["http://localhost:5173/", " HTTPS://Dev.Example/app/ ", "https://port.example:443"]);

  test.each([
    [null, "127.0.0.1:4000", true],
    [null, null, true],
    ["file://", "127.0.0.1:4000", true],
    ["http://127.0.0.1:4000", "127.0.0.1:4000", true],
    ["https://cw.example:8443", "CW.example:8443", true],
    ["http://localhost:5173", "127.0.0.1:4000", true],
    ["https://dev.example", "127.0.0.1:4000", true],
    ["https://port.example", "127.0.0.1:4000", true],
    ["null", "127.0.0.1:4000", false],
    ["https://evil.example", "127.0.0.1:4000", false],
    ["http://127.0.0.1:4001", "127.0.0.1:4000", false],
    ["http://127.0.0.1:4000", null, false],
    ["chrome-extension://abc", "abc", false],
    ["not a url", "127.0.0.1:4000", false],
  ])("origin %p with host %p allowed: %p", (origin, host, expected) => {
    expect(allowed(origin, host)).toBe(expected);
  });

  test("allows only file:// and same-origin without extra origins", () => {
    const policy = createOriginPolicy([]);
    expect(policy("file://", null)).toBe(true);
    expect(policy("http://localhost:5173", "127.0.0.1:4000")).toBe(false);
  });

  test("skips invalid --allow-origin values", () => {
    const policy = createOriginPolicy(["not a url", "chrome-extension://abc", ""]);
    expect(policy("not a url", "127.0.0.1:4000")).toBe(false);
    expect(policy("chrome-extension://abc", "127.0.0.1:4000")).toBe(false);
    expect(policy("null", "127.0.0.1:4000")).toBe(false);
  });

  test("allows Origin: null only when null is listed explicitly", () => {
    expect(createOriginPolicy([" NULL "])("null", "127.0.0.1:4000")).toBe(true);
    expect(createOriginPolicy([])("null", "127.0.0.1:4000")).toBe(false);
  });
});

describe("createRejectedOriginLogger", () => {
  test("records each distinct origin once up to the limit", () => {
    const entries: string[] = [];
    const log = createRejectedOriginLogger((entry) => entries.push(entry), 2);
    log("https://evil.example");
    log("https://evil.example");
    log(null);
    log("https://third.example");
    expect(entries).toEqual([
      'rejected websocket upgrade from origin "https://evil.example"',
      "rejected websocket upgrade from origin null",
    ]);
  });
});
