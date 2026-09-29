export interface FileRef {
  path: string;
  line?: number;
  endLine?: number;
}

const LINE_SUFFIX = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/;
const EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
const VERSION = /^v?\d+(\.\d+)+$/;
const FORBIDDEN_CHARS = /[\s<>"|?*]/;

export function parseFilePath(text: string): FileRef | null {
  if (!text || FORBIDDEN_CHARS.test(text) || text.includes("://") || text.startsWith("--")) return null;
  const match = LINE_SUFFIX.exec(text);
  if (!match) return null;
  const [, path, line, endLine] = match;
  const name = path.split(/[\\/]/).pop() ?? "";
  if (!EXTENSION.test(name) || VERSION.test(name)) return null;
  const ref: FileRef = { path };
  if (line !== undefined) ref.line = Number(line);
  if (endLine !== undefined) ref.endLine = Number(endLine);
  return ref;
}
