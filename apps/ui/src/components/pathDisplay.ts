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
