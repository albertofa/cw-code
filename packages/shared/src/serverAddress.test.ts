import { describe, expect, test } from "bun:test";
import { pairingLink, parseServerAddress, tokenFromHash, wsUrlFromPage } from "./serverAddress.js";

describe("parseServerAddress", () => {
  test("maps http and https to ws and wss", () => {
    expect(parseServerAddress("http://127.0.0.1:4100")).toEqual({ httpUrl: "http://127.0.0.1:4100", wsUrl: "ws://127.0.0.1:4100/ws", token: null });
    expect(parseServerAddress("https://box.example/")).toEqual({ httpUrl: "https://box.example", wsUrl: "wss://box.example/ws", token: null });
  });

  test("maps a ws or wss socket URL back to its base", () => {
    expect(parseServerAddress("ws://box.example:4100/ws")).toEqual({ httpUrl: "http://box.example:4100", wsUrl: "ws://box.example:4100/ws", token: null });
    expect(parseServerAddress("wss://box.example/cw/ws")).toEqual({ httpUrl: "https://box.example/cw", wsUrl: "wss://box.example/cw/ws", token: null });
  });

  test("keeps a base path", () => {
    expect(parseServerAddress("https://box.example/cw/")).toEqual({ httpUrl: "https://box.example/cw", wsUrl: "wss://box.example/cw/ws", token: null });
  });

  test("reads the token from the hash and ignores the query", () => {
    expect(parseServerAddress("  https://box.example/cw/?x=1#token=abc123  ")).toEqual({
      httpUrl: "https://box.example/cw",
      wsUrl: "wss://box.example/cw/ws",
      token: "abc123"
    });
  });

  test("rejects credentials, other schemes and garbage", () => {
    expect(parseServerAddress("https://user:pass@box.example/")).toHaveProperty("error");
    expect(parseServerAddress("https://user@box.example/")).toHaveProperty("error");
    expect(parseServerAddress("ftp://box.example/")).toHaveProperty("error");
    expect(parseServerAddress("not a url")).toHaveProperty("error");
    expect(parseServerAddress("")).toHaveProperty("error");
  });
});

describe("tokenFromHash", () => {
  test("returns the token or null", () => {
    expect(tokenFromHash("#token=abc")).toBe("abc");
    expect(tokenFromHash("token=abc")).toBe("abc");
    expect(tokenFromHash("#token=")).toBeNull();
    expect(tokenFromHash("#other=1")).toBeNull();
    expect(tokenFromHash("")).toBeNull();
  });
});

describe("wsUrlFromPage", () => {
  test("resolves the socket next to the page", () => {
    expect(wsUrlFromPage("https://h/cw/")).toBe("wss://h/cw/ws");
    expect(wsUrlFromPage("https://h/cw/index.html#token=abc")).toBe("wss://h/cw/ws");
    expect(wsUrlFromPage("http://127.0.0.1:4100/")).toBe("ws://127.0.0.1:4100/ws");
  });
});

describe("pairingLink", () => {
  test("appends the token as a hash to the public URL", () => {
    expect(pairingLink("https://box.example/cw", "abc123")).toBe("https://box.example/cw/#token=abc123");
    expect(pairingLink("https://box.example/", "abc123")).toBe("https://box.example/#token=abc123");
  });

  test("round-trips through parseServerAddress", () => {
    expect(parseServerAddress(pairingLink("https://box.example/cw", "a+b/c"))).toEqual({
      httpUrl: "https://box.example/cw",
      wsUrl: "wss://box.example/cw/ws",
      token: "a+b/c"
    });
  });
});
