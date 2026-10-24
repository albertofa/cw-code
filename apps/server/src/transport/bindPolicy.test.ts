import { describe, expect, test } from "bun:test";
import { bindRefusal, connectHost, decideBindHost, isLoopbackHost } from "./bindPolicy.js";

describe("decideBindHost", () => {
  test.each([
    [null, undefined, 0, "127.0.0.1"],
    [null, "", 0, "127.0.0.1"],
    [null, "   ", 0, "127.0.0.1"],
    [null, " ::1 ", 0, "::1"],
    [null, " 0.0.0.0 ", 1, "0.0.0.0"],
    ["::1", "0.0.0.0", 0, "::1"],
    ["192.168.1.5", undefined, 2, "192.168.1.5"],
  ])("flag %p and setting %p with %p devices listen on %p", (flag, setting, devices, host) => {
    expect(decideBindHost(flag, setting, devices)).toEqual({ kind: "listen", host });
  });

  test("refuses a non-loopback --host flag without device tokens", () => {
    const decision = decideBindHost("0.0.0.0", undefined, 0);
    expect(decision.kind).toBe("refuse");
    expect(decision.host).toBe("0.0.0.0");
  });

  test("falls back to loopback when the setting asks for a non-loopback host without device tokens", () => {
    expect(decideBindHost(null, " 0.0.0.0 ", 0)).toEqual({
      kind: "fallback",
      host: "127.0.0.1",
      ignoredHost: "0.0.0.0",
      reason: expect.stringContaining("listening on 127.0.0.1 instead"),
    });
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
