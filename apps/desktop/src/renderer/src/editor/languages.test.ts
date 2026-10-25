import { bundledLanguagesInfo } from "shiki/langs";
import { describe, expect, it } from "bun:test";
import { resolveFenceLanguage } from "./languageMap.js";
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

describe("resolveFenceLanguage", () => {
  it.each([
    ["js", "javascript", "JavaScript"],
    ["ts", "typescript", "TypeScript"],
    ["tsx", "tsx", "TSX"],
    ["py", "python", "Python"],
    ["c++", "cpp", "C++"],
    ["c#", "csharp", "C#"],
    ["sh", "shellscript", "Shell"],
    ["ps1", "powershell", "PowerShell"],
    ["cs", "csharp", "C#"],
    ["kql", "kusto", "Kusto"],
    ["dockerfile", "docker", "Dockerfile"],
    ["Makefile", "make", "Makefile"],
    [".env.local", "dotenv", "dotEnv"],
    ["package.json", "json", "JSON"],
    ["Dockerfile.prod", "docker", "Dockerfile"],
    ["main.zig", "zig", "Zig"],
    ["src/App.tsx", "tsx", "TSX"],
    ["cc", "cpp", "C++"],
    ["h", "c", "C"],
    ["m", "objective-c", "Objective-C"],
    ["psm1", "powershell", "PowerShell"],
    ["cshtml", "razor", "ASP.NET Razor"],
    ["env", "dotenv", "dotEnv"],
    ["sol", "solidity", "Solidity"],
    ["patch", "diff", "Diff"]
  ])("maps the fence %s to %s", (info, shiki, label) => {
    expect(resolveFenceLanguage(info)).toEqual({ shiki, label });
  });

  it("resolves every bundled Shiki language id and alias", () => {
    for (const [id, name, aliases] of SHIKI_LANGUAGES) {
      expect(resolveFenceLanguage(id)).toEqual({ shiki: id, label: name });
      for (const alias of aliases ?? []) expect(resolveFenceLanguage(alias).shiki).toBe(id);
    }
  });

  it("ignores fence metadata after the language", () => {
    expect(resolveFenceLanguage("js title=\"example\"")).toEqual({ shiki: "javascript", label: "JavaScript" });
  });

  it("treats plain-text fence names as unhighlighted", () => {
    for (const info of ["text", "txt", "plain", "plaintext", "none", ""]) {
      expect(resolveFenceLanguage(info)).toEqual({ shiki: null, label: "Plain Text" });
    }
    expect(resolveFenceLanguage(null)).toEqual({ shiki: null, label: "Plain Text" });
  });

  it("keeps an unknown fence language as its label without highlighting", () => {
    expect(resolveFenceLanguage("foobar")).toEqual({ shiki: null, label: "foobar" });
  });
});
