import { tmpdir } from "node:os";
import { join } from "node:path";

export const app = {
  getPath: (name: string): string => {
    if (name === "userData") return join(tmpdir(), "cw-code-test");
    return tmpdir();
  }
};
export const BrowserWindow = class {};
export const ipcMain = { handle: () => {}, on: () => {} };
