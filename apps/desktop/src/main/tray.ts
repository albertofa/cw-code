import { Menu, Tray } from "electron";

export interface ServerTrayActions {
  iconPath: string;
  open(): void;
  stopAndQuit(): void;
}

export function trayTooltip(attentionCount: number | null): string {
  const base = "cw-code: server running";
  return attentionCount && attentionCount > 0 ? `${base} · ${attentionCount} need you` : base;
}

export class ServerTray {
  private readonly tray: Tray;

  constructor(actions: ServerTrayActions, attentionCount: number | null) {
    this.tray = new Tray(actions.iconPath);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open cw-code", click: () => actions.open() },
        { type: "separator" },
        { label: "Stop server and quit", click: () => actions.stopAndQuit() }
      ])
    );
    if (process.platform === "win32") this.tray.on("click", () => actions.open());
    this.setAttention(attentionCount);
  }

  setAttention(count: number | null): void {
    this.tray.setToolTip(trayTooltip(count));
  }

  destroy(): void {
    this.tray.destroy();
  }
}
