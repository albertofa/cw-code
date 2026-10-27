import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { DEFAULT_UPDATE_PREFERENCES, LocalUpdatePreferences, parseUpdatePreferences, UPDATE_PREFERENCES_FILE } from "./localUpdatePreferences.js";

describe("parseUpdatePreferences", () => {
  it("defaults when the file is missing, corrupt or malformed", () => {
    expect(parseUpdatePreferences(null)).toEqual(DEFAULT_UPDATE_PREFERENCES);
    expect(parseUpdatePreferences("{nope")).toEqual(DEFAULT_UPDATE_PREFERENCES);
    expect(parseUpdatePreferences('{"updateChannel":"beta","updateBackgroundDownload":"yes"}')).toEqual(DEFAULT_UPDATE_PREFERENCES);
  });

  it("reads a saved channel and download preference", () => {
    expect(parseUpdatePreferences('{"updateChannel":"alpha","updateBackgroundDownload":false}')).toEqual({
      updateChannel: "alpha",
      updateBackgroundDownload: false
    });
  });
});

describe("LocalUpdatePreferences", () => {
  it("persists patches and reloads them", () => {
    const files = new Map<string, string>();
    const fs = { read: (path: string) => files.get(path) ?? null, write: (path: string, data: string) => void files.set(path, data) };
    new LocalUpdatePreferences("/data", fs).set({ updateChannel: "stable" });
    expect(files.has(join("/data", UPDATE_PREFERENCES_FILE))).toBe(true);
    const reloaded = new LocalUpdatePreferences("/data", fs);
    expect(reloaded.get()).toEqual({ updateChannel: "stable", updateBackgroundDownload: true });
    expect(reloaded.set({ updateBackgroundDownload: false })).toEqual({ updateChannel: "stable", updateBackgroundDownload: false });
  });
});
