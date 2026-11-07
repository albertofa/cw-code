function isWindowsStylePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.includes("\\");
}

function stripTrailingSlashes(value: string): string {
  if (/^[a-zA-Z]:\/$/.test(value)) return value;
  if (value === "/") return value;
  return value.replace(/\/+$/, "") || value;
}

function toSlashes(value: string): string {
  return stripTrailingSlashes(value.replace(/\\/g, "/").replace(/\/+/g, "/"));
}

export function shortenHome(input: string, homeDir?: string): string {
  if (!input || typeof input !== "string") return input;
  if (input === "~") return "~";
  if (input.startsWith("~/")) return input.replace(/\/+$/, "") || "~/";
  if (input.startsWith("~\\")) return `~/${toSlashes(input.slice(2))}`;
  if (typeof homeDir !== "string") return input;
  const home = homeDir.trim();
  if (!home) return input;
  const pathKey = toSlashes(input.trim());
  const homeKey = toSlashes(home);
  if (!pathKey || !homeKey) return input;
  const windowsStyle = isWindowsStylePath(input) || isWindowsStylePath(home);
  const pathCmp = windowsStyle ? pathKey.toLowerCase() : pathKey;
  const homeCmp = windowsStyle ? homeKey.toLowerCase() : homeKey;
  if (pathCmp === homeCmp) return "~";
  if (pathCmp.startsWith(`${homeCmp}/`)) return `~${pathKey.slice(homeKey.length)}`;
  return input;
}

export function expandHome(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    const rest = input.slice(2).replace(/\\/g, "/");
    const home = homeDir.replace(/\\/g, "/").replace(/\/+$/, "");
    return rest ? `${home}/${rest}` : home;
  }
  return input;
}

export function stripMentionMarker(path: string): string {
  if (typeof path !== "string") return path;
  return path.startsWith("@") ? path.slice(1) : path;
}

export function looksLikeFileMention(value: string): boolean {
  if (typeof value !== "string" || !value) return false;
  const raw = stripMentionMarker(value.trim());
  if (!raw || /\s/.test(raw)) return false;
  return raw.includes("/") || raw.includes("\\") || raw === "~" || raw.startsWith("~/");
}

function relativizeOrNull(basePath: string, path: string): string | null {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(basePath);
  if (!base) return null;
  const current = norm(path);
  const lowerBase = base.toLowerCase();
  const lowerCurrent = current.toLowerCase();
  if (lowerCurrent === lowerBase) return path;
  if (lowerCurrent.startsWith(`${lowerBase}/`)) return current.slice(base.length + 1);
  return null;
}

export interface AgentResourceFile {
  kind: "plugin" | "skill";
  /** Plugin or skill name. */
  name: string;
  /** Path inside the plugin's or skill's root, slash-separated. */
  path: string;
}

type ResourceLayout = { kind: AgentResourceFile["kind"]; pattern: RegExp; name?: string };

/**
 * Folders that hold plugins and skills, whose ids, hashes and versions say nothing to a reader. Each pattern
 * captures the path inside the resource, plus the name unless the layout has a fixed one. Matching is
 * display-only: an unknown layout keeps the full path. Plugin layouts come first so a plugin's bundled skills
 * show as that plugin's files.
 */
const RESOURCE_LAYOUTS: ResourceLayout[] = [
  // Claude: cache/<marketplace>/<plugin>/<version>/...
  { kind: "plugin", pattern: /\/\.claude\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/(.+)$/i },
  // Claude: marketplaces/<marketplace>/(plugins|external_plugins)/<plugin>/...
  { kind: "plugin", pattern: /\/\.claude\/plugins\/marketplaces\/[^/]+\/(?:plugins|external_plugins)\/([^/]+)\/(.+)$/i },
  // Claude: synced/<org sync id>/<plugin>[~generation]/...
  { kind: "plugin", pattern: /\/\.claude\/plugins\/synced\/[^/]+\/([^/~]+)(?:~[^/]*)?\/(.+)$/i },
  // cw-code's own Claude plugin, written under its userdata (any CW_CODE_HOME).
  { kind: "plugin", name: "cw-code", pattern: /\/userdata\/harness\/claude-plugin\/(.+)$/i },
  // cw-code skills handed to Codex as extra roots, and cw-code's skill library.
  { kind: "skill", pattern: /\/userdata\/harness\/skills\/([^/]+)\/(.+)$/i },
  { kind: "skill", pattern: /\/\.cw-code(?:-dev)?\/userdata\/skills\/([^/]+)\/(.+)$/i },
  // User and project skills: Claude, Codex (current and legacy) and opencode.
  { kind: "skill", pattern: /\/\.claude\/skills\/([^/]+)\/(.+)$/i },
  { kind: "skill", pattern: /\/\.(?:agents|codex)\/skills\/([^/]+)\/(.+)$/i },
  { kind: "skill", pattern: /\/(?:\.config\/opencode|\.opencode)\/skills?\/([^/]+)\/(.+)$/i }
];

export function agentResourceFile(path: string): AgentResourceFile | null {
  if (!path || typeof path !== "string") return null;
  const normalized = toSlashes(stripMentionMarker(path.trim()));
  const anchored = normalized.startsWith("~/") ? normalized.slice(1) : normalized;
  for (const layout of RESOURCE_LAYOUTS) {
    const match = layout.pattern.exec(anchored);
    if (!match) continue;
    const name = layout.name ?? match[1];
    const inner = layout.name ? match[1] : match[2];
    if (name && inner) return { kind: layout.kind, name, path: inner };
  }
  return null;
}

export function formatFileSubject(subject: string, basePath?: string, homeDir?: string): string {
  if (!subject || typeof subject !== "string") return subject;
  const raw = stripMentionMarker(subject);
  if (!raw) return subject;
  if (typeof basePath === "string" && basePath) {
    const rel = relativizeOrNull(basePath, raw);
    if (rel !== null) return rel;
  }
  if (typeof homeDir === "string" && homeDir) {
    const short = shortenHome(raw, homeDir);
    if (short !== raw) return short;
  }
  return raw;
}

export function shortenHomeInText(text: string, homeDir?: string): string {
  if (!text || typeof text !== "string") return text;
  if (typeof homeDir !== "string") return text;
  const home = toSlashes(homeDir.trim());
  if (!home) return text;
  const windowsStyle = isWindowsStylePath(text) || isWindowsStylePath(homeDir);
  const normText = text.replace(/\\/g, "/");
  const homeCmp = windowsStyle ? home.toLowerCase() : home;
  let lower = windowsStyle ? normText.toLowerCase() : normText;
  let idx = lower.indexOf(homeCmp);
  if (idx === -1) return text;
  const out: string[] = [];
  let rest = normText;
  while (idx !== -1) {
    const next = rest[idx + home.length];
    if (next !== undefined && next !== "/") {
      out.push(rest.slice(0, idx + home.length));
      rest = rest.slice(idx + home.length);
    } else {
      out.push(rest.slice(0, idx), "~");
      rest = rest.slice(idx + home.length);
    }
    lower = windowsStyle ? rest.toLowerCase() : rest;
    idx = lower.indexOf(homeCmp);
  }
  out.push(rest);
  return out.join("");
}
