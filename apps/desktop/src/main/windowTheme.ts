import type { ThemeMode } from "@cw-code/contracts";

export const DARK_WINDOW_BACKGROUND = "#141518";
export const LIGHT_WINDOW_BACKGROUND = "#faf9f5";

/** The colour the window shows before the renderer paints, so a light theme does not open as a dark flash. */
export function windowBackgroundColor(mode: ThemeMode, systemUsesDarkColors: boolean): string {
  const dark = mode === "system" ? systemUsesDarkColors : mode === "dark";
  return dark ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND;
}
