import { describe, expect, test } from "bun:test";
import { parseZoom, ZoomStore, type ZoomFs } from "./zoomStore";

function memoryFs(initial: string | null = null): ZoomFs & { data: string | null; writes: number } {
  const fs = {
    data: initial,
    writes: 0,
    read: () => fs.data,
    write: (_path: string, data: string) => {
      fs.data = data;
      fs.writes += 1;
    }
  };
  return fs;
}

describe("parseZoom", () => {
  test("reads a stored level", () => {
    expect(parseZoom('{"level":1.5}')).toBe(1.5);
  });

  test("falls back to 0 for missing or malformed content", () => {
    expect(parseZoom(null)).toBe(0);
    expect(parseZoom("not json")).toBe(0);
    expect(parseZoom("null")).toBe(0);
    expect(parseZoom('{"level":"2"}')).toBe(0);
  });

  test("clamps out-of-range levels", () => {
    expect(parseZoom('{"level":40}')).toBe(5);
    expect(parseZoom('{"level":-40}')).toBe(-5);
  });
});

describe("ZoomStore", () => {
  test("a saved level is read back by a new store", () => {
    const fs = memoryFs();
    new ZoomStore("/data", fs).save(2);
    expect(new ZoomStore("/data", fs).level).toBe(2);
  });

  test("does not write an unchanged level", () => {
    const fs = memoryFs('{"level":1}');
    const store = new ZoomStore("/data", fs);
    store.save(1);
    expect(fs.writes).toBe(0);
    store.save(0);
    expect(fs.writes).toBe(1);
    expect(store.level).toBe(0);
  });
});
