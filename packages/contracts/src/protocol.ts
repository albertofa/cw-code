import type { TopicPatch } from "./topics.js";

export type ClientKind = "desktop-ui" | "desktop-shell" | "web" | "mcp";

export interface RpcError {
  message: string;
  code?: string;
}

export type ClientMessage =
  | { t: "hello"; token: string; protocol: number; client: ClientKind }
  | { t: "call"; id?: number; method: string; params?: unknown };

export type ServerMessage =
  | { t: "welcome"; protocol: number; serverVersion: string; clientId: string }
  | { t: "result"; id: number; ok: true; value: unknown }
  | { t: "result"; id: number; ok: false; error: RpcError }
  | { t: "event"; channel: string; payload: unknown }
  | ({ t: "patch" } & TopicPatch);

export interface ServerEndpoint {
  url: string;
  token: string;
}

export interface ServerReady {
  url: string;
  port: number;
  pid: number;
  protocol: number;
  version: string;
  launcherId?: string | null;
}

export interface ServerInfo {
  app: "cw-code";
  version: string;
  protocol: number;
}

export interface ServerHost {
  platform: "win32" | "linux" | "darwin";
  hostname: string;
  homeDir: string;
  webUi: boolean;
  bindHost?: string;
}

export interface TopicsParams {
  topics: string[];
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  connected: boolean;
  current: boolean;
}

export interface DeviceCreateResult {
  device: DeviceInfo;
  token: string;
}
