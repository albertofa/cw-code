import type { ServerEndpoint } from "./protocol.js";
import type { ShutdownRequestedEvent } from "./shutdown.js";
import type { UpdateActionResult, UpdateChannel, UpdateInstallRequest, UpdateState } from "./updates.js";

export interface DesktopApi {
  isDev: boolean;
  serverEndpoint(): Promise<ServerEndpoint>;
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
  updates: {
    getState(): Promise<UpdateState>;
    check(): Promise<UpdateActionResult>;
    download(): Promise<UpdateActionResult>;
    setChannel(channel: UpdateChannel): Promise<UpdateActionResult>;
    install(request: UpdateInstallRequest): Promise<UpdateActionResult>;
    onChanged(cb: (state: UpdateState) => void): () => void;
  };
  shutdown: {
    onRequested(cb: (event: ShutdownRequestedEvent) => void): () => void;
    acknowledge(): void;
    quit(): void;
  };
}
