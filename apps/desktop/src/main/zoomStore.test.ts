import { describe, expect, test } from "bun:test";
import { parseZoom, stepZoom, ZoomStore, type ZoomFs } from "./zoomStore";

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
  test("reads a stored level, including 0 and levels outside the shortcut range", () => {
    expect(parseZoom('{"level":1.5}')).toBe(1.5);
    expect(parseZoom('{"level":0}')).toBe(0);
    expect(parseZoom('{"level":7}')).toBe(7);
  });

  test("returns null for missing or malformed content", () => {
    expect(parseZoom(null)).toBeNull();
    expect(parseZoom("not json")).toBeNull();
    expect(parseZoom("null")).toBeNull();
    expect(parseZoom('{"level":"2"}')).toBeNull();
  });
});

describe("stepZoom", () => {
  test("steps inside the range and stops at its ends", () => {
    expect(stepZoom(1, 0.5)).toBe(1.5);
    expect(stepZoom(5, 0.5)).toBe(5);
    expect(stepZoom(-5, -0.5)).toBe(-5);
  });

  test("a level outside the range never moves against the step", () => {
    expect(stepZoom(7, 0.5)).toBe(7);
    expect(stepZoom(7, -0.5)).toBe(5);
    expect(stepZoom(-7, -0.5)).toBe(-7);
    expect(stepZoom(-7, 0.5)).toBe(-5);
  });
});

describe("ZoomStore", () => {
  test("has no level until one is saved", () => {
    expect(new ZoomStore("/data", memoryFs()).level).toBeNull();
  });

  test("a saved level is read back by a new store, unclamped", () => {
    const fs = memoryFs();
    new ZoomStore("/data", fs).save(7);
    expect(new ZoomStore("/data", fs).level).toBe(7);
  });

  test("saves 0 when nothing was stored, and skips an unchanged level", () => {
    const fs = memoryFs();
    const store = new ZoomStore("/data", fs);
    store.save(0);
    expect(fs.writes).toBe(1);
    store.save(0);
    expect(fs.writes).toBe(1);
    expect(new ZoomStore("/data", fs).level).toBe(0);
  });

  test("an unreadable file reads as no level and is reported", () => {
    const warnings: string[] = [];
    const fs: ZoomFs = {
      read: () => {
        throw new Error("EACCES");
      },
      write: () => {}
    };
    const store = new ZoomStore("/data", fs, (message) => warnings.push(message));
    expect(store.level).toBeNull();
    expect(store.level).toBeNull();
    expect(warnings).toEqual(["zoom level not read: EACCES"]);
  });
});
