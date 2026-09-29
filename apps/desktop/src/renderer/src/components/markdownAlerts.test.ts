import { describe, expect, it } from "vitest";
import { parseAlertMarker, type AlertKind } from "./markdownAlerts.js";

describe("parseAlertMarker", () => {
  it.each<[string, AlertKind]>([
    ["[!NOTE]", "note"],
    ["[!TIP]", "tip"],
    ["[!IMPORTANT]", "important"],
    ["[!WARNING]", "warning"],
    ["[!CAUTION]", "caution"]
  ])("recognises %s", (marker, kind) => {
    expect(parseAlertMarker(marker)).toEqual({ kind, rest: "" });
  });

  it("is case-insensitive", () => {
    expect(parseAlertMarker("[!note]")).toEqual({ kind: "note", rest: "" });
    expect(parseAlertMarker("[!Warning]")).toEqual({ kind: "warning", rest: "" });
  });

  it("returns the text after the marker", () => {
    expect(parseAlertMarker("[!NOTE] text")).toEqual({ kind: "note", rest: "text" });
    expect(parseAlertMarker("[!TIP]   spaced out")).toEqual({ kind: "tip", rest: "spaced out" });
  });

  it("returns null without a marker", () => {
    expect(parseAlertMarker("plain quote")).toBeNull();
    expect(parseAlertMarker("")).toBeNull();
  });

  it("returns null for unknown kinds or a marker that is not first", () => {
    expect(parseAlertMarker("[!DANGER] text")).toBeNull();
    expect(parseAlertMarker("text [!NOTE]")).toBeNull();
    expect(parseAlertMarker("[NOTE] text")).toBeNull();
  });
});
