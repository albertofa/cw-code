import type { ITheme } from "@xterm/xterm";
import type { ResolvedTheme } from "../theme.js";

const DARK: ITheme = {
  background: "#1e1f22",
  foreground: "#bcbec4",
  cursor: "#dfe1e5",
  cursorAccent: "#1e1f22",
  selectionBackground: "#214184",
  black: "#1e1f22",
  red: "#e06c60",
  green: "#59a659",
  yellow: "#e8b44f",
  blue: "#548af7",
  magenta: "#9c7bad",
  cyan: "#56b6c2",
  white: "#bcbec4",
  brightBlack: "#85888e",
  brightRed: "#ff8a7e",
  brightGreen: "#7fc97f",
  brightYellow: "#f5c86e",
  brightBlue: "#7aa5f8",
  brightMagenta: "#b78fd1",
  brightCyan: "#6fc3d8",
  brightWhite: "#f2f3f5"
};

const LIGHT: ITheme = {
  background: "#faf9f5",
  foreground: "#141413",
  cursor: "#141413",
  cursorAccent: "#faf9f5",
  selectionBackground: "#f0d3c6",
  black: "#141413",
  red: "#b42318",
  green: "#2f7d32",
  yellow: "#946200",
  blue: "#1f5fbf",
  magenta: "#8250b3",
  cyan: "#0e7490",
  white: "#5e5d59",
  brightBlack: "#87867f",
  brightRed: "#d1382b",
  brightGreen: "#3f9a44",
  brightYellow: "#b7791f",
  brightBlue: "#2f76e0",
  brightMagenta: "#9b6bd0",
  brightCyan: "#1b8fa6",
  brightWhite: "#3d3d3a"
};

export function terminalTheme(theme: ResolvedTheme): ITheme {
  return { ...(theme === "light" ? LIGHT : DARK) };
}
