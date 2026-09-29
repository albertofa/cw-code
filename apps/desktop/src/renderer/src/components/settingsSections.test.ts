import { beforeEach, describe, expect, it } from "vitest";
import type { AppSettings } from "../cw.js";
import { useSettingsDraftStore } from "../stores/settingsDraftStore.js";
import { changedSections, filterSettingsNav, navIdOf, sameValue, SETTINGS_NAV, viewOfNavId } from "./settingsSections.js";

function settingsFixture(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    claudeBinaryPath: "claude",
    opencodeBinaryPath: "opencode",
    codexBinaryPath: "codex",
    claudeExtraArgs: "",
    opencodeExtraArgs: "",
    codexExtraArgs: "",
    claudeDefaultModel: "",
    codexDefaultModel: "",
    opencodeDefaultModel: "",
    claudeEnabledModels: ["claude-opus-5-5", "claude-sonnet-5-5"],
    claudeCustomModel: { id: "", name: "" },
    claudeReasoningExpanded: false,
    opencodeReasoningExpanded: false,
    codexReasoningExpanded: false,
    gitBinaryPath: "git",
    githubCliBinaryPath: "gh",
    sourceControlRefreshIntervalSeconds: 30,
    defaultUseWorktree: true,
    holdingAutoExpireEnabled: true,
    holdingHours: 24,
    autoTitleEnabled: true,
    autoTitleDriver: "claude",
    autoTitleModel: "",
    autoTitleEffort: "low",
    prRefreshIntervalSeconds: 120,
    prCloneRoot: "",
    prAttributionEnabled: true,
    prAttributionText: "— {{harness}} via cw-code",
    prWorkflows: [
      {
        id: "review",
        label: "Review",
        description: "",
        icon: "eye",
        builtIn: true,
        enabled: true,
        suggestWhen: ["review-requested"],
        workspace: "checkout",
        startPrompt: "start",
        updatePrompt: "update"
      }
    ],
    opencodeGoUsage: false,
    updateChannel: null,
    updateBackgroundDownload: true,
    fontFamilySans: "",
    fontFamilyMono: "",
    fontFamilyPrompt: "",
    fontFamilyTerminal: "",
    fontSizeInterface: 16,
    fontSizeCode: 14,
    fontSizePrompt: 14,
    fontSizeTerminal: 14,
    typographyAdvanced: false,
    panelAnimationMs: 180,
    ...overrides
  };
}

describe("sameValue", () => {
  it("compares objects by structure regardless of key order", () => {
    expect(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
  });

  it("treats a missing key and an undefined value as equal", () => {
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });

  it("detects changed nested values, array order and length", () => {
    expect(sameValue({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue([1], [1, 1])).toBe(false);
    expect(sameValue(null, {})).toBe(false);
  });
});

describe("changedSections", () => {
  it("is empty when the draft only went through edits that were undone", () => {
    const saved = settingsFixture();
    const draft = { ...settingsFixture(), prWorkflows: saved.prWorkflows.map((w) => ({ ...w })) };
    expect(changedSections(saved, draft)).toEqual([]);
  });

  it("maps each changed key to its page in navigation order", () => {
    const saved = settingsFixture();
    const draft = settingsFixture({ codexExtraArgs: "--x", holdingHours: 12, fontSizeCode: 15, opencodeGoUsage: true });
    expect(changedSections(saved, draft)).toEqual(["general", "appearance", "opencode", "codex"]);
  });

  it("attributes workflow edits to PR workflows", () => {
    const saved = settingsFixture();
    const draft = settingsFixture({ prWorkflows: [{ ...saved.prWorkflows[0], startPrompt: "changed" }] });
    expect(changedSections(saved, draft)).toEqual(["prWorkflows"]);
  });
});

describe("settings navigation", () => {
  it("filters items by label, case-insensitively", () => {
    expect(filterSettingsNav(SETTINGS_NAV, "  CODE ").map((item) => item.id)).toEqual(["claude", "opencode", "codex"]);
    expect(filterSettingsNav(SETTINGS_NAV, "source").map((item) => item.id)).toEqual(["sourceControl"]);
    expect(filterSettingsNav(SETTINGS_NAV, "")).toBe(SETTINGS_NAV);
    expect(filterSettingsNav(SETTINGS_NAV, "nothing")).toEqual([]);
  });

  it("round-trips harness pages and app sections", () => {
    expect(viewOfNavId("codex")).toEqual({ section: "harness", harness: "codex" });
    expect(viewOfNavId("prWorkflows")).toEqual({ section: "prWorkflows" });
    expect(navIdOf("harness", "opencode")).toBe("opencode");
    expect(navIdOf("harness", undefined)).toBe("claude");
    expect(navIdOf("updates", "codex")).toBe("updates");
  });
});

describe("settingsDraftStore", () => {
  const repo = { projectId: "p1", account: "", userName: "Ana", userEmail: "ana@example.com", identityEditable: true };

  beforeEach(() => {
    const saved = settingsFixture();
    useSettingsDraftStore.setState({ saved, draft: saved, dirty: false, repoSaved: null, repoDraft: null, saveError: null });
  });

  it("marks the draft dirty on a change and clean again when the change is undone", () => {
    const store = useSettingsDraftStore.getState();
    store.set({ holdingHours: 12 });
    expect(useSettingsDraftStore.getState().dirty).toBe(true);
    store.set({ holdingHours: 24 });
    expect(useSettingsDraftStore.getState().dirty).toBe(false);
  });

  it("keeps immediate-apply settings out of the unsaved changes", () => {
    const store = useSettingsDraftStore.getState();
    store.applied({ claudeBinaryPath: "C:/bin/claude.exe", updateChannel: "alpha" });
    const state = useSettingsDraftStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.draft?.claudeBinaryPath).toBe("C:/bin/claude.exe");
    expect(state.saved?.updateChannel).toBe("alpha");
  });

  it("keeps pending edits when an immediate setting applies", () => {
    const store = useSettingsDraftStore.getState();
    store.set({ codexExtraArgs: "--x" });
    store.applied({ gitBinaryPath: "C:/git/git.exe" });
    const state = useSettingsDraftStore.getState();
    expect(state.dirty).toBe(true);
    expect(state.draft?.codexExtraArgs).toBe("--x");
    expect(state.draft?.gitBinaryPath).toBe("C:/git/git.exe");
  });

  it("tracks repository edits and discards them with the settings draft", () => {
    const store = useSettingsDraftStore.getState();
    store.setRepoBaseline(repo);
    expect(useSettingsDraftStore.getState().dirty).toBe(false);
    store.setRepo({ userName: "Bea" });
    store.set({ fontSizeCode: 15 });
    expect(useSettingsDraftStore.getState().dirty).toBe(true);
    useSettingsDraftStore.getState().discard();
    const state = useSettingsDraftStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.repoDraft).toEqual(repo);
    expect(state.draft?.fontSizeCode).toBe(14);
  });
});
