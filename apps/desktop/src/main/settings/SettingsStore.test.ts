import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverKind, EffortLevel } from "@cw-code/contracts";
import { DEFAULT_SETTINGS, SettingsStore } from "./SettingsStore.js";

function tempFilePath(): string {
  return join(mkdtempSync(join(tmpdir(), "cw-settings-test-")), "cw-settings.json");
}

describe("SettingsStore", () => {
  it("starts with defaults when the file is missing", () => {
    const filePath = tempFilePath();
    expect(new SettingsStore(filePath).get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(filePath)).toBe(true);
  });

  it("set returns merged settings and a new instance reads them back", () => {
    const filePath = tempFilePath();
    const store = new SettingsStore(filePath);
    const updated = store.set({
      claudeBinaryPath: "  claude  ",
      claudeCustomModel: { id: " my-model ", name: " My Model " }
    });
    expect(updated.claudeBinaryPath).toBe("claude");
    expect(updated.claudeCustomModel).toEqual({ id: "my-model", name: "My Model" });
    expect(updated.opencodeBinaryPath).toBe(DEFAULT_SETTINGS.opencodeBinaryPath);
    expect(new SettingsStore(filePath).get()).toEqual(updated);
  });

  it("migrates a legacy string custom model to id with empty name", () => {
    const store = new SettingsStore(tempFilePath());
    const updated = store.set({
      claudeCustomModel: " legacy-model " as unknown as { id: string; name: string }
    });
    expect(updated.claudeCustomModel).toEqual({ id: "legacy-model", name: "" });
  });

  it("sanitizes enabled models to non-empty trimmed strings", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ claudeEnabledModels: [" opus ", "", "  "] }).claudeEnabledModels).toEqual(["opus"]);
  });

  it("falls back to defaults on corrupt JSON without throwing", () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, "not-json{{{", "utf8");
    expect(new SettingsStore(filePath).get()).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual(DEFAULT_SETTINGS);
  });

  it("migrates blank binary paths to OS defaults", () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, JSON.stringify({ claudeBinaryPath: "", opencodeBinaryPath: "  " }), "utf8");
    expect(new SettingsStore(filePath).get()).toMatchObject({
      claudeBinaryPath: DEFAULT_SETTINGS.claudeBinaryPath,
      opencodeBinaryPath: DEFAULT_SETTINGS.opencodeBinaryPath
    });
  });

  it("resets blank binary paths to OS defaults when saving", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ claudeBinaryPath: "", opencodeBinaryPath: "  " })).toMatchObject({
      claudeBinaryPath: DEFAULT_SETTINGS.claudeBinaryPath,
      opencodeBinaryPath: DEFAULT_SETTINGS.opencodeBinaryPath
    });
  });

  it("sanitizes source-control settings", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ gitBinaryPath: "  custom-git  ", githubCliBinaryPath: "  custom-gh  ", sourceControlRefreshIntervalSeconds: 1, defaultUseWorktree: false })).toMatchObject({
      gitBinaryPath: "custom-git", githubCliBinaryPath: "custom-gh", sourceControlRefreshIntervalSeconds: 5, defaultUseWorktree: false
    });
    expect(store.set({ sourceControlRefreshIntervalSeconds: 50_000 }).sourceControlRefreshIntervalSeconds).toBe(3600);
  });

  it("includes auto-title defaults", () => {
    const settings = new SettingsStore(tempFilePath()).get();
    expect(settings.autoTitleEnabled).toBe(true);
    expect(settings.autoTitleDriver).toBe("claude");
    expect(settings.autoTitleModel).toBe("claude-sonnet-5");
    expect(settings.autoTitleEffort).toBe("low");
  });

  it("sanitizes auto-title settings", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ autoTitleEnabled: false, autoTitleDriver: "opencode", autoTitleModel: "  claude-opus-5  ", autoTitleEffort: "xhigh" })).toMatchObject({
      autoTitleEnabled: false, autoTitleDriver: "opencode", autoTitleModel: "claude-opus-5", autoTitleEffort: "xhigh"
    });
    expect(store.set({ autoTitleModel: "  " }).autoTitleModel).toBe("");
  });

  it("falls back to default auto-title driver and effort on invalid values", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ autoTitleDriver: "bogus" as unknown as DriverKind, autoTitleEffort: "extreme" as unknown as EffortLevel })).toMatchObject({
      autoTitleDriver: DEFAULT_SETTINGS.autoTitleDriver, autoTitleEffort: DEFAULT_SETTINGS.autoTitleEffort
    });
  });

  it("coerces auto-title enabled with strict true", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ autoTitleEnabled: "yes" as unknown as boolean }).autoTitleEnabled).toBe(false);
    expect(store.set({ autoTitleEnabled: true }).autoTitleEnabled).toBe(true);
  });
});
