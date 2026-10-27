import { describe, expect, test } from "bun:test";
import { assertPasteImageSize, isServerInfo, isServerReady, PASTE_IMAGE_MAX_BYTES, PROTOCOL_VERSION, INFO_PATH, STOP_PATH, WS_PATH } from "./protocol.js";

const READY = { url: "ws://127.0.0.1:51234/ws", port: 51234, pid: 4242, protocol: PROTOCOL_VERSION, version: "0.0.1" };

describe("isServerReady", () => {
  test("accepts a complete announcement", () => {
    expect(isServerReady(READY)).toBe(true);
  });

  test("accepts a missing, null or string launcherId", () => {
    expect(isServerReady({ ...READY, launcherId: null })).toBe(true);
    expect(isServerReady({ ...READY, launcherId: "install-1" })).toBe(true);
    expect(isServerReady({ ...READY, launcherId: 7 })).toBe(false);
  });

  test.each([[null], ["ready"], [{ ...READY, port: "51234" }], [{ url: READY.url }], [{ ...READY, version: undefined }]])("rejects %p", (value) => {
    expect(isServerReady(value)).toBe(false);
  });
});

describe("isServerInfo", () => {
  test("accepts the /api/info body", () => {
    expect(isServerInfo({ app: "cw-code", version: "1.2.3", protocol: 3 })).toBe(true);
  });

  test.each([[null], [{ app: "other", version: "1", protocol: 3 }], [{ app: "cw-code", version: 1, protocol: 3 }], [{ app: "cw-code", version: "1" }]])(
    "rejects %p",
    (value) => {
      expect(isServerInfo(value)).toBe(false);
    }
  );
});

describe("assertPasteImageSize", () => {
  test("allows images up to the limit", () => {
    expect(() => assertPasteImageSize(PASTE_IMAGE_MAX_BYTES)).not.toThrow();
  });

  test("rejects larger images with the size and the limit", () => {
    expect(() => assertPasteImageSize(PASTE_IMAGE_MAX_BYTES + 1)).toThrow("pasted images are limited to 32 MB");
    expect(() => assertPasteImageSize(40 * 1024 * 1024)).toThrow("image is 40.0 MB; pasted images are limited to 32 MB");
  });
});

describe("PROTOCOL_VERSION", () => {
  test("is 3 since state topics are pushed as snapshots and patches", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});

describe("HTTP paths", () => {
  test("are absolute and distinct", () => {
    expect([WS_PATH, INFO_PATH, STOP_PATH]).toEqual(["/ws", "/api/info", "/api/stop"]);
  });
});
