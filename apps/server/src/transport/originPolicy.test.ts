import { describe, expect, test } from "bun:test";
import { createOriginPolicy } from "./originPolicy.js";

describe("createOriginPolicy", () => {
  const allowed = createOriginPolicy(["http://localhost:5173/", " HTTPS://Dev.Example "]);

  test.each([
    [null, "127.0.0.1:4000", true],
    [null, null, true],
    ["file://", "127.0.0.1:4000", true],
    ["http://127.0.0.1:4000", "127.0.0.1:4000", true],
    ["https://cw.example:8443", "CW.example:8443", true],
    ["http://localhost:5173", "127.0.0.1:4000", true],
    ["https://dev.example", "127.0.0.1:4000", true],
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
});
