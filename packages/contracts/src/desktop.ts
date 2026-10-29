import type { ServerEndpoint, ServerInfo } from "./protocol.js";
import type { ShutdownRequestedEvent } from "./shutdown.js";
import type { UpdateActionResult, UpdateChannel, UpdateInstallRequest, UpdateState } from "./updates.js";

export type ConnectionProfile = { id: "local"; kind: "local"; name: string } | { id: string; kind: "remote"; name: string; url: string };

export interface DesktopConnection {
  profile: ConnectionProfile;
  endpoint: ServerEndpoint;
}

export interface RemoteProfileInput {
  id?: string;
  name: string;
  url: string;
  token?: string;
}

export type ConnectionTestResult =
  | { ok: true; info: ServerInfo }
  | { ok: false; code: "invalid-url" | "unreachable" | "unauthorized" | "protocol-mismatch"; message: string; info?: ServerInfo };

export type TokenStorage = "os" | "basic" | "plain";

export interface ConnectionList {
  activeId: string;
  profiles: ConnectionProfile[];
  tokenStorage: TokenStorage;
  warning?: string;
}

export interface DesktopConnections {
  list(): Promise<ConnectionList>;
  save(input: RemoteProfileInput): Promise<ConnectionProfile>;
  remove(id: string): Promise<void>;
  test(input: { url: string; token?: string; id?: string }): Promise<ConnectionTestResult>;
  activate(id: string): void;
}

export interface DesktopUpdates {
  getState(): Promise<UpdateState>;
  check(): Promise<UpdateActionResult>;
  download(): Promise<UpdateActionResult>;
  setChannel(channel: UpdateChannel): Promise<UpdateActionResult>;
  setAutoDownload(enabled: boolean): Promise<UpdateActionResult>;
  install(request: UpdateInstallRequest): Promise<UpdateActionResult>;
  onChanged(cb: (state: UpdateState) => void): () => void;
}

export interface DesktopApi {
  isDev: boolean;
  connection(): Promise<DesktopConnection>;
  connections: DesktopConnections;
  minimizeWindow(): void;
  toggleMaximizeWindow(): void;
  closeWindow(): void;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximized(cb: (maximized: boolean) => void): () => void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  pickDirectory(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openHtml(name: string, html: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  updates: DesktopUpdates;
  shutdown: {
    onRequested(cb: (event: ShutdownRequestedEvent) => void): () => void;
    acknowledge(): void;
    quit(): void;
    stopServerAndQuit(): void;
    dismissed(): void;
  };
}
