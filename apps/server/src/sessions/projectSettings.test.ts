import { describe, expect, it } from "bun:test";
import { MAX_PROJECT_INSTRUCTION_CHARS, MAX_PROJECT_SCRIPT_CHARS, sanitizeProjectSettings } from "./projectSettings.js";

describe("sanitizeProjectSettings", () => {
  it("keeps valid values and trims text", () => {
    expect(
      sanitizeProjectSettings({
        defaultDriver: "codex",
        defaultModel: " gpt-5.5 ",
        defaultEffort: "high",
        defaultPermissionMode: "acceptEdits",
        setupScript: "\n bun install\n",
        destroyScript: "docker compose down",
        titleInstructions: " Start with the ticket key ",
        branchInstructions: "feat/<summary>"
      })
    ).toEqual({
      defaultDriver: "codex",
      defaultModel: "gpt-5.5",
      defaultEffort: "high",
      defaultPermissionMode: "acceptEdits",
      setupScript: "bun install",
      destroyScript: "docker compose down",
      titleInstructions: "Start with the ticket key",
      branchInstructions: "feat/<summary>"
    });
  });

  it("drops unknown enum values, blank text and a model without its harness", () => {
    expect(
      sanitizeProjectSettings({
        defaultDriver: "cursor",
        defaultModel: "claude-opus-5-5",
        defaultEffort: "extreme",
        defaultPermissionMode: "yolo",
        setupScript: "   ",
        titleInstructions: 42
      })
    ).toEqual({});
  });

  it("accepts nothing from non-objects", () => {
    expect(sanitizeProjectSettings(undefined)).toEqual({});
    expect(sanitizeProjectSettings("bun install")).toEqual({});
  });

  it("caps scripts and instructions", () => {
    const settings = sanitizeProjectSettings({ setupScript: "x".repeat(MAX_PROJECT_SCRIPT_CHARS + 10), branchInstructions: "y".repeat(MAX_PROJECT_INSTRUCTION_CHARS + 10) });
    expect(settings.setupScript?.length).toBe(MAX_PROJECT_SCRIPT_CHARS);
    expect(settings.branchInstructions?.length).toBe(MAX_PROJECT_INSTRUCTION_CHARS);
  });
});
