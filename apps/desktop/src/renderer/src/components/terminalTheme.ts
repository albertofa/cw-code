import { useEffect, useState } from "react";
import type { ITheme } from "@xterm/xterm";
import { THEME_PALETTES } from "../../../shared/themes.js";
import type { ThemeBase } from "../cw.js";

export interface TerminalColors {
  background: string;
  foreground: string;
  selection: string;
}

const DARK: ITheme = {
  cursor: "#dfe1e5",
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
  cursor: "#1a1d26",
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

export function terminalTheme(base: ThemeBase, colors: TerminalColors): ITheme {
  return {
    ...(base === "light" ? LIGHT : DARK),
    background: colors.background,
    foreground: colors.foreground,
    cursorAccent: colors.background,
    selectionBackground: colors.selection
  };
}

export interface DocumentTerminalColors extends TerminalColors {
  base: ThemeBase;
}

function readTerminalColors(): DocumentTerminalColors {
  const root = document.documentElement;
  const base: ThemeBase = root.dataset["theme"] === "light" ? "light" : "dark";
  const palette = THEME_PALETTES[base];
  const style = getComputedStyle(root);
  const token = (name: string): string => style.getPropertyValue(`--${name}`).trim() || (palette[name] ?? "");
  return {
    base,
    background: token("terminal-bg"),
    foreground: token("terminal-fg"),
    selection: token("terminal-selection")
  };
}

function sameColors(a: DocumentTerminalColors, b: DocumentTerminalColors): boolean {
  return a.base === b.base && a.background === b.background && a.foreground === b.foreground && a.selection === b.selection;
}

export function useTerminalColors(): DocumentTerminalColors {
  const [colors, setColors] = useState(readTerminalColors);
  useEffect(() => {
    const refresh = () => {
      const next = readTerminalColors();
      setColors((prev) => (sameColors(prev, next) ? prev : next));
    };
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    refresh();
    return () => observer.disconnect();
  }, []);
  return colors;
}
