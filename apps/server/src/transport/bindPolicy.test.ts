import { describe, expect, test } from "bun:test";
import { bindRefusal, connectHost, isLoopbackHost, resolveBindHost } from "./bindPolicy.js";

describe("resolveBindHost", () => {
  test.each([
    [null, undefined, "127.0.0.1"],
    [null, "", "127.0.0.1"],
    [null, "   ", "127.0.0.1"],
    [null, " 0.0.0.0 ", "0.0.0.0"],
    ["::1", "0.0.0.0", "::1"],
    ["192.168.1.5", undefined, "192.168.1.5"],
  ])("flag %p and setting %p resolve to %p", (flag, setting, expected) => {
    expect(resolveBindHost(flag, setting)).toBe(expected);
  });
});

describe("isLoopbackHost", () => {
  test.each([
    ["127.0.0.1", true],
    ["127.10.20.30", true],
    ["127.255.255.255", true],
    ["::1", true],
    ["[::1]", true],
    ["localhost", true],
    ["LOCALHOST", true],
    ["0.0.0.0", false],
    ["::", false],
    ["128.0.0.1", false],
    ["127.0.0.256", false],
    ["127.0.0", false],
    ["192.168.1.5", false],
    ["localhost.example.com", false],
  ])("%p is loopback: %p", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe("connectHost", () => {
  test.each([
    ["0.0.0.0", "127.0.0.1"],
    ["::", "::1"],
    ["[::]", "::1"],
    ["127.0.0.1", "127.0.0.1"],
    ["192.168.1.5", "192.168.1.5"],
  ])("%p connects through %p", (bindHost, expected) => {
    expect(connectHost(bindHost)).toBe(expected);
  });
});

describe("bindRefusal", () => {
  test.each([
    ["127.0.0.1", 0, false],
    ["localhost", 0, false],
    ["::1", 0, false],
    ["0.0.0.0", 0, true],
    ["::", 0, true],
    ["192.168.1.5", 0, true],
    ["0.0.0.0", 1, false],
    ["192.168.1.5", 3, false],
  ])("%p with %p devices refused: %p", (host, devices, refused) => {
    const refusal = bindRefusal(host, devices);
    expect(refusal !== null).toBe(refused);
    if (refusal) expect(refusal).toContain("create a device token while bound to 127.0.0.1 first");
  });
});
