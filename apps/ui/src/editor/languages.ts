import { LanguageDescription } from "@codemirror/language";
import { languages as cmLanguages } from "@codemirror/language-data";
import { baseName, shikiIdFor, shikiLanguageName } from "./languageMap.js";

export interface ResolvedLanguage {
  shiki: string | null;
  label: string;
  cm: LanguageDescription | null;
}

const CM_NAME_BY_SHIKI: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  jsonc: "JSON",
  json5: "JSON",
  jsonl: "JSON",
  markdown: "Markdown",
  mdx: "Markdown",
  html: "HTML",
  vue: "Vue",
  css: "CSS",
  scss: "SCSS",
  less: "LESS",
  xml: "XML",
  xsl: "XML",
  csharp: "C#",
  razor: "HTML",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  cpp: "C++",
  c: "C",
  php: "PHP",
  sql: "SQL",
  yaml: "YAML",
  shellscript: "Shell",
  powershell: "PowerShell",
  docker: "Dockerfile",
  toml: "TOML",
  kotlin: "Kotlin",
  swift: "Swift",
  ruby: "Ruby",
  lua: "Lua",
  dart: "Dart"
};

function cmLanguageFor(name: string, shiki: string | null): LanguageDescription | null {
  const cmName = shiki ? CM_NAME_BY_SHIKI[shiki] : undefined;
  if (cmName) {
    const named = LanguageDescription.matchLanguageName(cmLanguages, cmName, false);
    if (named) return named;
  }
  return LanguageDescription.matchFilename(cmLanguages, name);
}

export function resolveLanguage(path: string): ResolvedLanguage {
  const name = baseName(path);
  const shiki = shikiIdFor(name);
  const cm = cmLanguageFor(name, shiki);
  const label = shikiLanguageName(shiki) ?? cm?.name ?? "Plain Text";
  return { shiki, label, cm };
}
