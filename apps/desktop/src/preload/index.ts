import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopApi, RemoteProfileInput, ShutdownRequestedEvent, UpdateChannel, UpdateInstallRequest, UpdateState } from "@cw-code/contracts";

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: DesktopApi = {
  isDev: Boolean(process.env["ELECTRON_RENDERER_URL"]),
  connection: () => ipcRenderer.invoke("desktop.connection"),
  connections: {
    list: () => ipcRenderer.invoke("desktop.connections.list"),
    save: (input: RemoteProfileInput) => ipcRenderer.invoke("desktop.connections.save", input),
    remove: (id: string) => ipcRenderer.invoke("desktop.connections.remove", { id }),
    test: (input) => ipcRenderer.invoke("desktop.connections.test", input),
    activate: (id: string) => ipcRenderer.send("desktop.connections.activate", { id })
  },
  minimizeWindow: () => ipcRenderer.send("win.minimize"),
  toggleMaximizeWindow: () => ipcRenderer.send("win.toggle-maximize"),
  closeWindow: () => ipcRenderer.send("win.close"),
  isWindowMaximized: () => ipcRenderer.invoke("win.is-maximized"),
  onWindowMaximized: (cb) => subscribe<boolean>("win.maximized", cb),
  zoomIn: () => ipcRenderer.send("win.zoom-in"),
  zoomOut: () => ipcRenderer.send("win.zoom-out"),
  zoomReset: () => ipcRenderer.send("win.zoom-reset"),
  pickDirectory: () => ipcRenderer.invoke("projects.pick"),
  openPath: (path: string) => ipcRenderer.invoke("shell.openPath", { path }),
  openExternal: (url: string) => ipcRenderer.invoke("shell.openExternal", { url }),
  openHtml: (name: string, html: string) => ipcRenderer.invoke("shell.openHtml", { name, html }),
  showItemInFolder: (path: string) => ipcRenderer.invoke("shell.showItemInFolder", { path }),
  updates: {
    getState: () => ipcRenderer.invoke("updates.state"),
    check: () => ipcRenderer.invoke("updates.check"),
    download: () => ipcRenderer.invoke("updates.download"),
    setChannel: (channel: UpdateChannel) => ipcRenderer.invoke("updates.setChannel", { channel }),
    install: (request: UpdateInstallRequest) => ipcRenderer.invoke("updates.install", request),
    onChanged: (cb) => subscribe<UpdateState>("updates.changed", cb)
  },
  shutdown: {
    onRequested: (cb) => subscribe<ShutdownRequestedEvent>("shutdown.requested", cb),
    acknowledge: () => ipcRenderer.send("shutdown.ack"),
    quit: () => ipcRenderer.send("app.quit"),
    stopServerAndQuit: () => ipcRenderer.send("app.stop-server-and-quit")
  }
};

contextBridge.exposeInMainWorld("cwDesktop", api);
