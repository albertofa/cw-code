export interface InstallerDigest {
  sha512: string;
  size: number;
}

export interface UpdateInfoFileEntry extends InstallerDigest {
  url: string;
}

export interface UpdateInfo {
  version: string;
  path: string;
  sha512: string;
  files: UpdateInfoFileEntry[];
}

export interface UpdateInfoRewrite {
  text: string;
  changed: boolean;
  previous: InstallerDigest;
}

interface ScalarField {
  line: number;
  prefix: string;
  key: string;
  value: string;
}

interface ParsedDocument {
  lines: string[];
  eol: string;
  topLevel: Map<string, ScalarField>;
  files: Map<string, ScalarField>[];
}

const TOP_LEVEL_KEY = /^([A-Za-z][\w-]*):(?: (.*))?$/;
const LIST_ITEM = /^(\s*- )([A-Za-z][\w-]*):(?: (.*))?$/;
const NESTED_KEY = /^(\s+)([A-Za-z][\w-]*):(?: (.*))?$/;
const PLAIN_SAFE = /^[A-Za-z0-9][A-Za-z0-9+/=._-]*$/;
const PLAIN_AMBIGUOUS = /^(?:[-+]?[0-9._]+(?:e[-+]?[0-9]+)?|true|false|null|yes|no|on|off|~)$/i;
const INTEGER = /^[0-9]+$/;

export function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) throw new Error(`Unterminated single-quoted scalar: ${value}`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string") throw new Error(`Invalid double-quoted scalar: ${value}`);
    return parsed;
  }
  return value;
}

export function formatScalar(value: string): string {
  if (PLAIN_SAFE.test(value) && !PLAIN_AMBIGUOUS.test(value)) return value;
  return `'${value.replaceAll("'", "''")}'`;
}

function parseDocument(text: string): ParsedDocument {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const topLevel = new Map<string, ScalarField>();
  const files: Map<string, ScalarField>[] = [];
  let section: string | null = null;

  lines.forEach((line, index) => {
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const top = TOP_LEVEL_KEY.exec(line);
    if (top) {
      const [, key, rawValue] = top;
      if (topLevel.has(key)) throw new Error(`Duplicate top-level key "${key}" on line ${index + 1}`);
      section = key;
      topLevel.set(key, { line: index, prefix: "", key, value: rawValue ?? "" });
      return;
    }
    if (section !== "files") return;
    const item = LIST_ITEM.exec(line);
    if (item) {
      const [, prefix, key, rawValue] = item;
      files.push(new Map([[key, { line: index, prefix, key, value: rawValue ?? "" }]]));
      return;
    }
    const nested = NESTED_KEY.exec(line);
    const current = files.at(-1);
    if (nested && current) {
      const [, prefix, key, rawValue] = nested;
      if (current.has(key)) throw new Error(`Duplicate key "${key}" in files entry on line ${index + 1}`);
      current.set(key, { line: index, prefix, key, value: rawValue ?? "" });
    }
  });

  return { lines, eol, topLevel, files };
}

function requireField(fields: Map<string, ScalarField>, key: string, where: string): string {
  const field = fields.get(key);
  if (!field || field.value.trim() === "") throw new Error(`Update info is missing "${key}" ${where}`);
  return parseScalar(field.value);
}

function requireSize(fields: Map<string, ScalarField>, where: string): number {
  const raw = requireField(fields, "size", where);
  if (!INTEGER.test(raw)) throw new Error(`Update info "size" ${where} is not a non-negative integer: ${raw}`);
  return Number(raw);
}

function assertBareFileName(name: string): void {
  if (name === "" || name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new Error(`Update info path must be a bare file name, got "${name}"`);
  }
}

function toUpdateInfo(document: ParsedDocument): UpdateInfo {
  const version = requireField(document.topLevel, "version", "at top level");
  const path = requireField(document.topLevel, "path", "at top level");
  const sha512 = requireField(document.topLevel, "sha512", "at top level");
  assertBareFileName(path);
  if (document.files.length === 0) throw new Error(`Update info has no "files" entries`);
  if (document.files.length !== 1) {
    throw new Error(`Update info lists ${document.files.length} files; only a single installer per update info file is supported`);
  }
  const files = document.files.map((entry, index) => {
    const where = `in files[${index}]`;
    return { url: requireField(entry, "url", where), sha512: requireField(entry, "sha512", where), size: requireSize(entry, where) };
  });
  if (files[0].url !== path) {
    throw new Error(`Update info files[0].url "${files[0].url}" does not match top-level path "${path}"`);
  }
  return { version, path, sha512, files };
}

export function parseUpdateInfo(text: string): UpdateInfo {
  return toUpdateInfo(parseDocument(text));
}

export function rewriteUpdateInfo(text: string, digest: InstallerDigest): UpdateInfoRewrite {
  if (!Number.isSafeInteger(digest.size) || digest.size < 0) throw new Error(`Invalid installer size ${digest.size}`);
  const document = parseDocument(text);
  const info = toUpdateInfo(document);
  const lines = [...document.lines];
  let changed = false;

  const replace = (field: ScalarField | undefined, next: string, formatted: string): void => {
    if (!field) throw new Error("Update info field disappeared while rewriting");
    if (parseScalar(field.value) === next) return;
    lines[field.line] = `${field.prefix}${field.key}: ${formatted}`;
    changed = true;
  };

  const entry = document.files[0];
  replace(entry.get("sha512"), digest.sha512, formatScalar(digest.sha512));
  replace(entry.get("size"), String(digest.size), String(digest.size));
  replace(document.topLevel.get("sha512"), digest.sha512, formatScalar(digest.sha512));
  replace(document.topLevel.get("path"), info.files[0].url, formatScalar(info.files[0].url));

  return {
    text: changed ? lines.join(document.eol) : text,
    changed,
    previous: { sha512: info.files[0].sha512, size: info.files[0].size }
  };
}

export function readPublisherNames(appUpdateText: string): string[] {
  const lines = appUpdateText.split(/\r?\n/);
  const start = lines.findIndex((line) => TOP_LEVEL_KEY.exec(line)?.[1] === "publisherName");
  if (start === -1) return [];
  const inline = TOP_LEVEL_KEY.exec(lines[start])?.[2];
  if (inline !== undefined && inline.trim() !== "") return [parseScalar(inline)];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*- (.*)$/.exec(line);
    if (!item) break;
    names.push(parseScalar(item[1]));
  }
  return names;
}
