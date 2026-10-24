export interface ToolGitEffect {
  refreshLocal: boolean;
  remoteEffect: boolean;
}

export const REMOTE_EFFECT_RE =
  /\bgh\s+pr\s+(create|merge|close|reopen|ready|edit)\b|\bgit(?:\s+-[cC]\s+\S+)*\s+push\b|\bgh\s+api\b[^\n]*\/pulls\b/;

const SHELL_TOOLS = new Set(["bash", "shell", "powershell"]);
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "patch", "apply_patch"]);
const NO_EFFECT: ToolGitEffect = { refreshLocal: false, remoteEffect: false };

function commandText(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const command = (input as { command?: unknown }).command;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) {
    return command.filter((part): part is string => typeof part === "string").join(" ");
  }
  return "";
}

export function classifyToolCall(name: string, input: unknown): ToolGitEffect {
  const tool = name.toLowerCase();
  if (SHELL_TOOLS.has(tool)) {
    return { refreshLocal: true, remoteEffect: REMOTE_EFFECT_RE.test(commandText(input)) };
  }
  if (EDIT_TOOLS.has(tool)) return { refreshLocal: true, remoteEffect: false };
  return NO_EFFECT;
}

const IGNORED_PREFIXES = ["objects/", "logs/", "hooks/"];
const RELEVANT_PREFIXES = ["refs/heads/", "refs/remotes/", "refs/tags/"];
const RELEVANT_FILES = new Set(["HEAD", "packed-refs", "config"]);

export function gitWatchEventKind(relPath: string): "relevant" | "ignored" {
  const path = relPath.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (path === "" || path.endsWith(".lock") || path === "index") return "ignored";
  if (IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix))) return "ignored";
  if (RELEVANT_FILES.has(path)) return "relevant";
  if (RELEVANT_PREFIXES.some((prefix) => path.startsWith(prefix))) return "relevant";
  return "ignored";
}
