import type { ServerInfo, ServerReady } from "@cw-code/contracts";

export const PROTOCOL_VERSION = 3;
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_PROTOCOL_MISMATCH = 4426;
export const CLOSE_HELLO_TIMEOUT = 4408;
export const CLOSE_SERVER_STOPPING = 4503;
export const CLOSE_CLIENT_TOO_SLOW = 1013;

export const SERVER_TOKEN_FILE = "server-token";
export const SERVER_ENDPOINT_FILE = "server.json";
export const SERVER_READY_PREFIX = "CW_SERVER_READY ";
export const SERVER_RUNNING_PREFIX = "CW_SERVER_RUNNING ";
export const WS_PATH = "/ws";
export const INFO_PATH = "/api/info";
export const STOP_PATH = "/api/stop";
export const MCP_PATH = "/mcp";
export const EXIT_ALREADY_RUNNING = 3;
export const PASTE_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

const MIB = 1024 * 1024;

export function assertPasteImageSize(bytes: number): void {
  if (bytes <= PASTE_IMAGE_MAX_BYTES) return;
  throw new Error(`image is ${(bytes / MIB).toFixed(1)} MB; pasted images are limited to ${PASTE_IMAGE_MAX_BYTES / MIB} MB`);
}

export function isServerReady(value: unknown): value is ServerReady {
  if (typeof value !== "object" || value === null) return false;
  const ready = value as Record<string, unknown>;
  return (
    typeof ready.url === "string" &&
    typeof ready.port === "number" &&
    typeof ready.pid === "number" &&
    typeof ready.protocol === "number" &&
    typeof ready.version === "string" &&
    (ready.launcherId === undefined || ready.launcherId === null || typeof ready.launcherId === "string")
  );
}

export function isServerInfo(value: unknown): value is ServerInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  return info.app === "cw-code" && typeof info.version === "string" && typeof info.protocol === "number";
}
