export interface FileRef {
  path: string;
  line?: number;
  endLine?: number;
}

const LINE_SUFFIX = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/;
const EXTENSION = /\.([A-Za-z0-9]{1,8})$/;
const VERSION = /^v?\d+(\.\d+)+$/;
const FORBIDDEN_CHARS = /[\s<>"|?*]/;
const UNC_OR_DEVICE_PREFIX = /^[\\/]{2}/;
const SEPARATOR = /[\\/]/;

const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc",
  "css", "scss", "sass", "less", "html", "htm", "md", "mdx", "txt",
  "yml", "yaml", "toml", "xml", "ini", "cfg", "conf", "env", "lock",
  "cs", "csproj", "sln", "slnx", "props", "targets", "fs", "fsproj",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "gradle",
  "c", "h", "cc", "cpp", "hpp", "m", "mm",
  "sh", "bash", "ps1", "psm1", "psd1", "bat", "cmd",
  "sql", "graphql", "gql", "proto", "vue", "svelte", "astro", "dockerfile"
]);

export function parseFilePath(text: string): FileRef | null {
  if (!text || FORBIDDEN_CHARS.test(text) || text.includes("://") || text.startsWith("--")) return null;
  if (UNC_OR_DEVICE_PREFIX.test(text)) return null;
  const match = LINE_SUFFIX.exec(text);
  if (!match) return null;
  const [, path, line, endLine] = match;
  const name = path.split(SEPARATOR).pop() ?? "";
  const extension = EXTENSION.exec(name)?.[1];
  if (!extension || VERSION.test(name)) return null;
  if (!SEPARATOR.test(path) && !KNOWN_EXTENSIONS.has(extension.toLowerCase())) return null;
  const ref: FileRef = { path };
  if (line !== undefined) ref.line = Number(line);
  if (endLine !== undefined) ref.endLine = Number(endLine);
  return ref;
}
