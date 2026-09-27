import { describe, expect, it } from "vitest";
import { MAX_RANGES, multipartLayout, parseRangeHeader } from "./feedRange.ts";

describe("parseRangeHeader", () => {
  it("serves the full body without a usable Range header", () => {
    expect(parseRangeHeader(undefined, 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader("", 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader("items=0-5", 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader("bytes=abc", 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader("bytes=-", 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader("bytes=9-3", 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader("bytes=0-5, nonsense", 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader("bytes=99999999999999999999-", 100)).toEqual({ kind: "full" });
  });

  it("parses closed, open and suffix ranges", () => {
    expect(parseRangeHeader("bytes=0-0", 100)).toEqual({ kind: "partial", ranges: [{ start: 0, end: 0 }] });
    expect(parseRangeHeader("bytes=10-19", 100)).toEqual({ kind: "partial", ranges: [{ start: 10, end: 19 }] });
    expect(parseRangeHeader("bytes=90-", 100)).toEqual({ kind: "partial", ranges: [{ start: 90, end: 99 }] });
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({ kind: "partial", ranges: [{ start: 90, end: 99 }] });
    expect(parseRangeHeader("BYTES=5-6", 100)).toEqual({ kind: "partial", ranges: [{ start: 5, end: 6 }] });
  });

  it("clamps ranges that run past the end", () => {
    expect(parseRangeHeader("bytes=95-500", 100)).toEqual({ kind: "partial", ranges: [{ start: 95, end: 99 }] });
    expect(parseRangeHeader("bytes=-500", 100)).toEqual({ kind: "partial", ranges: [{ start: 0, end: 99 }] });
  });

  it("keeps multiple ranges in request order without merging them", () => {
    expect(parseRangeHeader("bytes=50-59, 0-9, 5-14", 100)).toEqual({
      kind: "partial",
      ranges: [
        { start: 50, end: 59 },
        { start: 0, end: 9 },
        { start: 5, end: 14 }
      ]
    });
  });

  it("drops unsatisfiable parts but serves the rest", () => {
    expect(parseRangeHeader("bytes=0-9, 200-300", 100)).toEqual({ kind: "partial", ranges: [{ start: 0, end: 9 }] });
  });

  it("reports unsatisfiable requests", () => {
    expect(parseRangeHeader("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=100-200", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-5", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("refuses more ranges than electron-updater ever sends in one request", () => {
    const specs = Array.from({ length: MAX_RANGES + 1 }, (_, index) => `${index}-${index}`).join(", ");
    expect(parseRangeHeader(`bytes=${specs}`, 10_000)).toEqual({ kind: "unsatisfiable" });
    const allowed = Array.from({ length: MAX_RANGES }, (_, index) => `${index}-${index}`).join(", ");
    expect(parseRangeHeader(`bytes=${allowed}`, 10_000)).toMatchObject({ kind: "partial" });
  });
});

describe("multipartLayout", () => {
  it("lays out parts the way electron-updater's DataSplitter reads them", () => {
    const layout = multipartLayout(
      [
        { start: 0, end: 2 },
        { start: 7, end: 9 }
      ],
      10,
      "B",
      "application/octet-stream"
    );
    expect(layout.parts[0].prefix).toBe("--B\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 0-2/10\r\n\r\n");
    expect(layout.parts[1].prefix).toBe("\r\n--B\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 7-9/10\r\n\r\n");
    expect(layout.epilogue).toBe("\r\n--B--\r\n");
    const body = layout.parts[0].prefix + "abc" + layout.parts[1].prefix + "hij" + layout.epilogue;
    expect(layout.contentLength).toBe(Buffer.byteLength(body));
  });
});
