import { describe, expect, it } from "bun:test";
import { fitPopover } from "./popoverFit.js";

const base = { viewportHeight: 800, gap: 6, margin: 12 };

describe("fitPopover", () => {
  it("keeps the preferred side when the popover fits there", () => {
    expect(fitPopover({ ...base, anchorTop: 100, anchorBottom: 130, natural: 300, preferUp: false })).toEqual({ up: false, maxHeight: 652 });
    expect(fitPopover({ ...base, anchorTop: 700, anchorBottom: 730, natural: 300, preferUp: true })).toEqual({ up: true, maxHeight: 682 });
  });

  it("flips to the roomier side when the preferred one is too tight", () => {
    expect(fitPopover({ ...base, anchorTop: 600, anchorBottom: 630, natural: 400, preferUp: false })).toEqual({ up: true, maxHeight: 582 });
    expect(fitPopover({ ...base, anchorTop: 100, anchorBottom: 130, natural: 400, preferUp: true })).toEqual({ up: false, maxHeight: 652 });
  });

  it("stays on the preferred side, capped, when it is the roomier one anyway", () => {
    expect(fitPopover({ ...base, anchorTop: 300, anchorBottom: 330, natural: 900, preferUp: false })).toEqual({ up: false, maxHeight: 452 });
  });

  it("never returns a negative height", () => {
    expect(fitPopover({ ...base, anchorTop: 5, anchorBottom: 795, natural: 100, preferUp: true }).maxHeight).toBe(0);
  });
});
