import { LanguageDescription } from "@codemirror/language";
import { languages as cmLanguages } from "@codemirror/language-data";
import { SHIKI_LANGUAGES } from "./shikiLanguages.js";

export interface ResolvedLanguage {
  shiki: string | null;
  label: string;
  cm: LanguageDescription | null;
}

const FILE_NAMES: Record<string, string> = {
  dockerfile: "docker",
  containerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "cmake",
  justfile: "just",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  vagrantfile: "ruby",
  brewfile: "ruby",
  jenkinsfile: "groovy",
  codeowners: "codeowners",
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zshrc": "shellscript",
  ".zprofile": "shellscript",
  ".profile": "shellscript",
  ".env": "dotenv",
  ".editorconfig": "ini",
  ".gitconfig": "ini",
  ".npmrc": "ini",
  ".prettierrc": "json",
  ".babelrc": "jsonc",
  ".eslintrc": "jsonc",
  "tsconfig.json": "jsonc",
  "jsconfig.json": "jsonc",
  "devcontainer.json": "jsonc",
  "settings.json": "jsonc",
  "launch.json": "jsonc",
  "tasks.json": "jsonc",
  "extensions.json": "jsonc",
  "nginx.conf": "nginx",
  "commit_editmsg": "git-commit",
  "git-rebase-todo": "git-rebase"
};

const EXTENSIONS: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  jsonl: "jsonl",
  ndjson: "jsonl",
  ipynb: "json",
  webmanifest: "json",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  styl: "stylus",
  xml: "xml",
  xsd: "xml",
  xsl: "xsl",
  xslt: "xsl",
  svg: "xml",
  plist: "xml",
  xaml: "xml",
  axaml: "xml",
  csproj: "xml",
  fsproj: "xml",
  vbproj: "xml",
  vcxproj: "xml",
  sqlproj: "xml",
  props: "xml",
  targets: "xml",
  nuspec: "xml",
  resx: "xml",
  config: "xml",
  manifest: "xml",
  wsdl: "xml",
  slnx: "xml",
  cs: "csharp",
  csx: "csharp",
  cshtml: "razor",
  razor: "razor",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  vb: "vb",
  py: "python",
  pyi: "python",
  pyw: "python",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sc: "scala",
  groovy: "groovy",
  gradle: "groovy",
  swift: "swift",
  m: "objective-c",
  mm: "objective-cpp",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  ino: "cpp",
  php: "php",
  pl: "perl",
  pm: "perl",
  lua: "lua",
  r: "r",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  hs: "haskell",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  edn: "clojure",
  ml: "ocaml",
  mli: "ocaml",
  zig: "zig",
  nim: "nim",
  jl: "julia",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ksh: "shellscript",
  fish: "fish",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "bat",
  cmd: "bat",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  env: "dotenv",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "hcl",
  bicep: "bicep",
  dockerfile: "docker",
  mk: "make",
  cmake: "cmake",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  hbs: "handlebars",
  handlebars: "handlebars",
  twig: "twig",
  liquid: "liquid",
  pug: "pug",
  haml: "haml",
  erb: "erb",
  njk: "jinja",
  j2: "jinja",
  jinja: "jinja",
  prisma: "prisma",
  sol: "solidity",
  nix: "nix",
  tex: "latex",
  sty: "latex",
  cls: "latex",
  bib: "bibtex",
  rst: "rst",
  adoc: "asciidoc",
  diff: "diff",
  patch: "diff",
  csv: "csv",
  tsv: "tsv",
  log: "log",
  http: "http",
  rest: "http",
  glsl: "glsl",
  vert: "glsl",
  frag: "glsl",
  hlsl: "hlsl",
  wgsl: "wgsl",
  vim: "viml",
  asm: "asm",
  s: "asm",
  reg: "reg",
  tsp: "typespec",
  typ: "typst",
  gleam: "gleam",
  v: "v",
  odin: "odin",
  mojo: "mojo",
  kdl: "kdl",
  mermaid: "mermaid",
  mmd: "mermaid"
};

const SHIKI_BY_ID = new Map<string, { id: string; name: string }>();
for (const [id, name, aliases] of SHIKI_LANGUAGES) {
  const info = { id, name };
  SHIKI_BY_ID.set(id, info);
  for (const alias of aliases ?? []) if (!SHIKI_BY_ID.has(alias)) SHIKI_BY_ID.set(alias, info);
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

function baseName(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function shikiIdFor(name: string): string | null {
  const lower = name.toLowerCase();
  const byName = FILE_NAMES[lower];
  if (byName) return byName;
  if (lower.startsWith(".env.")) return "dotenv";
  if (lower.startsWith("dockerfile.") || lower.endsWith(".dockerfile")) return "docker";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot + 1);
  return EXTENSIONS[ext] ?? SHIKI_BY_ID.get(ext)?.id ?? null;
}

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
  const label = (shiki ? SHIKI_BY_ID.get(shiki)?.name : undefined) ?? cm?.name ?? "Plain Text";
  return { shiki, label, cm };
}
