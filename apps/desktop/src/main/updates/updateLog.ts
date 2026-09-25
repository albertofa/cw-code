import { appendFileSync } from "node:fs";
import { rotateIfOversize } from "../debug/logRotation.js";
import type { UpdateFailure } from "./updateState.js";

const LOG_MAX_CHARS = 2_000;
const ERROR_MESSAGE_MAX_CHARS = 300;
export const UPDATE_LOG_MAX_BYTES = 1024 * 1024;

const NON_RETRYABLE_CODES = new Set([
  "ERR_UPDATER_INVALID_SIGNATURE",
  "ERR_UPDATER_INVALID_VERSION",
  "ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION",
  "ERR_UPDATER_UNSUPPORTED_PROVIDER",
  "ERR_UPDATER_WEB_INSTALLER_DISABLED"
]);

const NETWORK_ERROR_RE = /net::ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|CONNECTION_[A-Z_]+|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_[A-Z_]+|TUNNEL_CONNECTION_FAILED)/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function homeDirPattern(homeDir: string): RegExp | null {
  const trimmed = homeDir.replace(/[\\/]+$/, "");
  if (trimmed.length < 3) return null;
  const segments = trimmed.split(/[\\/]+/).map(escapeRegExp);
  return new RegExp(segments.join("[\\\\/]+"), "gi");
}

export function redactUpdateText(text: string, homeDir: string): string {
  let out = text
    .replace(/(https?:\/\/)[^\s/@"'<>]+@/gi, "$1")
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "<redacted-token>")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>")
    .replace(/(staging user id:?\s*)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "$1<redacted>")
    .replace(/\b(authorization|x-github-token|access_token|token|password|secret)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1$2<redacted>");
  const home = homeDirPattern(homeDir);
  if (home) out = out.replace(home, "~");
  out = out.replace(/\b([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'<>]+/gi, "$1<user>");
  return out.length > LOG_MAX_CHARS ? `${out.slice(0, LOG_MAX_CHARS)}…` : out;
}

export function formatLogValue(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function updateErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function isMissingReleaseError(error: unknown): boolean {
  const code = updateErrorCode(error);
  const message = error instanceof Error ? error.message : "";
  if (code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND") return /HttpError: 404\b/.test(message);
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND") return !NETWORK_ERROR_RE.test(message);
  return false;
}

export interface UpdateLogSink {
  info(message: string): void;
  warn(message: string): void;
}

export function createUpdateLogFile(options: {
  filePath: string;
  maxBytes?: number;
  console?: UpdateLogSink;
  now?: () => Date;
}): UpdateLogSink {
  const maxBytes = options.maxBytes ?? UPDATE_LOG_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const write = (level: "info" | "warn", message: string): void => {
    options.console?.[level](`[updates] ${message}`);
    try {
      rotateIfOversize(options.filePath, maxBytes);
    } catch (error) {
      options.console?.warn(`[updates] could not rotate ${options.filePath}: ${(error as Error).message}`);
    }
    try {
      appendFileSync(options.filePath, `${now().toISOString()} ${level} ${message}\n`, "utf8");
    } catch (error) {
      options.console?.warn(`[updates] could not write ${options.filePath}: ${(error as Error).message}`);
    }
  };
  return { info: (message) => write("info", message), warn: (message) => write("warn", message) };
}

export function describeUpdateError(error: unknown, homeDir: string): UpdateFailure {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown updater error";
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() || "Unknown updater error";
  const network = NETWORK_ERROR_RE.exec(raw);
  const message = network
    ? `Could not reach the update server (${network[0]}). Check your connection and try again.`
    : redactUpdateText(firstLine, homeDir);
  const code = updateErrorCode(error);
  return {
    message: message.length > ERROR_MESSAGE_MAX_CHARS ? `${message.slice(0, ERROR_MESSAGE_MAX_CHARS)}…` : message,
    retryable: code === null || !NON_RETRYABLE_CODES.has(code)
  };
}
