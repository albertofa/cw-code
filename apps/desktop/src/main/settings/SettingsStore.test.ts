import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings, DriverKind, EffortLevel, PrFinishedSessionStatus, PrWorkflow, SavedGitHubView } from "@cw-code/contracts";
import { MetadataError } from "../storage/metadataDocument.js";
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, SettingsStore } from "./SettingsStore.js";
import { defaultPrWorkflows, RETIRED_BUILT_IN_PROMPTS } from "./prWorkflowDefaults.js";

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
  it.each([
    ["a current-schema file", '{"schemaVersion":1,"__proto__":{"polluted":true},"holdingHours":3}'],
    ["a schema-0 file", '{"__proto__":{"polluted":true},"holdingHours":3}']
  ])("keeps an unknown __proto__ key in %s as an own property across writes", (_label, raw) => {
    const filePath = tempFilePath();
    writeFileSync(filePath, raw, "utf8");

    const store = new SettingsStore(filePath);
    store.set({ holdingHours: 4 });

    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(Object.hasOwn(persisted, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(persisted, "__proto__")?.value).toEqual({ polluted: true });
    expect(persisted.holdingHours).toBe(4);
    expect(Object.hasOwn(store.get(), "polluted")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("completes the pending last-good refresh on flush, including the first-run file", () => {
    const filePath = tempFilePath();
    const lastGood = `${filePath}.last-good.bak`;
    const store = new SettingsStore(filePath);
    expect(existsSync(lastGood)).toBe(false);

    store.set({ holdingHours: 12 });
    expect(existsSync(lastGood)).toBe(false);

    store.flush();
    expect(readFileSync(lastGood, "utf8")).toBe(readFileSync(filePath, "utf8"));
    expect(JSON.parse(readFileSync(lastGood, "utf8"))).toMatchObject({ holdingHours: 12 });
  });

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
    expect(settings.prWorkflows[0]).toEqual({
      ...workflows[0],
      target: "pr",
      harness: { driver: null, model: "", effort: null, permissionMode: null }
    });
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
    writeFileSync(filePath, JSON.stringify({ holdingHours: 4, futureSetting: { nested: [1, 2] }, futureFlag: "beta" }), "utf8");

    const store = new SettingsStore(filePath);
    store.set({ holdingHours: 8 });

    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({ schemaVersion: SETTINGS_SCHEMA_VERSION, holdingHours: 8, futureSetting: { nested: [1, 2] }, futureFlag: "beta" });
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

  it("includes PR finished-session defaults", () => {
    const settings = new SettingsStore(tempFilePath()).get();
    expect(settings.prFinishedSessionStatus).toBe("idle");
    expect(settings.idleResolveAfterDays).toBe(30);
  });

  it("accepts every PR finished-session status and falls back on an invalid value", () => {
    const store = new SettingsStore(tempFilePath());
    for (const status of ["idle", "resolved", "archived", "none"] as PrFinishedSessionStatus[]) {
      expect(store.set({ prFinishedSessionStatus: status }).prFinishedSessionStatus).toBe(status);
    }
    expect(store.set({ prFinishedSessionStatus: "bogus" as unknown as PrFinishedSessionStatus }).prFinishedSessionStatus).toBe("idle");
  });

  it("rounds and clamps the idle resolve delay", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ idleResolveAfterDays: 0 }).idleResolveAfterDays).toBe(0);
    expect(store.set({ idleResolveAfterDays: -5 }).idleResolveAfterDays).toBe(0);
    expect(store.set({ idleResolveAfterDays: 500 }).idleResolveAfterDays).toBe(365);
    expect(store.set({ idleResolveAfterDays: 9.6 }).idleResolveAfterDays).toBe(10);
    expect(store.set({ idleResolveAfterDays: Number.NaN }).idleResolveAfterDays).toBe(30);
    expect(store.set({ idleResolveAfterDays: Number.POSITIVE_INFINITY }).idleResolveAfterDays).toBe(30);
  });

  it("round-trips PR finished-session settings", () => {
    const filePath = tempFilePath();
    const store = new SettingsStore(filePath);
    const updated = store.set({ prFinishedSessionStatus: "archived", idleResolveAfterDays: 0 });
    expect(updated).toMatchObject({ prFinishedSessionStatus: "archived", idleResolveAfterDays: 0 });
    expect(new SettingsStore(filePath).get()).toEqual(updated);
  });

  it("repairs invalid PR finished-session settings from disk without touching other settings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filePath = tempFilePath();
    writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, holdingHours: 5, prFinishedSessionStatus: 3, idleResolveAfterDays: "soon" }), "utf8");

    expect(new SettingsStore(filePath).get()).toMatchObject({
      holdingHours: 5,
      prFinishedSessionStatus: "idle",
      idleResolveAfterDays: 30
    });
    expect(existsSync(`${filePath}.before-repair.bak`)).toBe(true);
    warn.mockRestore();
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
    expect(settings.prCloneIncludeOwner).toBe(true);
    expect(settings.prAttributionEnabled).toBe(true);
    expect(settings.prWorkflows.map((w) => w.id)).toEqual([
      "resolve-conflicts",
      "fix-ci",
      "address-feedback",
      "review",
      "babysit",
      "implement",
      "investigate",
      "triage",
      "investigate-run"
    ]);
    expect(settings.prWorkflows.every((w) => w.builtIn && w.enabled)).toBe(true);
    expect(settings.githubSavedViews).toEqual([]);
  });

  it("ships issue and run built-in workflows with their targets and suggestions", () => {
    const byId = new Map(new SettingsStore(tempFilePath()).get().prWorkflows.map((w) => [w.id, w]));
    expect(byId.get("implement")).toMatchObject({ target: "issue", suggestWhen: ["issue-assigned"], workspace: "worktree", icon: "sparkle" });
    expect(byId.get("investigate")).toMatchObject({ target: "issue", suggestWhen: ["issue-bug"], workspace: "checkout", icon: "eye" });
    expect(byId.get("triage")).toMatchObject({ target: "issue", suggestWhen: [], workspace: "checkout", icon: "message" });
    expect(byId.get("investigate-run")).toMatchObject({ target: "run", suggestWhen: ["run-failed"], workspace: "worktree", icon: "wrench" });
    expect(byId.get("implement")?.startPrompt).toContain('Implement {{issue.repo}}#{{issue.number}} "{{issue.title}}".\n\n{{issue.body}}');
    expect(byId.get("investigate-run")?.updatePrompt).toBe("{{run.workflow}} #{{run.number}} changed: {{run.failedJobs}}");
  });

  it("appends the new built-in workflows to saved workflows from before they existed", () => {
    const filePath = tempFilePath();
    const legacy = DEFAULT_SETTINGS.prWorkflows
      .filter((w) => w.target === "pr")
      .map((w) => ({ ...w, target: undefined, enabled: w.id !== "babysit" }));
    writeFileSync(filePath, JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, prWorkflows: legacy }), "utf8");

    const workflows = new SettingsStore(filePath).get().prWorkflows;

    expect(workflows.map((w) => w.id)).toEqual([...legacy.map((w) => w.id), "implement", "investigate", "triage", "investigate-run"]);
    expect(workflows.slice(0, legacy.length).every((w) => w.target === "pr")).toBe(true);
    expect(workflows.find((w) => w.id === "babysit")?.enabled).toBe(false);
    expect(workflows.find((w) => w.id === "implement")).toMatchObject({ builtIn: true, enabled: true, target: "issue" });
  });

  it("upgrades a saved built-in prompt that still matches a retired default, and keeps edited ones", () => {
    const filePath = tempFilePath();
    const retired = RETIRED_BUILT_IN_PROMPTS.find((prompt) => prompt.id === "review")!;
    const saved = DEFAULT_SETTINGS.prWorkflows.map((w) =>
      w.id === "review" ? { ...w, startPrompt: retired.text } : w.id === "fix-ci" ? { ...w, startPrompt: "my own prompt" } : w
    );
    writeFileSync(filePath, JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, prWorkflows: saved }), "utf8");

    const byId = new Map(new SettingsStore(filePath).get().prWorkflows.map((w) => [w.id, w]));

    expect(byId.get("review")?.startPrompt).toBe(defaultPrWorkflows().find((w) => w.id === "review")?.startPrompt);
    expect(byId.get("review")?.startPrompt).toContain("Architecture and design");
    expect(byId.get("fix-ci")?.startPrompt).toBe("my own prompt");
  });

  it("turns on automatic follow-ups for babysit only, and keeps a saved opt-out", () => {
    const filePath = tempFilePath();
    const saved = DEFAULT_SETTINGS.prWorkflows.map(({ autoFollowUp: _auto, ...w }) => w);
    writeFileSync(filePath, JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, prWorkflows: saved }), "utf8");
    const store = new SettingsStore(filePath);

    const workflows = store.get().prWorkflows;
    expect(workflows.filter((w) => w.autoFollowUp).map((w) => w.id)).toEqual(["babysit"]);

    const babysit = workflows.find((w) => w.id === "babysit")!;
    const updated = store.set({ prWorkflows: workflows.map((w) => (w.id === "babysit" ? { ...babysit, autoFollowUp: false } : w)) });
    expect(updated.prWorkflows.find((w) => w.id === "babysit")?.autoFollowUp).toBe(false);
    expect(new SettingsStore(filePath).get().prWorkflows.find((w) => w.id === "babysit")?.autoFollowUp).toBe(false);
  });

  it("fills a missing workflow target with pr and keeps valid ones", () => {
    const store = new SettingsStore(tempFilePath());
    const base = { ...DEFAULT_SETTINGS.prWorkflows[0]!, builtIn: false };
    const updated = store.set({
      prWorkflows: [
        { ...base, id: "no-target", target: undefined },
        { ...base, id: "bad-target", target: "team" },
        { ...base, id: "for-issue", target: "issue" }
      ] as unknown as PrWorkflow[]
    });
    const target = (id: string) => updated.prWorkflows.find((w) => w.id === id)?.target;
    expect(target("no-target")).toBe("pr");
    expect(target("bad-target")).toBe("pr");
    expect(target("for-issue")).toBe("issue");
  });

  it("sanitizes the workflow harness config and inherits everything when it is missing", () => {
    const store = new SettingsStore(tempFilePath());
    const base = { ...DEFAULT_SETTINGS.prWorkflows[0]!, builtIn: false };
    const updated = store.set({
      prWorkflows: [
        { ...base, id: "legacy", harness: undefined },
        { ...base, id: "set", harness: { driver: "codex", model: "  gpt-5  ", effort: "high", permissionMode: "acceptEdits" } },
        { ...base, id: "bad", harness: { driver: "gemini", model: "x", effort: "extreme", permissionMode: "yolo" } },
        { ...base, id: "model-only", harness: { driver: null, model: "claude-opus-5", effort: null, permissionMode: null } }
      ] as unknown as PrWorkflow[]
    });
    const harness = (id: string) => updated.prWorkflows.find((w) => w.id === id)?.harness;
    const inherited = { driver: null, model: "", effort: null, permissionMode: null };
    expect(harness("legacy")).toEqual(inherited);
    expect(harness("set")).toEqual({ driver: "codex", model: "gpt-5", effort: "high", permissionMode: "acceptEdits" });
    expect(harness("bad")).toEqual(inherited);
    expect(harness("model-only")).toEqual(inherited);
    expect(DEFAULT_SETTINGS.prWorkflows.every((w) => JSON.stringify(w.harness) === JSON.stringify(inherited))).toBe(true);
  });

  it("repairs workflows saved before the harness config once, keeping a before-repair backup", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filePath = tempFilePath();
    const { harness: _harness, ...legacy } = { ...DEFAULT_SETTINGS.prWorkflows[0]!, id: "legacy", builtIn: false };
    const original = JSON.stringify({ schemaVersion: 1, prWorkflows: [legacy] });
    writeFileSync(filePath, original, "utf8");
    const backup = `${filePath}.before-repair.bak`;

    expect(new SettingsStore(filePath).get().prWorkflows.find((w) => w.id === "legacy")?.harness).toEqual({
      driver: null,
      model: "",
      effort: null,
      permissionMode: null
    });
    expect(readFileSync(backup, "utf8")).toBe(original);
    expect(warn).toHaveBeenCalledTimes(1);

    new SettingsStore(filePath);
    expect(readFileSync(backup, "utf8")).toBe(original);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("sanitizes saved GitHub views", () => {
    const store = new SettingsStore(tempFilePath());
    const view = { id: "v1", kind: "pr", name: "  Mine  ", query: "  is:open author:@me  ", group: "none" };
    const updated = store.set({
      githubSavedViews: [
        view,
        { ...view, id: "v1", name: "duplicate" },
        { ...view, id: "bad-kind", kind: "discussion" },
        { ...view, id: "bad-group", group: "owner" },
        { ...view, id: "", name: "no id" },
        { ...view, id: "long-name", name: "n".repeat(81) },
        { ...view, id: "long-query", query: "q".repeat(513) },
        { ...view, id: "no-query", query: undefined },
        { ...view, id: "blank-name", name: "   " },
        { ...view, id: "blank-query", query: "  " },
        { ...view, id: "edge", kind: "run", name: "n".repeat(80), query: "q".repeat(512), group: "repo" },
        "not-an-object",
        null
      ] as unknown as SavedGitHubView[]
    });
    expect(updated.githubSavedViews.map((v) => v.id)).toEqual(["v1", "edge"]);
    expect(updated.githubSavedViews[0]).toEqual({ id: "v1", kind: "pr", name: "Mine", query: "is:open author:@me", group: "none" });
  });

  it("caps saved GitHub views at 50 and treats a non-array as empty", () => {
    const store = new SettingsStore(tempFilePath());
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `v${i}`, kind: "issue", name: `View ${i}`, query: "is:open", group: "repo" }));
    const capped = store.set({ githubSavedViews: many as SavedGitHubView[] }).githubSavedViews;
    expect(capped).toHaveLength(50);
    expect(capped[49]?.id).toBe("v49");
    expect(store.set({ githubSavedViews: "nope" as unknown as SavedGitHubView[] }).githubSavedViews).toEqual([]);
  });

  it("persists saved GitHub views across restarts and repairs invalid ones from disk", () => {
    const filePath = tempFilePath();
    new SettingsStore(filePath).set({ githubSavedViews: [{ id: "a", kind: "run", name: "Org runs", query: "org:acme", group: "repo" }] });
    expect(new SettingsStore(filePath).get().githubSavedViews).toEqual([{ id: "a", kind: "run", name: "Org runs", query: "org:acme", group: "repo" }]);

    writeFileSync(filePath, JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, githubSavedViews: [{ id: "x", kind: "nope" }] }), "utf8");
    expect(new SettingsStore(filePath).get().githubSavedViews).toEqual([]);
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

  it("coerces the clone owner folder toggle with strict true", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ prCloneIncludeOwner: "yes" as unknown as boolean }).prCloneIncludeOwner).toBe(false);
    expect(store.set({ prCloneIncludeOwner: true }).prCloneIncludeOwner).toBe(true);
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

  it("defaults to a derived update channel with background downloads on", () => {
    const settings = new SettingsStore(tempFilePath()).get();
    expect(settings.updateChannel).toBeNull();
    expect(settings.updateBackgroundDownload).toBe(true);
  });

  it("persists the update preferences and falls back per field on invalid values", () => {
    const filePath = tempFilePath();
    const store = new SettingsStore(filePath);
    expect(store.set({ updateChannel: "stable", updateBackgroundDownload: false })).toMatchObject({
      updateChannel: "stable",
      updateBackgroundDownload: false
    });
    expect(new SettingsStore(filePath).get()).toMatchObject({ updateChannel: "stable", updateBackgroundDownload: false });
    expect(
      store.set({ updateChannel: "beta" as unknown as "alpha", updateBackgroundDownload: "no" as unknown as boolean, holdingHours: 2 })
    ).toMatchObject({ updateChannel: null, updateBackgroundDownload: true, holdingHours: 2 });
    expect(store.set({ updateChannel: "alpha" }).updateChannel).toBe("alpha");
    expect(store.set({ updateChannel: null }).updateChannel).toBeNull();
  });

  it("loads a schema-1 file written before the update settings existed without a migration or backup", () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, holdingHours: 3, futureSetting: "kept" }), "utf8");

    const settings = new SettingsStore(filePath).get();

    expect(settings).toMatchObject({ holdingHours: 3, updateChannel: null, updateBackgroundDownload: true });
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({ schemaVersion: 1, holdingHours: 3, futureSetting: "kept", updateChannel: null, updateBackgroundDownload: true });
    expect(existsSync(`${filePath}.v1.bak`)).toBe(false);
    expect(existsSync(`${filePath}.before-repair.bak`)).toBe(false);
  });

  it("repairs wrong-typed update settings from disk without touching other settings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filePath = tempFilePath();
    writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, holdingHours: 5, updateChannel: 3, updateBackgroundDownload: "yes" }), "utf8");

    expect(new SettingsStore(filePath).get()).toMatchObject({ holdingHours: 5, updateChannel: null, updateBackgroundDownload: true });
    expect(existsSync(`${filePath}.before-repair.bak`)).toBe(true);
    warn.mockRestore();
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

  it("defaults typography to the built-in stacks and sizes", () => {
    expect(new SettingsStore(tempFilePath()).get()).toMatchObject({
      fontFamilySans: "",
      fontFamilyMono: "",
      fontFamilyPrompt: "",
      fontFamilyTerminal: "",
      fontSizeInterface: 16,
      fontSizeCode: 14,
      fontSizePrompt: 14,
      fontSizeTerminal: 14,
      typographyAdvanced: false
    });
  });

  it("trims font families and caps them at 200 characters", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ fontFamilySans: '  "Segoe UI Variable Text"  ' }).fontFamilySans).toBe('"Segoe UI Variable Text"');
    expect(store.set({ fontFamilyMono: "a".repeat(300) }).fontFamilyMono).toHaveLength(200);
    expect(store.set({ fontFamilyPrompt: 42 as unknown as string }).fontFamilyPrompt).toBe("");
  });

  it("rounds and clamps typography sizes", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ fontSizeInterface: 4, fontSizeCode: 99, fontSizePrompt: 12.4, fontSizeTerminal: 2 })).toMatchObject({
      fontSizeInterface: 12,
      fontSizeCode: 18,
      fontSizePrompt: 12,
      fontSizeTerminal: 8
    });
    expect(store.set({ fontSizeInterface: 25, fontSizeCode: 9.6, fontSizePrompt: 19.5, fontSizeTerminal: 21 })).toMatchObject({
      fontSizeInterface: 20,
      fontSizeCode: 10,
      fontSizePrompt: 20,
      fontSizeTerminal: 20
    });
  });

  it("resets non-finite typography sizes to the defaults", () => {
    const store = new SettingsStore(tempFilePath());
    expect(
      store.set({
        fontSizeInterface: Number.NaN,
        fontSizeCode: "wide" as unknown as number,
        fontSizePrompt: Number.POSITIVE_INFINITY
      })
    ).toMatchObject({ fontSizeInterface: 16, fontSizeCode: 14, fontSizePrompt: 14 });
  });

  it("resets null typography sizes to the defaults instead of the minimum", () => {
    const store = new SettingsStore(tempFilePath());
    store.set({ fontSizeInterface: 18, fontSizeTerminal: 18 });
    expect(
      store.set({
        fontSizeInterface: null as unknown as number,
        fontSizeTerminal: null as unknown as number
      })
    ).toMatchObject({ fontSizeInterface: 16, fontSizeTerminal: 14 });
  });

  it("coerces the advanced typography switch with strict true", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ typographyAdvanced: true }).typographyAdvanced).toBe(true);
    expect(store.set({ typographyAdvanced: "yes" as unknown as boolean }).typographyAdvanced).toBe(false);
  });

  it("defaults panel animation to off", () => {
    expect(new SettingsStore(tempFilePath()).get().panelAnimationMs).toBe(0);
  });

  it("clamps panel animation to 0-400 in steps of 25", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ panelAnimationMs: 175 }).panelAnimationMs).toBe(175);
    expect(store.set({ panelAnimationMs: 160 }).panelAnimationMs).toBe(150);
    expect(store.set({ panelAnimationMs: 163 }).panelAnimationMs).toBe(175);
    expect(store.set({ panelAnimationMs: -50 }).panelAnimationMs).toBe(0);
    expect(store.set({ panelAnimationMs: 900 }).panelAnimationMs).toBe(400);
  });

  it("defaults every harness default model to empty", () => {
    expect(new SettingsStore(tempFilePath()).get()).toMatchObject({
      claudeDefaultModel: "",
      codexDefaultModel: "",
      opencodeDefaultModel: ""
    });
  });

  it("trims harness default models and resets non-strings to empty", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.set({ codexDefaultModel: "  gpt-5.5-codex  " }).codexDefaultModel).toBe("gpt-5.5-codex");
    expect(store.set({ opencodeDefaultModel: " anthropic/claude-opus-5 " }).opencodeDefaultModel).toBe("anthropic/claude-opus-5");
    expect(store.set({ codexDefaultModel: 7 as unknown as string }).codexDefaultModel).toBe("");
    expect(store.set({ opencodeDefaultModel: null as unknown as string }).opencodeDefaultModel).toBe("");
  });

  it("resets a non-finite panel animation to off", () => {
    const store = new SettingsStore(tempFilePath());
    store.set({ panelAnimationMs: 200 });
    expect(store.set({ panelAnimationMs: Number.NaN }).panelAnimationMs).toBe(0);
    expect(store.set({ panelAnimationMs: "slow" as unknown as number }).panelAnimationMs).toBe(0);
  });

  it("defaults notification sounds to felt chord, triple tap and tock down", () => {
    expect(new SettingsStore(tempFilePath()).get().notificationSounds).toEqual({
      done: { enabled: true, sound: "felt-chord", volume: 60 },
      question: { enabled: true, sound: "triple-tap", volume: 60 },
      prUpdate: { enabled: true, sound: "tock-down", volume: 60 }
    });
  });

  it("repairs each notification sound preference field by field", () => {
    const store = new SettingsStore(tempFilePath());
    const sounds = store.set({
      notificationSounds: {
        done: { enabled: false, sound: "pop", volume: 140 },
        question: { enabled: "yes", sound: "siren", volume: -3 },
        prUpdate: null
      } as unknown as AppSettings["notificationSounds"]
    }).notificationSounds;
    expect(sounds).toEqual({
      done: { enabled: false, sound: "pop", volume: 100 },
      question: { enabled: true, sound: "triple-tap", volume: 0 },
      prUpdate: { enabled: true, sound: "tock-down", volume: 60 }
    });
  });

  it("does not share notification sound objects between reads", () => {
    const store = new SettingsStore(tempFilePath());
    store.get().notificationSounds.done.volume = 5;
    expect(store.get().notificationSounds.done.volume).toBe(60);
  });

  it("defaults the theme to dark and accepts light and system", () => {
    const store = new SettingsStore(tempFilePath());
    expect(store.get().themeMode).toBe("dark");
    expect(store.set({ themeMode: "light" }).themeMode).toBe("light");
    expect(store.set({ themeMode: "system" }).themeMode).toBe("system");
  });

  it("falls back to dark for an unknown theme", () => {
    const store = new SettingsStore(tempFilePath());
    store.set({ themeMode: "light" });
    expect(store.set({ themeMode: "sepia" as unknown as AppSettings["themeMode"] }).themeMode).toBe("dark");
  });
});
