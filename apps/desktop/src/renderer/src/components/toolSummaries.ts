import {
  Bot,
  Eye,
  FilePlus,
  FolderSearch,
  Globe,
  GraduationCap,
  ListChecks,
  MessageCircleQuestion,
  Pencil,
  Search,
  Terminal,
  Trash2,
  type LucideIcon
} from "lucide-react";
import type { ChatMessage } from "../stores/appStore.js";

export interface DiffStat {
  added: number;
  removed: number;
}

export interface ToolSummary {
  verb: string;
  Icon: LucideIcon;
  subject?: string;
  subjectKind?: "file" | "text";
  stat?: DiffStat;
  fullSubject?: string;
  meta?: string[];
}

const TOOL_KINDS: Record<string, { verb?: string; Icon: LucideIcon }> = {
  write: { verb: "Write", Icon: FilePlus },
  edit: { verb: "Edit", Icon: Pencil },
  read: { verb: "Read", Icon: Eye },
  bash: { Icon: Terminal },
  shell: { Icon: Terminal },
  glob: { verb: "Glob", Icon: FolderSearch },
  grep: { verb: "Grep", Icon: Search },
  skill: { verb: "Skill", Icon: GraduationCap },
  task: { verb: "Task", Icon: Bot },
  todowrite: { verb: "Todos", Icon: ListChecks },
  todo: { verb: "Todos", Icon: ListChecks },
  webfetch: { verb: "Fetch", Icon: Globe },
  websearch: { verb: "Search", Icon: Globe },
  delete: { verb: "Delete", Icon: Trash2 },
  remove: { verb: "Delete", Icon: Trash2 },
  apply_patch: { verb: "Patch", Icon: Pencil },
  patch: { verb: "Patch", Icon: Pencil },
  askuserquestion: { verb: "Ask", Icon: MessageCircleQuestion },
  request_user_input: { verb: "Ask", Icon: MessageCircleQuestion },
  cw_ask: { verb: "Ask", Icon: MessageCircleQuestion },
  question: { verb: "Question", Icon: MessageCircleQuestion }
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pick(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const s = str(args[k]);
    if (s) return s;
  }
  return undefined;
}

