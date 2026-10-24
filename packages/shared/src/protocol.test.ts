import { describe, expect, test } from "bun:test";
import { assertPasteImageSize, isServerReady, PASTE_IMAGE_MAX_BYTES } from "./protocol.js";

const READY = { url: "ws://127.0.0.1:51234/ws", port: 51234, pid: 4242, protocol: 1, version: "0.0.1" };

describe("isServerReady", () => {
  test("accepts a complete announcement", () => {
    expect(isServerReady(READY)).toBe(true);
  });

  test.each([[null], ["ready"], [{ ...READY, port: "51234" }], [{ url: READY.url }], [{ ...READY, version: undefined }]])("rejects %p", (value) => {
    expect(isServerReady(value)).toBe(false);
  });
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
