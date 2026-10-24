import { normalize } from "node:path";
import { describe, expect, it } from "bun:test";
import { CLAUDE_CURATED_MODELS } from "../providers/claude/ClaudeCliDriver.js";
import { DEFAULT_SETTINGS } from "./SettingsStore.js";
import {
  configuredCliBinaryPath,
  defaultCliBinaryPath,
  isDefaultCliBinaryPath,
  normalizeBinaryPath,
  parseExtraArgs,
  resolveClaudeModels
} from "./settingsUtils.js";

const curated = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" }
];

describe("parseExtraArgs", () => {
  it("returns [] for empty input", () => {
    expect(parseExtraArgs("")).toEqual([]);
    expect(parseExtraArgs("   ")).toEqual([]);
  });

  it("splits plain whitespace-separated args", () => {
    expect(parseExtraArgs("--foo bar  --baz")).toEqual(["--foo", "bar", "--baz"]);
  });

  it("keeps double-quoted segments together", () => {
    expect(parseExtraArgs('--model "opus one" --flag')).toEqual(["--model", "opus one", "--flag"]);
  });

  it("keeps single-quoted segments together", () => {
    expect(parseExtraArgs("--model 'opus one' --flag")).toEqual(["--model", "opus one", "--flag"]);
  });

  it("handles mixed quoting and drops empties", () => {
    expect(parseExtraArgs(`--a "x y" --b 'p q' plain "" ''`)).toEqual(["--a", "x y", "--b", "p q", "plain"]);
  });
});

describe("resolveClaudeModels", () => {
  it("resolves defaults to the latest model of each family", () => {
    expect(resolveClaudeModels(DEFAULT_SETTINGS, CLAUDE_CURATED_MODELS)).toEqual([
      { id: "claude-opus-5-5", label: "Opus 5.5", source: "curated" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", source: "curated" },
      { id: "fable", label: "Fable 5.1", source: "curated" },
      { id: "claude-haiku-5-5", label: "Haiku 5.5", source: "curated" }
    ]);
  });

  it("keeps curated order and drops a disabled model", () => {
    expect(
      resolveClaudeModels(
        { claudeEnabledModels: ["haiku", "opus"], claudeCustomModel: { id: "", name: "" } },
        curated
      )
    ).toEqual([
      { id: "opus", label: "Opus", source: "curated" },
      { id: "haiku", label: "Haiku", source: "curated" }
    ]);
  });

  it("appends a trimmed custom model once, labeled by its display name", () => {
    expect(
      resolveClaudeModels(
        {
          claudeEnabledModels: ["opus"],
          claudeCustomModel: { id: "  my-model  ", name: "  My Model  " }
        },
        curated
      )
    ).toEqual([
      { id: "opus", label: "Opus", source: "curated" },
      { id: "my-model", label: "My Model", source: "custom" }
    ]);
  });

  it("falls back to the id when the custom display name is empty", () => {
    expect(
      resolveClaudeModels(
        { claudeEnabledModels: ["opus"], claudeCustomModel: { id: "my-model", name: "  " } },
        curated
      )
    ).toEqual([
      { id: "opus", label: "Opus", source: "curated" },
      { id: "my-model", label: "my-model", source: "custom" }
    ]);
  });

  it("does not double a custom model that duplicates a curated id", () => {
    expect(
      resolveClaudeModels(
        {
          claudeEnabledModels: ["opus", "sonnet"],
          claudeCustomModel: { id: "sonnet", name: "Custom Sonnet" }
        },
        curated
      )
    ).toEqual([
      { id: "opus", label: "Opus", source: "curated" },
      { id: "sonnet", label: "Sonnet", source: "curated" }
    ]);
  });

  it("ignores an empty custom model", () => {
    expect(
      resolveClaudeModels(
        { claudeEnabledModels: ["opus"], claudeCustomModel: { id: "   ", name: "Nope" } },
        curated
      )
    ).toEqual([{ id: "opus", label: "Opus", source: "curated" }]);
  });

  it("drops unknown enabled ids and empty entries", () => {
    expect(
      resolveClaudeModels(
        {
          claudeEnabledModels: ["nope", "", "  ", "sonnet"],
          claudeCustomModel: { id: "", name: "" }
        },
        curated
      )
    ).toEqual([{ id: "sonnet", label: "Sonnet", source: "curated" }]);
  });
});

describe("normalizeBinaryPath", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeBinaryPath("  claude  ")).toBe("claude");
  });

  it("keeps empty input empty", () => {
    expect(normalizeBinaryPath("")).toBe("");
    expect(normalizeBinaryPath("   ")).toBe("");
  });

  it("normalizes paths containing a separator", () => {
    expect(normalizeBinaryPath("  a//b  ")).toBe(normalize("a//b"));
  });
});

describe("defaultCliBinaryPath", () => {
  it("uses executable names for Windows", () => {
    expect(defaultCliBinaryPath("claude", "win32")).toBe("claude.exe");
    expect(defaultCliBinaryPath("opencode", "win32")).toBe("opencode.exe");
  });

  it("uses extensionless executable names on macOS and Linux", () => {
    expect(defaultCliBinaryPath("claude", "darwin")).toBe("claude");
    expect(defaultCliBinaryPath("opencode", "linux")).toBe("opencode");
  });
});

describe("configuredCliBinaryPath", () => {
  it("normalizes configured paths", () => {
    expect(configuredCliBinaryPath("claude", "  a//claude  ", "linux")).toBe(normalize("a//claude"));
  });

  it("resets blank values to the OS default", () => {
    expect(configuredCliBinaryPath("claude", "  ", "win32")).toBe("claude.exe");
    expect(configuredCliBinaryPath("opencode", "", "linux")).toBe("opencode");
  });
});

describe("isDefaultCliBinaryPath", () => {
  it("treats blank and bare harness names as the default lookup", () => {
    expect(isDefaultCliBinaryPath("codex", "")).toBe(true);
    expect(isDefaultCliBinaryPath("codex", " codex ")).toBe(true);
    expect(isDefaultCliBinaryPath("codex", "Codex.EXE")).toBe(true);
  });

  it("treats paths and other names as explicitly configured", () => {
    expect(isDefaultCliBinaryPath("codex", "C:\\tools\\codex.exe")).toBe(false);
    expect(isDefaultCliBinaryPath("codex", "/usr/local/bin/codex")).toBe(false);
    expect(isDefaultCliBinaryPath("codex", "codex-nightly")).toBe(false);
  });
});