function countLines(s: string): number {
  return s === "" ? 0 : s.split("\n").length;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const PATCH_FILE_MARKERS =
  /^\*\*\*\s+(?:Add File|Update File|Move to|Delete File|Rename from|Rename to)\s*:\s*(.+?)\s*$/gim;

export function extractPatchFiles(patchText: string): string[] {
  const files: string[] = [];
  PATCH_FILE_MARKERS.lastIndex = 0;
  for (const match of patchText.matchAll(PATCH_FILE_MARKERS)) {
    const file = match[1].trim().replace(/\s+\(from\s+.+\)$/, "");
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

export function describeToolCall(toolName: string, input: unknown): ToolSummary | null {
  const kind = TOOL_KINDS[toolName.toLowerCase()];
  if (!kind) return null;
  const summary: ToolSummary = {
    verb: kind.verb ?? (toolName.charAt(0).toUpperCase() + toolName.slice(1)),
    Icon: kind.Icon
  };
  if (!input || typeof input !== "object") return summary;
  let args = input as Record<string, unknown>;
  const nested = args["input"];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    args = { ...(nested as Record<string, unknown>), ...args };
  }
  const file = () => pick(args, "file_path", "filePath", "file", "path");

  switch (toolName.toLowerCase()) {
    case "write": {
      const content = str(args["content"]) ?? "";
      const lines = countLines(content);
      summary.subject = file();
      summary.subjectKind = "file";
      if (content) {
        summary.stat = { added: lines, removed: 0 };
        summary.meta = [`${lines} lines`];
      }
      break;
    }
    case "edit": {
      const oldText = str(args["old_string"] ?? args["oldString"]) ?? "";
      const newText = str(args["new_string"] ?? args["newString"]) ?? "";
      summary.subject = file();
      summary.subjectKind = "file";
      if (oldText || newText) summary.stat = { added: countLines(newText), removed: countLines(oldText) };
      break;
    }
    case "read": {
      const offset = num(args["offset"]);
      const limit = num(args["limit"]);
      summary.subject = file();
      summary.subjectKind = "file";
      if (offset !== undefined || limit !== undefined) {
        summary.meta = [`lines ${offset ?? 1}…${limit === undefined ? "end" : (offset ?? 1) + limit - 1}`];
      }
      break;
    }
    case "bash":
    case "shell": {
      const command = pick(args, "command", "cmd") ?? "";
      const description = pick(args, "description");
      if (command) {
        summary.subject = truncate(oneLine(command), 90);
        summary.subjectKind = "text";
        if (oneLine(command).length > 90) summary.fullSubject = command;
      }
      if (description) summary.meta = [description];
      break;
    }
    case "glob": {
      const pattern = pick(args, "pattern");
      const path = pick(args, "path", "dir", "cwd");
      summary.subject = pattern ?? path;
      summary.subjectKind = "text";
      if (pattern && path) summary.meta = [`in ${path}`];
      break;
    }
    case "grep": {
      const path = pick(args, "path", "dir", "cwd");
      const include = pick(args, "include", "glob", "file_pattern");
      summary.subject = pick(args, "pattern", "query", "regex", "text");
      summary.subjectKind = "text";
      const meta: string[] = [];
      if (path) meta.push(`in ${path}`);
      if (include) meta.push(include);
      if (meta.length) summary.meta = meta;
      break;
    }
    case "skill": {
      const name = pick(args, "skill", "skill_id", "skillId", "name");
      summary.subject = name;
      summary.subjectKind = "text";
      const skillArgs = str(args["args"] ?? args["input"]);
      if (name && skillArgs) summary.meta = [truncate(oneLine(skillArgs), 80)];
      break;
    }
    case "task": {
      const description = pick(args, "description", "prompt", "subagent_type", "subagent") ?? "";
      if (description) {
        summary.subject = truncate(oneLine(description), 90);
        summary.subjectKind = "text";
      }
      break;
    }
    case "todowrite":
    case "todo": {
      const todos = Array.isArray(args["todos"]) ? (args["todos"] as Array<Record<string, unknown>>) : [];
      if (todos.length) {
        const done = todos.filter((t) => t["status"] === "completed").length;
        summary.subject = `${done}/${todos.length} done`;
        summary.subjectKind = "text";
      }
      break;
    }
    case "webfetch": {
      const url = pick(args, "url") ?? "";
      if (url) {
        summary.subject = truncate(url, 80);
        summary.subjectKind = "text";
        if (url.length > 80) summary.fullSubject = url;
      }
      break;
    }
    case "websearch":
      summary.subject = pick(args, "query");
      summary.subjectKind = "text";
      break;
    case "delete":
    case "remove":
      summary.subject = file();
      summary.subjectKind = "file";
      break;
    case "askuserquestion":
    case "request_user_input":
    case "cw_ask":
    case "question": {
      const questions = Array.isArray(args["questions"]) ? (args["questions"] as Array<Record<string, unknown>>) : [];
      if (questions.length > 0) {
        summary.subject = `Asked ${questions.length} question${questions.length === 1 ? "" : "s"}`;
        summary.subjectKind = "text";
      }
      break;
    }
    case "apply_patch":
    case "patch": {
      const patchText = pick(args, "patchText", "patch", "diff") ?? "";
      const files = extractPatchFiles(patchText);
      if (files.length > 0) {
        summary.subject = files[0];
        summary.subjectKind = "file";
        if (files.length > 1) summary.meta = [`${files.length} files`];
      }
      break;
    }
  }
  return summary;
}

export function mergeToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const indexById = new Map<string, number>();
  let pending = -1;
  const attach = (idx: number, text: string, isError?: boolean, completedAt?: number): void => {
    const call = out[idx];
    out[idx] = {
      ...call,
      toolOutput: text,
      toolDone: true,
      isError: call.isError === true || isError === true,
      ...(completedAt !== undefined ? { toolCompletedAt: completedAt } : {})
    };
  };
  for (const m of messages) {
    if (m.role === "tool" && m.id.endsWith("-r")) {
      const idx = indexById.get(m.id.slice(0, -2));
      if (idx !== undefined && out[idx].role === "tool") {
        attach(idx, m.text, m.isError, m.timestamp);
        if (pending === idx) pending = -1;
        continue;
      }
    }
    if (
      m.role === "tool" &&
      m.toolName === "result" &&
      pending >= 0 &&
      out[pending].role === "tool" &&
      out[pending].toolInput === undefined &&
      out[pending].toolOutput === undefined
    ) {
      attach(pending, m.text, m.isError, m.timestamp);
      pending = -1;
      continue;
    }
    const stamped =
      m.role === "tool" && m.toolStartedAt === undefined && m.timestamp !== undefined
        ? { ...m, toolStartedAt: m.timestamp }
        : m;
    indexById.set(stamped.id, out.length);
    out.push(stamped);
    if (stamped.role === "tool" && stamped.toolOutput === undefined) pending = out.length - 1;
  }
  return out;
}

export function stripToolNamePrefix(toolName: string, text: string): string {
  if (toolName && text.startsWith(toolName)) {
    const rest = text.slice(toolName.length);
    if (rest === "" || /^\s/.test(rest)) return rest.trimStart();
  }
  return text;
}

export function recoverToolInput(toolName: string, text: string): unknown {
  const rest = stripToolNamePrefix(toolName, text).trimStart();
  if (!rest.startsWith("{") && !rest.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(rest);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function extractCommandFragment(text: string): string | undefined {
  const match = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text);
  if (!match) return undefined;
  return unescapeFragment(match[1]);
}

export function extractFileFragment(text: string): string | undefined {
  const match = /"(?:file_?path|filename)"\s*:\s*"((?:[^"\\]|\\.)*)/i.exec(text);
  if (!match) return undefined;
  return unescapeFragment(match[1]);
}

