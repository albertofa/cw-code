import { describe, expect, it } from "bun:test";
import { LatestClientSize } from "./ptySize.js";

describe("LatestClientSize", () => {
  it("applies the first client's size and only records a second client's resize", () => {
    const sizes = new LatestClientSize();
    expect(sizes.resize("a", { cols: 100, rows: 40 })).toEqual({ cols: 100, rows: 40 });
    expect(sizes.resize("b", { cols: 80, rows: 24 })).toBeNull();
  });

  it("switches to the size of the client that typed last", () => {
    const sizes = new LatestClientSize();
    sizes.resize("a", { cols: 100, rows: 40 });
    sizes.resize("b", { cols: 80, rows: 24 });
    expect(sizes.input("b")).toEqual({ cols: 80, rows: 24 });
    expect(sizes.input("b")).toBeNull();
    expect(sizes.input("a")).toEqual({ cols: 100, rows: 40 });
    expect(sizes.resize("a", { cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(sizes.resize("b", { cols: 90, rows: 24 })).toBeNull();
  });

  it("falls back to the next most recently active client when the active one leaves", () => {
    const sizes = new LatestClientSize();
    sizes.resize("a", { cols: 100, rows: 40 });
    sizes.resize("b", { cols: 80, rows: 24 });
    sizes.resize("c", { cols: 60, rows: 20 });
    sizes.input("b");
    sizes.input("c");
    expect(sizes.remove("c")).toEqual({ cols: 80, rows: 24 });
    expect(sizes.remove("a")).toBeNull();
    expect(sizes.remove("b")).toBeNull();
  });

  it("returns null when the size does not change", () => {
    const sizes = new LatestClientSize({ cols: 120, rows: 30 });
    expect(sizes.resize("a", { cols: 120, rows: 30 })).toBeNull();
    expect(sizes.resize("a", { cols: 120, rows: 31 })).toEqual({ cols: 120, rows: 31 });
    expect(sizes.resize("a", { cols: 120, rows: 31 })).toBeNull();
  });

  it("keeps the applied size when the typing client never reported one", () => {
    const sizes = new LatestClientSize();
    sizes.resize("a", { cols: 100, rows: 40 });
    expect(sizes.input("b")).toBeNull();
  });
});
