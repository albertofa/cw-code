import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings, DriverKind, EffortLevel, PrWorkflow } from "@cw-code/contracts";
import { MetadataError } from "../storage/metadataDocument.js";
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, SettingsStore } from "./SettingsStore.js";

const FIXTURE = readFileSync(fileURLToPath(new URL("../storage/__fixtures__/settings-v0.json", import.meta.url)));

function expectRefusal(filePath: string, kind: MetadataError["kind"]): void {
  let thrown: unknown;
  try {
    new SettingsStore(filePath);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MetadataError);
  expect((thrown as MetadataError).kind).toBe(kind);
  expect((thrown as MetadataError).store).toBe("settings");
}

function tempFilePath(): string {
  return join(mkdtempSync(join(tmpdir(), "cw-settings-test-")), "cw-settings.json");
}

describe("SettingsStore", () => {
  it("starts with defaults when the file is missing", () => {
    const filePath = tempFilePath();
    expect(new SettingsStore(filePath).get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ schemaVersion: SETTINGS_SCHEMA_VERSION, ...DEFAULT_SETTINGS });
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

  it("refuses corrupt JSON instead of resetting to defaults and leaves the file untouched", () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, "not-json{{{", "utf8");
    expectRefusal(filePath, "corrupt");
    expect(readFileSync(filePath, "utf8")).toBe("not-json{{{");
  });

  it("refuses a newer settings schema without writing", () => {
    const filePath = tempFilePath();
    const content = JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION + 1, holdingHours: 3 });
    writeFileSync(filePath, content, "utf8");
    expectRefusal(filePath, "future-schema");
    expect(readFileSync(filePath, "utf8")).toBe(content);
  });

  it("refuses a non-object settings file", () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, "[1,2]", "utf8");
    expectRefusal(filePath, "invalid-shape");
    expect(readFileSync(filePath, "utf8")).toBe("[1,2]");
  });

  it("falls back to defaults for wrong-typed known settings and keeps the original file as a before-repair backup", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filePath = tempFilePath();
    const original = JSON.stringify({
      schemaVersion: 1,
      claudeExtraArgs: 5,
      autoTitleModel: ["x"],
      claudeEnabledModels: "sonnet",
      opencodeBinaryPath: false,
      claudeCustomModel: 7,
      holdingHours: 9,
      futureSetting: "kept"
    });
    writeFileSync(filePath, original, "utf8");

    const settings = new SettingsStore(filePath).get();

    expect(settings).toMatchObject({
      claudeExtraArgs: DEFAULT_SETTINGS.claudeExtraArgs,
      autoTitleModel: DEFAULT_SETTINGS.autoTitleModel,
      claudeEnabledModels: DEFAULT_SETTINGS.claudeEnabledModels,
      opencodeBinaryPath: DEFAULT_SETTINGS.opencodeBinaryPath,
      claudeCustomModel: DEFAULT_SETTINGS.claudeCustomModel,
      holdingHours: 9
    });
    expect(readFileSync(`${filePath}.before-repair.bak`, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({ claudeExtraArgs: "", holdingHours: 9, futureSetting: "kept" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("claudeExtraArgs, autoTitleModel, claudeEnabledModels, opencodeBinaryPath, claudeCustomModel"));
    warn.mockRestore();
  });

  it("refreshes the before-repair backup only when a new repair sees different bytes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filePath = tempFilePath();
    writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, claudeExtraArgs: 5 }), "utf8");
    new SettingsStore(filePath);
    const backup = `${filePath}.before-repair.bak`;
    expect(readFileSync(backup, "utf8")).toBe('{"schemaVersion":1,"claudeExtraArgs":5}');

    new SettingsStore(filePath);
    expect(readFileSync(backup, "utf8")).toBe('{"schemaVersion":1,"claudeExtraArgs":5}');

    writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, codexExtraArgs: 6 }), "utf8");
    new SettingsStore(filePath);
    expect(readFileSync(backup, "utf8")).toBe('{"schemaVersion":1,"codexExtraArgs":6}');
    warn.mockRestore();
  });

  it("does not write a before-repair backup when nothing was repaired", () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, holdingHours: 3 }), "utf8");
    new SettingsStore(filePath);
    expect(existsSync(`${filePath}.before-repair.bak`)).toBe(false);
  });

  it.runIf(process.platform === "win32")("keeps memory in step with disk when saving fails", () => {
    const filePath = tempFilePath();
    const store = new SettingsStore(filePath);
    chmodSync(filePath, 0o444);
    try {
      expect(() => store.set({ holdingHours: 42 })).toThrow(/EPERM|EACCES/);
      expect(store.get().holdingHours).toBe(DEFAULT_SETTINGS.holdingHours);
    } finally {
      chmodSync(filePath, 0o644);
    }
  });

  it("migrates the schema-0 fixture keeping every setting", () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, FIXTURE);
    const original = JSON.parse(FIXTURE.toString("utf8")) as Record<string, unknown>;

    const settings = new SettingsStore(filePath).get();

    for (const key of Object.keys(original).filter((k) => k !== "prWorkflows") as Array<keyof AppSettings>) {
      expect(settings[key]).toEqual(original[key]);
    }
    const workflows = original.prWorkflows as PrWorkflow[];
    expect(settings.prWorkflows[0]).toEqual(workflows[0]);
    expect(settings.prWorkflows.find((w) => w.id === "review")).toMatchObject({ builtIn: true, enabled: false });
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(persisted.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(readFileSync(`${filePath}.v0.bak`).equals(FIXTURE)).toBe(true);
  });

  it("does not rewrite migrated settings on a later startup", () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, FIXTURE);
    const first = new SettingsStore(filePath).get();
    const bytes = readFileSync(filePath);
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(filePath, past, past);
    const mtime = statSync(filePath).mtimeMs;

    expect(new SettingsStore(filePath).get()).toEqual(first);
    expect(readFileSync(filePath).equals(bytes)).toBe(true);
    expect(statSync(filePath).mtimeMs).toBe(mtime);
  });

  it("preserves unknown top-level keys across migration and saves", () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, JSON.stringify({ holdingHours: 4, futureSetting: { nested: [1, 2] }, updateChannel: "alpha" }), "utf8");

    const store = new SettingsStore(filePath);
    store.set({ holdingHours: 8 });

    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({ schemaVersion: SETTINGS_SCHEMA_VERSION, holdingHours: 8, futureSetting: { nested: [1, 2] }, updateChannel: "alpha" });
    expect(store.get()).not.toHaveProperty("futureSetting");
    expect(store.get()).not.toHaveProperty("schemaVersion");
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

  it("sanitizes holding hours", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ holdingHours: -3 }).holdingHours).toBe(1);
    expect(store.set({ holdingHours: 0 }).holdingHours).toBe(6);
    expect(store.set({ holdingHours: 500 }).holdingHours).toBe(168);
    expect(store.set({ holdingHours: 9.6 }).holdingHours).toBe(10);
  });

  it("starts with holding auto-expiry disabled and keeps the delay when toggled", () => {
    const filePath = tempFilePath();
    const store = new SettingsStore(filePath);
    expect(store.get().holdingAutoExpireEnabled).toBe(false);
    expect(store.set({ holdingHours: 12, holdingAutoExpireEnabled: true })).toMatchObject({ holdingHours: 12, holdingAutoExpireEnabled: true });
    expect(store.set({ holdingAutoExpireEnabled: false })).toMatchObject({ holdingHours: 12, holdingAutoExpireEnabled: false });
    expect(new SettingsStore(filePath).get()).toMatchObject({ holdingHours: 12, holdingAutoExpireEnabled: false });
  });

  it("loads old holding settings with auto-expiry disabled", () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, JSON.stringify({ holdingHours: 0 }), "utf8");
    expect(new SettingsStore(filePath).get()).toMatchObject({ holdingHours: 6, holdingAutoExpireEnabled: false });
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

  it("includes default PR workflow settings", () => {
    const settings = new SettingsStore(tempFilePath()).get();
    expect(settings.prRefreshIntervalSeconds).toBe(120);
    expect(settings.prCloneRoot).toBe("~/.cw-code/repos");
    expect(settings.prAttributionEnabled).toBe(true);
    expect(settings.prWorkflows.map((w) => w.id)).toEqual(["resolve-conflicts", "fix-ci", "address-feedback", "review", "babysit"]);
    expect(settings.prWorkflows.every((w) => w.builtIn && w.enabled)).toBe(true);
  });

  it("clamps the PR refresh interval and trims the clone root", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ prRefreshIntervalSeconds: 1 }).prRefreshIntervalSeconds).toBe(30);
    expect(store.set({ prRefreshIntervalSeconds: 50_000 }).prRefreshIntervalSeconds).toBe(3600);
    expect(store.set({ prRefreshIntervalSeconds: 45.6 }).prRefreshIntervalSeconds).toBe(46);
    expect(store.set({ prCloneRoot: "  ~/repos  " }).prCloneRoot).toBe("~/repos");
    expect(store.set({ prCloneRoot: "   " }).prCloneRoot).toBe(DEFAULT_SETTINGS.prCloneRoot);
  });

  it("coerces PR attribution settings", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ prAttributionEnabled: "yes" as unknown as boolean }).prAttributionEnabled).toBe(false);
    expect(store.set({ prAttributionText: "  custom {{harness}}  " }).prAttributionText).toBe("custom {{harness}}");
  });

  it("falls back to PR defaults for non-string values without resetting other settings", () => {
    const filePath = tempFilePath();
    writeFileSync(
      filePath,
      JSON.stringify({ claudeBinaryPath: "custom-claude", prCloneRoot: 42, prAttributionText: { text: "x" } }),
      "utf8"
    );
    const settings = new SettingsStore(filePath).get();
    expect(settings.claudeBinaryPath).toBe("custom-claude");
    expect(settings.prCloneRoot).toBe(DEFAULT_SETTINGS.prCloneRoot);
    expect(settings.prAttributionText).toBe(DEFAULT_SETTINGS.prAttributionText);
  });

  it("drops PR workflow entries with an empty or duplicate id or an invalid shape", () => {
    const store = new SettingsStore(tempFilePath());
    const valid = {
      id: "custom",
      label: "Custom",
      description: "desc",
      icon: "sparkle",
      builtIn: false,
      enabled: true,
      suggestWhen: ["draft"],
      workspace: "checkout",
      startPrompt: "start",
      updatePrompt: "update"
    };
    const updated = store.set({
      prWorkflows: [
        valid,
        { ...valid, id: "" },
        { ...valid, id: "custom" },
        { ...valid, id: "bad-shape", icon: "not-an-icon" },
        "not-an-object" as unknown as typeof valid
      ] as unknown as typeof DEFAULT_SETTINGS.prWorkflows
    });
    const ids = updated.prWorkflows.map((w) => w.id);
    expect(ids.filter((id) => id === "custom")).toEqual(["custom"]);
    expect(ids).not.toContain("");
    expect(ids).not.toContain("bad-shape");
  });

  it("restores missing built-in PR workflows while keeping user order", () => {
    const store = new SettingsStore(tempFilePath());
    const babysit = DEFAULT_SETTINGS.prWorkflows.find((w) => w.id === "babysit")!;
    const updated = store.set({ prWorkflows: [{ ...babysit, enabled: false }] });
    expect(updated.prWorkflows[0]).toMatchObject({ id: "babysit", enabled: false });
    expect(updated.prWorkflows.map((w) => w.id).sort()).toEqual(
      DEFAULT_SETTINGS.prWorkflows.map((w) => w.id).sort()
    );
  });

  it("keeps the enabled flag of a malformed built-in PR workflow when restoring it", () => {
    const store = new SettingsStore(tempFilePath());
    const updated = store.set({ prWorkflows: [{ id: "review", enabled: false, icon: "nope" } as unknown as PrWorkflow] });
    expect(updated.prWorkflows.find((w) => w.id === "review")).toMatchObject({ enabled: false, workspace: "checkout" });
  });

  it("defaults reasoning to collapsed per harness and coerces with strict true", () => {
    const store = new SettingsStore(tempFilePath());
    const settings = store.get();
    expect([settings.claudeReasoningExpanded, settings.opencodeReasoningExpanded, settings.codexReasoningExpanded]).toEqual([false, false, false]);
    expect(
      store.set({
        claudeReasoningExpanded: true,
        opencodeReasoningExpanded: "yes" as unknown as boolean,
        codexReasoningExpanded: true
      })
    ).toMatchObject({ claudeReasoningExpanded: true, opencodeReasoningExpanded: false, codexReasoningExpanded: true });
  });
});