function unescapeFragment(raw: string): string | undefined {
  try {
    const unescaped: unknown = JSON.parse(`"${raw}"`);
    if (typeof unescaped === "string" && unescaped.trim()) return unescaped;
  } catch {
    /* truncated mid-escape — fall through to raw */
  }
  return raw.trim() ? raw : undefined;
}

export function relativizeToBase(base: string, path: string): string {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = norm(base).toLowerCase();
  const p = norm(path);
  if (p.toLowerCase() === b) {
    return path;
  }
  if (p.toLowerCase().startsWith(`${b}/`)) return p.slice(b.length + 1);
  return path;
}

const BASE_BOUNDARY = /[\s"'&|;/]/;

export function relativizeInText(base: string, text: string): string {
  const normBase = base.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!normBase) return text;
  const normText = text.replace(/\\/g, "/");
  let lower = normText.toLowerCase();
  let idx = lower.indexOf(normBase);
  if (idx === -1) return text;
  const out: string[] = [];
  let rest = normText;
  while (idx !== -1) {
    const next = rest[idx + normBase.length];
    if (next !== undefined && !BASE_BOUNDARY.test(next)) {
      out.push(rest.slice(0, idx + normBase.length));
      rest = rest.slice(idx + normBase.length);
    } else {
      out.push(rest.slice(0, idx), ".");
      rest = rest.slice(idx + normBase.length);
    }
    lower = rest.toLowerCase();
    idx = lower.indexOf(normBase);
  }
  out.push(rest);
  return out.join("");
}

export interface ToolGroupSummary {
  text: string;
  Icon: LucideIcon;
  status: "complete" | "error" | "running" | "pending";
  hasRunning: boolean;
}

type GroupableMessage = {
  toolName?: string;
  isError?: boolean;
  toolInput?: unknown;
  toolOutput?: string;
  toolDone?: boolean;
};

function isRunningTool(m: { toolInput?: unknown; toolOutput?: string; toolDone?: boolean }): boolean {
  const done = m.toolDone === true || m.toolOutput !== undefined;
  return m.toolInput !== undefined && !done;
}

function groupItemStatus(m: GroupableMessage): "error" | "running" | "complete" | "pending" {
  if (m.isError === true) return "error";
  if (isRunningTool(m)) return "running";
  if (m.toolDone === true || m.toolOutput !== undefined) return "complete";
  return "pending";
}

