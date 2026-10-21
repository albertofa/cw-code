import { bundledLanguagesInfo } from "shiki/langs";
import { describe, expect, it } from "vitest";
import { resolveLanguage } from "./languages.js";
import { SHIKI_LANGUAGES } from "./shikiLanguages.js";

describe("SHIKI_LANGUAGES", () => {
  it("mirrors the bundled Shiki language list", () => {
    expect(SHIKI_LANGUAGES.map(([id, name, aliases]) => ({ id, name, aliases: aliases ?? [] }))).toEqual(
      bundledLanguagesInfo.map((info) => ({ id: info.id, name: info.name, aliases: info.aliases ?? [] }))
    );
  });
});

describe("resolveLanguage", () => {
  it.each([
    ["src/app.ts", "typescript", "TypeScript"],
    ["src/App.tsx", "tsx", "TSX"],
    ["Program.cs", "csharp", "C#"],
    ["Views/Home/Index.cshtml", "razor", "ASP.NET Razor"],
    ["Api.csproj", "xml", "XML"],
    ["scripts/build.ps1", "powershell", "PowerShell"],
    ["Dockerfile", "docker", "Dockerfile"],
    ["deploy/Dockerfile.prod", "docker", "Dockerfile"],
    ["Makefile", "make", "Makefile"],
    [".env.local", "dotenv", "dotEnv"],
    ["tsconfig.json", "jsonc", "JSON with Comments"],
    ["package.json", "json", "JSON"],
    ["docs/README.md", "markdown", "Markdown"],
    ["config.yml", "yaml", "YAML"],
    ["main.rs", "rust", "Rust"],
    ["run.sh", "shellscript", "Shell"],
    ["C:\\repo\\src\\main.py", "python", "Python"]
  ])("maps %s to %s", (path, shiki, label) => {
    const resolved = resolveLanguage(path);
    expect(resolved.shiki).toBe(shiki);
    expect(resolved.label).toBe(label);
  });

  it("falls back to a Shiki id or alias equal to the extension", () => {
    expect(resolveLanguage("query.kql").shiki).toBe("kusto");
    expect(resolveLanguage("main.zig").shiki).toBe("zig");
  });

  it("attaches a CodeMirror language for structural features when one exists", () => {
    expect(resolveLanguage("a.ts").cm?.name).toBe("TypeScript");
    expect(resolveLanguage("a.cs").cm?.name).toBe("C#");
    expect(resolveLanguage("a.json").cm?.name).toBe("JSON");
  });

  it("returns plain text for unknown files", () => {
    expect(resolveLanguage("LICENSE")).toEqual({ shiki: null, label: "Plain Text", cm: null });
    expect(resolveLanguage("data.unknownext").shiki).toBeNull();
  });
});