export function summarizeToolGroup(messages: GroupableMessage[]): ToolGroupSummary | null {
  if (messages.length === 0) return null;
  let commands = 0;
  let reads = 0;
  let edits = 0;
  let searches = 0;
  let fetches = 0;
  const otherCounts = new Map<string, number>();
  const order: string[] = [];
  const pushOrder = (key: string) => {
    if (!order.includes(key)) order.push(key);
  };
  for (const m of messages) {
    const name = (m.toolName ?? "tool").toLowerCase();
    if (name === "bash" || name === "shell") {
      commands++;
      pushOrder("commands");
    } else if (name === "read") {
      reads++;
      pushOrder("reads");
    } else if (name === "write" || name === "edit" || name === "apply_patch" || name === "patch" || name === "delete" || name === "remove") {
      edits++;
      pushOrder("edits");
    } else if (name === "grep" || name === "glob") {
      searches++;
      pushOrder("searches");
    } else if (name === "webfetch" || name === "websearch") {
      fetches++;
      pushOrder("fetches");
    } else if (name === "askuserquestion" || name === "request_user_input" || name === "cw_ask" || name === "question") {
      otherCounts.set("questions", (otherCounts.get("questions") ?? 0) + 1);
      pushOrder("questions");
    } else {
      otherCounts.set(name, (otherCounts.get(name) ?? 0) + 1);
      pushOrder(name);
    }
  }
  let hasError = false;
  let hasRunning = false;
  let allDone = true;
  for (const m of messages) {
    const s = groupItemStatus(m);
    if (s === "error") hasError = true;
    if (s === "running") hasRunning = true;
    if (s !== "complete" && s !== "error") allDone = false;
  }
  const status = hasError ? "error" : hasRunning ? "running" : allDone ? "complete" : "pending";
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const parts: string[] = [];
  for (const key of order) {
    if (key === "edits") parts.push(`${hasRunning ? "Editing" : "Edited"} ${edits} ${plural(edits, "file", "files")}`);
    else if (key === "reads") parts.push(`${hasRunning ? "Reading" : "Read"} ${reads} ${plural(reads, "file", "files")}`);
    else if (key === "commands") parts.push(`${hasRunning ? "Running" : "Ran"} ${commands} ${plural(commands, "command", "commands")}`);
    else if (key === "searches") parts.push(`${hasRunning ? "Searching" : "Searched"} ${searches} ${plural(searches, "path", "paths")}`);
    else if (key === "fetches") parts.push(`${hasRunning ? "Fetching" : "Fetched"} ${fetches} ${plural(fetches, "URL", "URLs")}`);
    else if (key === "questions") {
      const n = otherCounts.get("questions") ?? 0;
      parts.push(`${hasRunning ? "Asking" : "Asked"} ${n} ${plural(n, "question", "questions")}`);
    } else {
      const n = otherCounts.get(key) ?? 0;
      const verb = TOOL_KINDS[key]?.verb ?? key.charAt(0).toUpperCase() + key.slice(1);
      parts.push(`${hasRunning ? "Running" : "Ran"} ${n} ${plural(n, verb.toLowerCase(), `${verb.toLowerCase()}s`)}`);
    }
  }
  const text = parts
    .map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1)))
    .join(", ");
  const firstName = (messages[0].toolName ?? "tool").toLowerCase();
  const Icon = TOOL_KINDS[firstName]?.Icon ?? Terminal;
  return { text, Icon, status, hasRunning };
}

export function orderToolsForDisplay<T extends { role: string; toolInput?: unknown; toolOutput?: string; toolDone?: boolean }>(
  messages: T[]
): T[] {
  const out: T[] = [];
  let group: T[] = [];
  const flush = () => {
    group.sort((a, b) => (isRunningTool(a) ? 1 : 0) - (isRunningTool(b) ? 1 : 0));
    out.push(...group);
    group = [];
  };
  for (const m of messages) {
    if (m.role === "tool") group.push(m);
    else {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${total % 60}s`;
}
